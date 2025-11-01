const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const csv = require('csv-parser');
const { Readable } = require('stream');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { requireAdmin } = require('./middleware/appAccess');
const applicationsRouter = require('./routes/applications');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed!'), false);
    }
  }
});

async function initDatabase() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS companies (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, cui VARCHAR(50), address TEXT, phone VARCHAR(50), email VARCHAR(255), is_active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS csv_files (id SERIAL PRIMARY KEY, filename VARCHAR(255) NOT NULL, category VARCHAR(50) DEFAULT 'general', uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS csv_data (id SERIAL PRIMARY KEY, file_id INTEGER REFERENCES csv_files(id) ON DELETE CASCADE, row_data JSONB NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100), email VARCHAR(255), company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, role VARCHAR(20) DEFAULT 'user', is_active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_categories (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, category VARCHAR(50) NOT NULL, can_read BOOLEAN DEFAULT true, can_write BOOLEAN DEFAULT false, can_delete BOOLEAN DEFAULT false, UNIQUE(user_id, category))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS licenses (id SERIAL PRIMARY KEY, license_key VARCHAR(50) UNIQUE NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, company_name VARCHAR(100), app_id VARCHAR(100) DEFAULT 'timber-inventory', max_devices INTEGER DEFAULT 3, grace_period_days INTEGER DEFAULT 7, expires_at TIMESTAMP, is_active BOOLEAN DEFAULT true, notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS license_devices (id SERIAL PRIMARY KEY, license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE, device_id VARCHAR(255) NOT NULL, device_name VARCHAR(100), device_model VARCHAR(100), activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(license_id, device_id))`);
    
    try { await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS grace_period_days INTEGER DEFAULT 7`); } catch (err) {}
    try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)`); } catch (err) {}
    try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`); } catch (err) {}
    try { await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`); } catch (err) {}
    try { await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS app_id VARCHAR(100) DEFAULT 'timber-inventory'`); console.log('✅ Added app_id column'); } catch (err) {}

    console.log('✅ Database tables initialized with app_id support');

    // Tabele pentru inventar din teren (field inventory)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS field_inventory_sessions (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        apv_number VARCHAR(100) NOT NULL,
        ua_number VARCHAR(100),
        inventory_date DATE,
        total_trees INTEGER DEFAULT 0,
        total_volume NUMERIC(10,2) DEFAULT 0,
        sync_status VARCHAR(20) DEFAULT 'synced',
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS field_trees (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES field_inventory_sessions(id) ON DELETE CASCADE,
        device_id VARCHAR(255) NOT NULL,
        tree_number INTEGER,
        species VARCHAR(100),
        diameter NUMERIC(5,1),
        height NUMERIC(5,2),
        volume NUMERIC(8,4),
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        recorded_at TIMESTAMP,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS field_sync_log (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        sync_type VARCHAR(50),
        trees_count INTEGER,
        sessions_count INTEGER,
        status VARCHAR(20),
        error_message TEXT,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Index-uri pentru performanță
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_field_sessions_device ON field_inventory_sessions(device_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_field_trees_session ON field_trees(session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_field_trees_device ON field_trees(device_id)`);

    // Migrare: adaugă company_id pentru multi-tenant security (SAFE - doar dacă coloana nu există)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='field_inventory_sessions' AND column_name='company_id'
        ) THEN
          ALTER TABLE field_inventory_sessions
          ADD COLUMN company_id INTEGER REFERENCES companies(id);

          CREATE INDEX idx_field_sessions_company ON field_inventory_sessions(company_id);
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='field_trees' AND column_name='company_id'
        ) THEN
          ALTER TABLE field_trees
          ADD COLUMN company_id INTEGER REFERENCES companies(id);

          CREATE INDEX idx_field_trees_company ON field_trees(company_id);
        END IF;
      END $$;
    `);

    console.log('✅ Field inventory tables initialized with company isolation');

    try {
      const adminCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
      if (adminCheck.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        await pool.query('INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)', ['admin', hashedPassword, 'Administrator', 'admin']);
        console.log('✅ Default admin created');
      }
    } catch (adminErr) {}
    console.log('✅ Database initialization complete');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT id, username, role, is_active FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0 || !result.rows[0].is_active) return res.status(403).json({ error: 'Invalid or inactive user' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

const checkCategoryAccess = (permission) => {
  return async (req, res, next) => {
    const category = req.body.category || req.query.category || req.params.category;
    if (req.user.role === 'admin') return next();
    if (!category) return res.status(400).json({ error: 'Category required' });
    try {
      const result = await pool.query(`SELECT ${permission} FROM user_categories WHERE user_id = $1 AND category = $2`, [req.user.id, category]);
      if (result.rows.length === 0 || !result.rows[0][permission]) return res.status(403).json({ error: 'Permission denied' });
      next();
    } catch (err) {
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

// ============================================================================
// MULTI-APP DASHBOARD ROUTES
// ============================================================================
// Make services available to routes through app.locals
app.locals.pool = pool;
app.locals.authenticateToken = authenticateToken;
app.locals.requireAdmin = requireAdmin;

// Register application routes (applies authenticateToken middleware internally)
app.use('/api/applications', authenticateToken, applicationsRouter);

app.get('/', (req, res) => {
  res.json({message: 'Timber API with Multi-App Support', version: '7.1.0', status: 'running', features: ['companies', 'users', 'licenses', 'multi_app', 'offline_mode', 'field_inventory_sync']});
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 AND is_active = true', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({token: token, user: {id: user.id, username: user.username, full_name: user.full_name, email: user.email, role: user.role}});
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT u.id, u.username, u.full_name, u.email, u.role, u.company_id, c.name as company_name, json_agg(json_build_object('category', uc.category, 'can_read', uc.can_read, 'can_write', uc.can_write, 'can_delete', uc.can_delete)) FILTER (WHERE uc.category IS NOT NULL) as categories FROM users u LEFT JOIN companies c ON u.company_id = c.id LEFT JOIN user_categories uc ON u.id = uc.user_id WHERE u.id = $1 GROUP BY u.id, c.name`, [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

app.get('/api/admin/companies', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const result = await pool.query(`SELECT c.*, COUNT(DISTINCT u.id) as user_count, COUNT(DISTINCT l.id) as license_count FROM companies c LEFT JOIN users u ON c.id = u.company_id LEFT JOIN licenses l ON c.id = l.company_id GROUP BY c.id ORDER BY c.created_at DESC`);
    res.json({ companies: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.post('/api/admin/companies', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { name, cui, address, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Company name required' });
  try {
    const result = await pool.query('INSERT INTO companies (name, cui, address, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING *', [name, cui || null, address || null, phone || null, email || null]);
    res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create company' });
  }
});

app.put('/api/admin/companies/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { id } = req.params;
  const { name, cui, address, phone, email, is_active } = req.body;
  try {
    const result = await pool.query('UPDATE companies SET name = $1, cui = $2, address = $3, phone = $4, email = $5, is_active = $6 WHERE id = $7 RETURNING *', [name, cui || null, address || null, phone || null, email || null, is_active, id]);
    res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update company' });
  }
});

app.delete('/api/admin/companies/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    await pool.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

app.get('/api/admin/companies/:id/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const result = await pool.query('SELECT id, username, full_name, email, role, is_active, created_at FROM users WHERE company_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/companies/:id/licenses', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const result = await pool.query(`SELECT l.*, COUNT(ld.id) as active_devices FROM licenses l LEFT JOIN license_devices ld ON l.id = ld.license_id WHERE l.company_id = $1 GROUP BY l.id ORDER BY l.created_at DESC`, [req.params.id]);
    res.json({ licenses: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch licenses' });
  }
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const result = await pool.query(`SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active, u.created_at, u.company_id, c.name as company_name, json_agg(json_build_object('category', uc.category, 'can_read', uc.can_read, 'can_write', uc.can_write, 'can_delete', uc.can_delete)) FILTER (WHERE uc.category IS NOT NULL) as categories FROM users u LEFT JOIN companies c ON u.company_id = c.id LEFT JOIN user_categories uc ON u.id = uc.user_id GROUP BY u.id, c.name ORDER BY u.created_at DESC`);
    res.json({ users: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { username, password, full_name, email, company_id, role, categories } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await client.query('INSERT INTO users (username, password_hash, full_name, email, company_id, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [username, hashedPassword, full_name || username, email || null, company_id || null, role || 'user']);
    const userId = userResult.rows[0].id;
    if (categories && categories.length > 0) {
      for (const cat of categories) {
        await client.query('INSERT INTO user_categories (user_id, category, can_read, can_write, can_delete) VALUES ($1, $2, $3, $4, $5)', [userId, cat.category, cat.can_read !== false, cat.can_write || false, cat.can_delete || false]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, userId: userId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.constraint === 'users_username_key') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create user' });
    }
  } finally {
    client.release();
  }
});

app.put('/api/admin/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const userId = req.params.id;
  const { full_name, email, company_id, role, is_active, categories, password } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updateQuery = 'UPDATE users SET ';
    const updateParams = [];
    let paramCount = 1;
    if (full_name !== undefined) { updateQuery += `full_name = $${paramCount}, `; updateParams.push(full_name); paramCount++; }
    if (email !== undefined) { updateQuery += `email = $${paramCount}, `; updateParams.push(email); paramCount++; }
    if (company_id !== undefined) { updateQuery += `company_id = $${paramCount}, `; updateParams.push(company_id); paramCount++; }
    if (role !== undefined) { updateQuery += `role = $${paramCount}, `; updateParams.push(role); paramCount++; }
    if (is_active !== undefined) { updateQuery += `is_active = $${paramCount}, `; updateParams.push(is_active); paramCount++; }
    if (password) { const hashedPassword = await bcrypt.hash(password, 10); updateQuery += `password_hash = $${paramCount}, `; updateParams.push(hashedPassword); paramCount++; }
    updateQuery = updateQuery.slice(0, -2);
    updateQuery += ` WHERE id = $${paramCount}`;
    updateParams.push(userId);
    await client.query(updateQuery, updateParams);
    if (categories !== undefined) {
      await client.query('DELETE FROM user_categories WHERE user_id = $1', [userId]);
      for (const cat of categories) {
        await client.query('INSERT INTO user_categories (user_id, category, can_read, can_write, can_delete) VALUES ($1, $2, $3, $4, $5)', [userId, cat.category, cat.can_read !== false, cat.can_write || false, cat.can_delete || false]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to update user' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const userId = req.params.id;
  if (parseInt(userId) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// PUBLIC endpoint - no authentication required (offline-first app)
app.get('/api/categories', async (req, res) => {
  try {
    // Return ALL categories (no filtering for offline-first app)
    const query = 'SELECT DISTINCT category FROM csv_files ORDER BY category';
    const result = await pool.query(query);
    const categories = result.rows.map(row => row.category);
    res.json({ categories: categories, count: categories.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.post('/api/upload', authenticateToken, checkCategoryAccess('can_write'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const client = await pool.connect();
  try {
    const category = req.body.category || 'general';
    const filename = req.file.originalname;
    const duplicateCheck = await client.query('SELECT id FROM csv_files WHERE filename = $1 AND category = $2', [filename, category]);
    if (duplicateCheck.rows.length > 0) {
      client.release();
      return res.status(409).json({ error: 'Duplicate file' });
    }
    await client.query('BEGIN');
    const fileResult = await client.query('INSERT INTO csv_files (filename, category) VALUES ($1, $2) RETURNING id', [filename, category]);
    const fileId = fileResult.rows[0].id;
    const rows = [];
    const stream = Readable.from(req.file.buffer.toString());
    await new Promise((resolve, reject) => {
      stream.pipe(csv()).on('data', (row) => rows.push(row)).on('end', resolve).on('error', reject);
    });
    for (const row of rows) {
      await client.query('INSERT INTO csv_data (file_id, row_data) VALUES ($1, $2)', [fileId, JSON.stringify(row)]);
    }
    await client.query('COMMIT');
    res.json({success: true, filename: filename, category: category, rows: rows.length});
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to upload file' });
  } finally {
    client.release();
  }
});

// PUBLIC endpoint - no authentication required (offline-first app)
app.get('/api/datasets', async (req, res) => {
  try {
    const category = req.query.category;

    // Return ALL datasets (no user-based filtering for offline-first app)
    let query = `
      SELECT
        f.id,
        f.filename,
        f.category,
        f.uploaded_at,
        COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
    `;

    const params = [];
    if (category) {
      query += ' WHERE f.category = $1';
      params.push(category);
    }

    query += ' GROUP BY f.id ORDER BY f.uploaded_at DESC';
    const result = await pool.query(query, params);
    res.json({ datasets: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch datasets' });
  }
});

// PUBLIC endpoint - no authentication required (offline-first app)
app.get('/api/search', async (req, res) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) return res.status(400).json({ error: 'Search term required' });

    // Return ALL search results (no user-based filtering)
    const query = `
      SELECT f.id, f.filename, f.category, f.uploaded_at, COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
      WHERE (f.filename ILIKE $1 OR f.category ILIKE $1)
      GROUP BY f.id
      ORDER BY f.uploaded_at DESC
    `;
    const result = await pool.query(query, [`%${searchTerm}%`]);
    res.json({ results: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// PUBLIC endpoint - no authentication required (offline-first app)
app.get('/api/data/:filename', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.row_data FROM csv_data d
       JOIN csv_files f ON d.file_id = f.id
       WHERE f.filename = $1
       ORDER BY d.id`,
      [req.params.filename]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Return ALL data (no permission checks for offline-first app)
    const data = result.rows.map(row => row.row_data);
    res.json({ filename: req.params.filename, count: data.length, data: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.delete('/api/data/:id', authenticateToken, async (req, res) => {
  try {
    const fileResult = await pool.query('SELECT category FROM csv_files WHERE id = $1', [req.params.id]);
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    const category = fileResult.rows[0].category;
    if (req.user.role !== 'admin') {
      const permCheck = await pool.query('SELECT can_delete FROM user_categories WHERE user_id = $1 AND category = $2', [req.user.id, category]);
      if (permCheck.rows.length === 0 || !permCheck.rows[0].can_delete) return res.status(403).json({ error: 'Permission denied' });
    }
    await pool.query('DELETE FROM csv_files WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete dataset' });
  }
});

function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'TBR-';
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (i < 3) key += '-';
  }
  return key;
}

app.get('/api/admin/licenses', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const result = await pool.query(`SELECT l.*, u.username, u.full_name, u.email, c.name as company_name, COUNT(ld.id) as active_devices FROM licenses l LEFT JOIN users u ON l.user_id = u.id LEFT JOIN companies c ON l.company_id = c.id LEFT JOIN license_devices ld ON l.id = ld.license_id GROUP BY l.id, u.username, u.full_name, u.email, c.name ORDER BY l.created_at DESC`);
    res.json({ licenses: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch licenses' });
  }
});

app.post('/api/admin/licenses', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { user_id, company_id, company_name, app_id, max_devices, grace_period_days, expires_at, notes } = req.body;
  try {
    const licenseKey = generateLicenseKey();
    const result = await pool.query(`INSERT INTO licenses (license_key, user_id, company_id, company_name, app_id, max_devices, grace_period_days, expires_at, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [licenseKey, user_id || null, company_id || null, company_name || null, app_id || 'timber-inventory', max_devices || 3, grace_period_days || 7, expires_at || null, notes || null]);
    res.json({ success: true, license: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create license' });
  }
});

app.put('/api/admin/licenses/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { id } = req.params;
  const { user_id, company_id, company_name, app_id, max_devices, grace_period_days, expires_at, is_active, notes } = req.body;
  try {
    const result = await pool.query(`UPDATE licenses SET user_id = $1, company_id = $2, company_name = $3, app_id = $4, max_devices = $5, grace_period_days = $6, expires_at = $7, is_active = $8, notes = $9 WHERE id = $10 RETURNING *`, [user_id || null, company_id || null, company_name || null, app_id || 'timber-inventory', max_devices, grace_period_days || 7, expires_at || null, is_active, notes || null, id]);
    res.json({ success: true, license: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update license' });
  }
});

app.delete('/api/admin/licenses/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    await pool.query('DELETE FROM licenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete license' });
  }
});

app.get('/api/admin/licenses/:id/devices', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const result = await pool.query('SELECT * FROM license_devices WHERE license_id = $1 ORDER BY activated_at DESC', [req.params.id]);
    res.json({ devices: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

app.delete('/api/admin/licenses/:licenseId/devices/:deviceId', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    await pool.query('DELETE FROM license_devices WHERE license_id = $1 AND id = $2', [req.params.licenseId, req.params.deviceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

app.post('/api/licenses/activate', async (req, res) => {
  const { license_key, device_id, device_name, device_model, app_id } = req.body;
  if (!license_key || !device_id) return res.status(400).json({ error: 'License key and device ID required' });
  try {
    const licenseResult = await pool.query('SELECT l.*, u.username, u.full_name, u.email FROM licenses l LEFT JOIN users u ON l.user_id = u.id WHERE l.license_key = $1', [license_key]);
    if (licenseResult.rows.length === 0) return res.status(404).json({ error: 'Invalid license key' });
    const license = licenseResult.rows[0];
    
    if (app_id && license.app_id && license.app_id !== '*' && license.app_id !== app_id) {
      return res.status(403).json({ error: 'License not valid for this application', valid_for: license.app_id, requested_for: app_id });
    }
    
    if (!license.is_active) return res.status(403).json({ error: 'License is inactive' });
    if (license.expires_at && new Date(license.expires_at) < new Date()) return res.status(403).json({ error: 'License has expired' });
    const existingDevice = await pool.query('SELECT * FROM license_devices WHERE license_id = $1 AND device_id = $2', [license.id, device_id]);
    if (existingDevice.rows.length > 0) {
      await pool.query('UPDATE license_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1', [existingDevice.rows[0].id]);
      return res.json({ success: true, message: 'Device already activated', license: {license_key: license.license_key, company_name: license.company_name, username: license.username, full_name: license.full_name, email: license.email, app_id: license.app_id, max_devices: license.max_devices, grace_period_days: license.grace_period_days, expires_at: license.expires_at}, device: existingDevice.rows[0]});
    }
    const deviceCount = await pool.query('SELECT COUNT(*) FROM license_devices WHERE license_id = $1', [license.id]);
    if (parseInt(deviceCount.rows[0].count) >= license.max_devices) return res.status(403).json({ error: 'Device limit reached', max_devices: license.max_devices });
    const deviceResult = await pool.query(`INSERT INTO license_devices (license_id, device_id, device_name, device_model) VALUES ($1, $2, $3, $4) RETURNING *`, [license.id, device_id, device_name || 'Unknown', device_model || 'Unknown']);
    res.json({ success: true, message: 'Device activated successfully', license: {license_key: license.license_key, company_name: license.company_name, username: license.username, full_name: license.full_name, email: license.email, app_id: license.app_id, max_devices: license.max_devices, grace_period_days: license.grace_period_days, expires_at: license.expires_at}, device: deviceResult.rows[0]});
  } catch (err) {
    res.status(500).json({ error: 'Activation failed' });
  }
});

app.post('/api/licenses/verify', async (req, res) => {
  const { license_key, device_id, app_id } = req.body;
  if (!license_key || !device_id) return res.status(400).json({ error: 'License key and device ID required' });
  try {
    const result = await pool.query(`SELECT l.*, u.username, u.full_name, u.email, ld.id as device_record_id, ld.last_seen FROM licenses l LEFT JOIN users u ON l.user_id = u.id LEFT JOIN license_devices ld ON l.id = ld.license_id AND ld.device_id = $2 WHERE l.license_key = $1`, [license_key, device_id]);
    if (result.rows.length === 0) return res.status(404).json({ valid: false, error: 'Invalid license key', should_retry: false });
    const license = result.rows[0];
    
    if (app_id && license.app_id && license.app_id !== '*' && license.app_id !== app_id) {
      return res.json({ valid: false, error: 'License not valid for this application', valid_for: license.app_id, should_retry: false });
    }
    
    if (!license.is_active) return res.json({ valid: false, error: 'License is inactive', should_retry: false });
    if (license.expires_at && new Date(license.expires_at) < new Date()) return res.json({ valid: false, error: 'License has expired', expired_at: license.expires_at, should_retry: false });
    if (!license.device_record_id) return res.json({ valid: false, error: 'Device not activated', should_retry: false });
    await pool.query('UPDATE license_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1', [license.device_record_id]);
    res.json({ valid: true, verified_at: new Date().toISOString(), license: {company_name: license.company_name, username: license.username, full_name: license.full_name, email: license.email, app_id: license.app_id, expires_at: license.expires_at, max_devices: license.max_devices, grace_period_days: license.grace_period_days, last_verified: new Date().toISOString()}});
  } catch (err) {
    res.status(500).json({ valid: false, error: 'Verification failed', should_retry: true });
  }
});

app.get('/api/licenses/info/:licenseKey', async (req, res) => {
  try {
    const result = await pool.query('SELECT license_key, company_name, app_id, max_devices, grace_period_days, expires_at, is_active FROM licenses WHERE license_key = $1', [req.params.licenseKey]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'License not found' });
    res.json({ license: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch license info' });
  }
});

app.post('/api/licenses/deactivate', async (req, res) => {
  const { license_key, device_id } = req.body;
  if (!license_key || !device_id) return res.status(400).json({ error: 'License key and device ID required' });
  try {
    const licenseResult = await pool.query('SELECT id FROM licenses WHERE license_key = $1', [license_key]);
    if (licenseResult.rows.length === 0) return res.status(404).json({ error: 'Invalid license key' });
    await pool.query('DELETE FROM license_devices WHERE license_id = $1 AND device_id = $2', [licenseResult.rows[0].id, device_id]);
    res.json({ success: true, message: 'Device deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Deactivation failed' });
  }
});

// Certificate Pinning - Public endpoint (no auth required)
app.get('/api/certificates/fingerprints', async (req, res) => {
  try {
    // Hardcoded certificate fingerprints (Railway SSL cert)
    // Update this array when Railway renews the certificate
    const certificates = [
      {
        fingerprint: 'sha256/TuStss/55HxEtKcvwsE0WEwiXKBP+sKO3gJ3Y2f2HPE=',
        description: 'Railway production certificate 2025',
        validUntil: '2025-04-30T23:59:59Z' // Estimate - Railway cert expires ~90 days
      }
      // Add new/backup certificates here during renewal
      // Example:
      // {
      //   fingerprint: 'sha256/NEW_FINGERPRINT_HERE=',
      //   description: 'Railway renewed certificate',
      //   validUntil: '2025-07-30T23:59:59Z'
      // }
    ];

    res.json({
      success: true,
      certificates: certificates
    });
  } catch (err) {
    console.error('Error fetching certificate fingerprints:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================
// SYNC ENDPOINTS FOR MOBILE APP
// ============================================

// PUBLIC endpoint - no authentication required (offline-first app)
app.get('/api/sync', async (req, res) => {
  try {
    console.log(`📱 Sync request (public endpoint - no auth)`);

    // Return ALL categories (no user filtering)
    const categoriesQuery = 'SELECT DISTINCT category FROM csv_files WHERE category IS NOT NULL ORDER BY category';
    const categoriesResult = await pool.query(categoriesQuery);
    const categories = categoriesResult.rows.map(row => row.category);

    // Return ALL datasets (no user filtering)
    const datasetsQuery = `
      SELECT
        f.id,
        f.filename,
        f.category,
        f.uploaded_at,
        COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
      GROUP BY f.id
      ORDER BY f.uploaded_at DESC
    `;

    const datasetsResult = await pool.query(datasetsQuery);

    const response = {
      success: true,
      categories: categories,
      datasets: datasetsResult.rows,
      synced_at: new Date().toISOString(),
      server_version: '7.1.0'
    };

    console.log(`✅ Sync successful: ${categories.length} categories, ${datasetsResult.rows.length} datasets`);
    res.json(response);

  } catch (err) {
    console.error('❌ Sync error:', err);
    res.status(500).json({
      success: false,
      error: 'Sync failed',
      message: err.message
    });
  }
});

// PUBLIC endpoint - no authentication required (offline-first app)
app.get('/api/datasets/:id/data', async (req, res) => {
  try {
    const datasetId = req.params.id;
    console.log(`📥 Download request for dataset ${datasetId} (public endpoint)`);

    // Check if dataset exists
    const fileCheck = await pool.query(
      'SELECT id, filename, category, app_id FROM csv_files WHERE id = $1',
      [datasetId]
    );

    if (fileCheck.rows.length === 0) {
      console.log(`❌ Dataset ${datasetId} not found`);
      return res.status(404).json({
        success: false,
        error: 'Dataset not found'
      });
    }

    const file = fileCheck.rows[0];

    // Get data (no permission checks for offline-first app)
    const result = await pool.query(
      'SELECT row_data FROM csv_data WHERE file_id = $1 ORDER BY id',
      [datasetId]
    );

    const data = result.rows.map(row => row.row_data);

    console.log(`✅ Downloaded ${data.length} rows from dataset ${datasetId}`);

    res.json({
      success: true,
      dataset_id: parseInt(datasetId),
      filename: file.filename,
      category: file.category,
      app_id: file.app_id,
      record_count: data.length,
      data: data,
      downloaded_at: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ Download error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to download data',
      message: err.message
    });
  }
});

// REMOVED DUPLICATE - /api/categories already exists at line 278 (PUBLIC endpoint)

// ============================================================================
// FIELD INVENTORY ENDPOINTS - Sincronizare date din teren
// ============================================================================

// POST /api/field-inventory/sync
// Sincronizare inventar complet din teren (PUBLIC - fără autentificare JWT)
app.post('/api/field-inventory/sync', async (req, res) => {
  const { device_id, sessions, trees } = req.body;

  // Validare input
  if (!device_id) {
    return res.status(400).json({
      success: false,
      error: 'Device ID is required'
    });
  }

  if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'At least one inventory session is required'
    });
  }

  // SECURITATE: Validare device și obținere company_id din licență
  let company_id = null;
  try {
    const deviceCheck = await pool.query(`
      SELECT l.company_id, l.is_active, l.expires_at, l.grace_period_days,
             c.name as company_name, u.full_name as user_name
      FROM license_devices ld
      JOIN licenses l ON ld.license_id = l.id
      LEFT JOIN companies c ON l.company_id = c.id
      LEFT JOIN users u ON l.user_id = u.id
      WHERE ld.device_id = $1
    `, [device_id]);

    if (deviceCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Device not activated',
        message: 'This device is not registered with any license. Please activate your license in the app first.'
      });
    }

    const licenseInfo = deviceCheck.rows[0];

    // Verificare licență activă
    if (!licenseInfo.is_active) {
      return res.status(403).json({
        success: false,
        error: 'License inactive',
        message: 'Your license is inactive. Please contact support.'
      });
    }

    // Verificare expirare (cu grace period)
    if (licenseInfo.expires_at) {
      const expiryDate = new Date(licenseInfo.expires_at);
      const gracePeriodMs = (licenseInfo.grace_period_days || 0) * 24 * 60 * 60 * 1000;
      const effectiveExpiryDate = new Date(expiryDate.getTime() + gracePeriodMs);

      if (new Date() > effectiveExpiryDate) {
        return res.status(403).json({
          success: false,
          error: 'License expired',
          message: `Your license expired on ${expiryDate.toISOString().split('T')[0]}. Please renew your subscription.`,
          expired_at: licenseInfo.expires_at
        });
      }
    }

    company_id = licenseInfo.company_id;

    // Update last_seen pentru device
    await pool.query(
      'UPDATE license_devices SET last_seen = CURRENT_TIMESTAMP WHERE device_id = $1',
      [device_id]
    );

  } catch (err) {
    console.error('Device validation error:', err);
    return res.status(500).json({
      success: false,
      error: 'Device validation failed',
      details: err.message
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const syncedSessions = [];
    const syncedTrees = [];

    // Inserare sesiuni de inventariere (cu company_id pentru securitate multi-tenant)
    for (const session of sessions) {
      // Verifică dacă sesiunea există deja (prevent duplicates)
      const existingSession = await client.query(
        `SELECT id FROM field_inventory_sessions
         WHERE device_id = $1 AND apv_number = $2 AND inventory_date = $3`,
        [device_id, session.apvNumber, session.inventoryDate]
      );

      let sessionId;

      if (existingSession.rows.length > 0) {
        // Sesiunea există - UPDATE în loc de INSERT
        sessionId = existingSession.rows[0].id;
        await client.query(
          `UPDATE field_inventory_sessions
           SET ua_number = $1, total_trees = $2, total_volume = $3,
               metadata = $4, synced_at = CURRENT_TIMESTAMP
           WHERE id = $5`,
          [
            session.uaNumber || null,
            session.totalTrees || 0,
            session.totalVolume || 0,
            session.metadata ? JSON.stringify(session.metadata) : null,
            sessionId
          ]
        );

        // Șterge arborii vechi pentru a-i înlocui
        await client.query('DELETE FROM field_trees WHERE session_id = $1', [sessionId]);

        console.log(`🔄 Updated existing session ${sessionId} for APV ${session.apvNumber}`);
      } else {
        // Sesiune nouă - INSERT
        const sessionResult = await client.query(
          `INSERT INTO field_inventory_sessions
           (device_id, company_id, apv_number, ua_number, inventory_date, total_trees, total_volume, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            device_id,
          company_id,
          session.apvNumber,
          session.uaNumber || null,
          session.inventoryDate || null,
          session.totalTrees || 0,
          session.totalVolume || 0,
          session.metadata ? JSON.stringify(session.metadata) : null
        ]
      );

        sessionId = sessionResult.rows[0].id;
        console.log(`✅ Created new session ${sessionId} for APV ${session.apvNumber}`);
      }

      syncedSessions.push(sessionId);

      // Inserare arbori pentru această sesiune
      if (trees && Array.isArray(trees)) {
        const sessionTrees = trees.filter(t => t.apvNumber === session.apvNumber);

        for (const tree of sessionTrees) {
          await client.query(
            `INSERT INTO field_trees
             (session_id, device_id, company_id, tree_number, species, diameter, height, volume, latitude, longitude, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              sessionId,
              device_id,
              company_id,
              tree.treeNumber || null,
              tree.species || null,
              tree.diameter || null,
              tree.height || null,
              tree.volume || null,
              tree.latitude || null,
              tree.longitude || null,
              tree.recordedAt ? new Date(tree.recordedAt) : new Date()
            ]
          );
          syncedTrees.push(tree);
        }
      }
    }

    // Log sincronizare
    await client.query(
      `INSERT INTO field_sync_log
       (device_id, sync_type, trees_count, sessions_count, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [device_id, 'full', syncedTrees.length, syncedSessions.length, 'success']
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Inventory data synced successfully',
      synced: {
        sessions: syncedSessions.length,
        trees: syncedTrees.length,
        device_id: device_id,
        synced_at: new Date().toISOString()
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Field inventory sync error:', err);

    // Log eroare
    try {
      await pool.query(
        `INSERT INTO field_sync_log
         (device_id, sync_type, status, error_message)
         VALUES ($1, $2, $3, $4)`,
        [device_id, 'full', 'error', err.message]
      );
    } catch (logErr) {
      console.error('Failed to log sync error:', logErr);
    }

    res.status(500).json({
      success: false,
      error: 'Sync failed',
      details: err.message
    });

  } finally {
    client.release();
  }
});

// GET /api/field-inventory/history/:deviceId
// Obține istoricul sincronizărilor pentru un dispozitiv
app.get('/api/field-inventory/history/:deviceId', async (req, res) => {
  const { deviceId } = req.params;

  try {
    const sessions = await pool.query(
      `SELECT s.*, COUNT(t.id) as actual_trees_count
       FROM field_inventory_sessions s
       LEFT JOIN field_trees t ON s.id = t.session_id
       WHERE s.device_id = $1
       GROUP BY s.id
       ORDER BY s.synced_at DESC
       LIMIT 50`,
      [deviceId]
    );

    res.json({
      success: true,
      device_id: deviceId,
      sessions: sessions.rows,
      total: sessions.rows.length
    });

  } catch (err) {
    console.error('History fetch error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history'
    });
  }
});

// GET /api/field-inventory/all-sessions
// Obține toate sesiunile de inventar (pentru interfața web)
app.get('/api/field-inventory/all-sessions', authenticateToken, async (req, res) => {
  try {
    // Admin vede tot, user-ii obișnuiți văd doar datele companiei lor
    let query = `
      SELECT
        s.*,
        COUNT(t.id) as tree_records_count,
        u.username,
        u.full_name as user_full_name
      FROM field_inventory_sessions s
      LEFT JOIN field_trees t ON s.id = t.session_id
      LEFT JOIN users u ON s.user_id = u.id
    `;

    const params = [];

    // Filtrare pe company_id dacă nu este admin
    if (req.user.role !== 'admin') {
      // Obține company_id al user-ului
      const userInfo = await pool.query(
        'SELECT company_id FROM users WHERE id = $1',
        [req.user.id]
      );

      if (userInfo.rows.length === 0 || !userInfo.rows[0].company_id) {
        return res.status(403).json({
          success: false,
          error: 'User not associated with any company'
        });
      }

      query += ' WHERE s.company_id = $1';
      params.push(userInfo.rows[0].company_id);
    }

    query += ' GROUP BY s.id, u.username, u.full_name ORDER BY s.synced_at DESC';

    const sessions = await pool.query(query, params);

    res.json({
      success: true,
      sessions: sessions.rows,
      total: sessions.rows.length,
      filtered_by_company: req.user.role !== 'admin'
    });

  } catch (err) {
    console.error('Error fetching all sessions:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sessions'
    });
  }
});

// GET /api/field-inventory/session/:id/trees
// Obține arborii pentru o sesiune specifică
app.get('/api/field-inventory/session/:id/trees', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Verificare acces la sesiune (dacă nu e admin, verifică că sesiunea aparține companiei sale)
    if (req.user.role !== 'admin') {
      const userInfo = await pool.query('SELECT company_id FROM users WHERE id = $1', [req.user.id]);

      if (userInfo.rows.length === 0 || !userInfo.rows[0].company_id) {
        return res.status(403).json({
          success: false,
          error: 'User not associated with any company'
        });
      }

      const sessionCheck = await pool.query(
        'SELECT id FROM field_inventory_sessions WHERE id = $1 AND company_id = $2',
        [id, userInfo.rows[0].company_id]
      );

      if (sessionCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Access denied to this session'
        });
      }
    }

    const trees = await pool.query(
      `SELECT * FROM field_trees WHERE session_id = $1 ORDER BY recorded_at DESC`,
      [id]
    );

    const totalVolume = trees.rows.reduce((sum, tree) => sum + parseFloat(tree.volume || 0), 0);

    res.json({
      success: true,
      session_id: id,
      trees: trees.rows,
      total_volume: totalVolume.toFixed(2)
    });

  } catch (err) {
    console.error('Error fetching session trees:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trees'
    });
  }
});

// DELETE /api/field-inventory/session/:id
// Șterge o sesiune de inventar (doar admin)
app.delete('/api/field-inventory/session/:id', authenticateToken, async (req, res) => {
  try {
    // Verificare: doar admin poate șterge
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only admins can delete sessions'
      });
    }

    const { id } = req.params;

    // Verifică dacă sesiunea există
    const checkSession = await pool.query(
      'SELECT id, apv_number, device_id FROM field_inventory_sessions WHERE id = $1',
      [id]
    );

    if (checkSession.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Șterge sesiunea (cascade va șterge și tree records)
    await pool.query('DELETE FROM field_inventory_sessions WHERE id = $1', [id]);

    console.log(`✅ Admin ${req.user.username} deleted session ${id} (APV: ${checkSession.rows[0].apv_number})`);

    res.json({
      success: true,
      message: 'Session deleted successfully',
      session_id: parseInt(id)
    });

  } catch (err) {
    console.error('Error deleting session:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to delete session'
    });
  }
});

// POST /api/field-inventory/delete-session
// Șterge o sesiune din aplicația mobilă (PUBLIC - fără JWT, folosește device_id)
app.post('/api/field-inventory/delete-session', async (req, res) => {
  try {
    const { session_id, device_id } = req.body;

    // Validare input
    if (!session_id || !device_id) {
      return res.status(400).json({
        success: false,
        error: 'session_id and device_id are required'
      });
    }

    // Verifică dacă sesiunea există și aparține device-ului
    const checkSession = await pool.query(
      'SELECT id, apv_number, device_id FROM field_inventory_sessions WHERE id = $1',
      [session_id]
    );

    if (checkSession.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Verificare: doar device-ul care a creat sesiunea poate șterge
    if (checkSession.rows[0].device_id !== device_id) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete sessions created by your device'
      });
    }

    // Șterge sesiunea (cascade va șterge și tree records)
    await pool.query('DELETE FROM field_inventory_sessions WHERE id = $1', [session_id]);

    console.log(`✅ Device ${device_id} deleted session ${session_id} (APV: ${checkSession.rows[0].apv_number})`);

    res.json({
      success: true,
      message: 'Session deleted successfully',
      session_id: parseInt(session_id)
    });

  } catch (err) {
    console.error('Mobile delete session error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to delete session',
      details: err.message
    });
  }
});

// PATCH /api/field-inventory/session/:id
// Editează o sesiune de inventar (doar admin)
app.patch('/api/field-inventory/session/:id', authenticateToken, async (req, res) => {
  try {
    // Verificare: doar admin poate edita
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only admins can edit sessions'
      });
    }

    const { id } = req.params;
    const { apv_number, ua_number, inventory_date, total_trees, total_volume } = req.body;

    // Verifică dacă sesiunea există
    const checkSession = await pool.query(
      'SELECT id FROM field_inventory_sessions WHERE id = $1',
      [id]
    );

    if (checkSession.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Construiește query-ul de update dinamic
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (apv_number !== undefined) {
      updates.push(`apv_number = $${paramIndex++}`);
      values.push(apv_number);
    }
    if (ua_number !== undefined) {
      updates.push(`ua_number = $${paramIndex++}`);
      values.push(ua_number);
    }
    if (inventory_date !== undefined) {
      updates.push(`inventory_date = $${paramIndex++}`);
      values.push(inventory_date);
    }
    if (total_trees !== undefined) {
      updates.push(`total_trees = $${paramIndex++}`);
      values.push(total_trees);
    }
    if (total_volume !== undefined) {
      updates.push(`total_volume = $${paramIndex++}`);
      values.push(total_volume);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }

    values.push(id); // Add ID as last parameter

    const updateQuery = `
      UPDATE field_inventory_sessions
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(updateQuery, values);

    console.log(`✅ Admin ${req.user.username} updated session ${id}`);

    res.json({
      success: true,
      message: 'Session updated successfully',
      session: result.rows[0]
    });

  } catch (err) {
    console.error('Error updating session:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to update session'
    });
  }
});

// GET /api/field-inventory/export/csv
// Export CSV pentru date inventar - format structurat
app.get('/api/field-inventory/export/csv', authenticateToken, async (req, res) => {
  try {
    const { device_id, apv_number } = req.query;

    // Build query pentru trees cu JOIN-uri
    let query = `
      SELECT
        t.id,
        t.species,
        t.diameter,
        t.volume,
        s.apv_number,
        s.ua_number,
        s.inventory_date
      FROM field_trees t
      JOIN field_inventory_sessions s ON t.session_id = s.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Filters
    if (device_id) {
      query += ` AND s.device_id = $${paramIndex++}`;
      params.push(device_id);
    }
    if (apv_number) {
      query += ` AND s.apv_number = $${paramIndex++}`;
      params.push(apv_number);
    }

    // Company filtering pentru non-admin
    if (req.user.role !== 'admin') {
      const userInfo = await pool.query('SELECT company_id FROM users WHERE id = $1', [req.user.id]);
      if (!userInfo.rows[0]?.company_id) {
        return res.status(403).json({ error: 'User not associated with company' });
      }
      query += ` AND s.company_id = $${paramIndex++}`;
      params.push(userInfo.rows[0].company_id);
    }

    query += ' ORDER BY t.species, t.diameter';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).send('Nu există date de exportat');
    }

    // Get session info pentru header
    const sessionInfo = result.rows[0];
    const apv = sessionInfo.apv_number || 'N/A';
    const ua = sessionInfo.ua_number || 'N/A';

    // Build CSV cu format structurat
    let csv = `Inventarul arborilor predați din APV ${apv}\n`;
    csv += `UP I Stoiceni UA ${ua}\n\n`;
    csv += 'Nr. Crt,Specia,Diametru (cm),Volum Unitar (m³)\n';

    let totalVolume = 0;
    result.rows.forEach((tree, index) => {
      csv += `${index + 1},${tree.species || 'N/A'},${tree.diameter || 0},${tree.volume || 0}\n`;
      totalVolume += parseFloat(tree.volume || 0);
    });

    csv += `TOTAL,,${result.rows.length},${totalVolume.toFixed(6)}\n`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Inventar_APV_${apv}_${Date.now()}.csv"`);
    res.send('\uFEFF' + csv); // UTF-8 BOM pentru Excel
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ error: 'Export failed', details: err.message });
  }
});

// GET /api/field-inventory/export/excel
// Export format Excel real (XLSX) folosind exceljs
app.get('/api/field-inventory/export/excel', authenticateToken, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { device_id, apv_number } = req.query;

    // Same query ca la CSV
    let query = `
      SELECT
        t.id,
        t.species,
        t.diameter,
        t.volume,
        s.apv_number,
        s.ua_number,
        s.inventory_date
      FROM field_trees t
      JOIN field_inventory_sessions s ON t.session_id = s.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (device_id) {
      query += ` AND s.device_id = $${paramIndex++}`;
      params.push(device_id);
    }
    if (apv_number) {
      query += ` AND s.apv_number = $${paramIndex++}`;
      params.push(apv_number);
    }

    if (req.user.role !== 'admin') {
      const userInfo = await pool.query('SELECT company_id FROM users WHERE id = $1', [req.user.id]);
      if (!userInfo.rows[0]?.company_id) {
        return res.status(403).json({ error: 'User not associated with company' });
      }
      query += ` AND s.company_id = $${paramIndex++}`;
      params.push(userInfo.rows[0].company_id);
    }

    query += ' ORDER BY t.species, t.diameter';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).send('Nu există date de exportat');
    }

    const sessionInfo = result.rows[0];
    const apv = sessionInfo.apv_number || 'N/A';
    const ua = sessionInfo.ua_number || 'N/A';

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Inventar');

    // Header
    worksheet.mergeCells('A1:D1');
    worksheet.getCell('A1').value = `Inventarul arborilor predați din APV ${apv}`;
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('A1').alignment = { horizontal: 'center' };

    worksheet.mergeCells('A2:D2');
    worksheet.getCell('A2').value = `UP I Stoiceni UA ${ua}`;
    worksheet.getCell('A2').font = { bold: true, size: 12 };
    worksheet.getCell('A2').alignment = { horizontal: 'center' };

    // Table header (row 4)
    const headerRow = worksheet.getRow(4);
    headerRow.values = ['Nr. Crt', 'Specia', 'Diametru (cm)', 'Volum Unitar (m³)'];
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    // Data rows
    let totalVolume = 0;
    result.rows.forEach((tree, index) => {
      const row = worksheet.addRow([
        index + 1,
        tree.species || 'N/A',
        tree.diameter || 0,
        parseFloat(tree.volume || 0)
      ]);

      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });

      totalVolume += parseFloat(tree.volume || 0);
    });

    // Total row
    const totalRow = worksheet.addRow([
      'TOTAL',
      '',
      result.rows.length,
      totalVolume
    ]);
    totalRow.font = { bold: true };
    totalRow.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFE0B2' }
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    // Column widths
    worksheet.getColumn(1).width = 10;
    worksheet.getColumn(2).width = 25;
    worksheet.getColumn(3).width = 15;
    worksheet.getColumn(4).width = 20;

    // Send
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Inventar_APV_${apv}_${Date.now()}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ error: 'Export failed', details: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🏢 Companies Support: ENABLED`);
  console.log(`📧 Email Support: ENABLED`);
  console.log(`📱 Multi-App Support: ENABLED`);
  console.log(`⏱️ Grace Period Support: ENABLED`);
  await initDatabase();
});