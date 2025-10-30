const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const csv = require('csv-parser');
const { Readable } = require('stream');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

app.get('/', (req, res) => {
  res.json({message: 'Timber API with Multi-App Support', version: '7.0.0', status: 'running', features: ['companies', 'users', 'licenses', 'multi_app', 'offline_mode']});
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

app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    let query; let params = [];
    if (req.user.role === 'admin') {
      query = 'SELECT DISTINCT category FROM csv_files ORDER BY category';
    } else {
      query = 'SELECT DISTINCT category FROM user_categories WHERE user_id = $1 ORDER BY category';
      params = [req.user.id];
    }
    const result = await pool.query(query, params);
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

app.get('/api/datasets', authenticateToken, async (req, res) => {
  try {
    const category = req.query.category;
    let query = `SELECT f.id, f.filename, f.category, f.uploaded_at, COUNT(d.id) as record_count FROM csv_files f LEFT JOIN csv_data d ON f.id = d.file_id`;
    const params = [];
    const whereClauses = [];
    if (req.user.role !== 'admin') {
      whereClauses.push(`f.category IN (SELECT category FROM user_categories WHERE user_id = $${params.length + 1})`);
      params.push(req.user.id);
    }
    if (category) {
      whereClauses.push(`f.category = $${params.length + 1}`);
      params.push(category);
    }
    if (whereClauses.length > 0) query += ' WHERE ' + whereClauses.join(' AND ');
    query += ' GROUP BY f.id ORDER BY f.uploaded_at DESC';
    const result = await pool.query(query, params);
    res.json({ datasets: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch datasets' });
  }
});

app.get('/api/search', authenticateToken, async (req, res) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) return res.status(400).json({ error: 'Search term required' });
    let query = `SELECT f.id, f.filename, f.category, f.uploaded_at, COUNT(d.id) as record_count FROM csv_files f LEFT JOIN csv_data d ON f.id = d.file_id WHERE (f.filename ILIKE $1 OR f.category ILIKE $1)`;
    const params = [`%${searchTerm}%`];
    if (req.user.role !== 'admin') {
      query += ` AND f.category IN (SELECT category FROM user_categories WHERE user_id = $2)`;
      params.push(req.user.id);
    }
    query += ' GROUP BY f.id ORDER BY f.uploaded_at DESC';
    const result = await pool.query(query, params);
    res.json({ results: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/data/:filename', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT d.row_data, f.category FROM csv_data d JOIN csv_files f ON d.file_id = f.id WHERE f.filename = $1 ORDER BY d.id`, [req.params.filename]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    const category = result.rows[0].category;
    if (req.user.role !== 'admin') {
      const permCheck = await pool.query('SELECT can_read FROM user_categories WHERE user_id = $1 AND category = $2', [req.user.id, category]);
      if (permCheck.rows.length === 0 || !permCheck.rows[0].can_read) return res.status(403).json({ error: 'Permission denied' });
    }
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
    const licenseResult = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [license_key]);
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
      return res.json({ success: true, message: 'Device already activated', license: {license_key: license.license_key, company_name: license.company_name, app_id: license.app_id, max_devices: license.max_devices, grace_period_days: license.grace_period_days, expires_at: license.expires_at}, device: existingDevice.rows[0]});
    }
    const deviceCount = await pool.query('SELECT COUNT(*) FROM license_devices WHERE license_id = $1', [license.id]);
    if (parseInt(deviceCount.rows[0].count) >= license.max_devices) return res.status(403).json({ error: 'Device limit reached', max_devices: license.max_devices });
    const deviceResult = await pool.query(`INSERT INTO license_devices (license_id, device_id, device_name, device_model) VALUES ($1, $2, $3, $4) RETURNING *`, [license.id, device_id, device_name || 'Unknown', device_model || 'Unknown']);
    res.json({ success: true, message: 'Device activated successfully', license: {license_key: license.license_key, company_name: license.company_name, app_id: license.app_id, max_devices: license.max_devices, grace_period_days: license.grace_period_days, expires_at: license.expires_at}, device: deviceResult.rows[0]});
  } catch (err) {
    res.status(500).json({ error: 'Activation failed' });
  }
});

app.post('/api/licenses/verify', async (req, res) => {
  const { license_key, device_id, app_id } = req.body;
  if (!license_key || !device_id) return res.status(400).json({ error: 'License key and device ID required' });
  try {
    const result = await pool.query(`SELECT l.*, ld.id as device_record_id, ld.last_seen FROM licenses l LEFT JOIN license_devices ld ON l.id = ld.license_id AND ld.device_id = $2 WHERE l.license_key = $1`, [license_key, device_id]);
    if (result.rows.length === 0) return res.status(404).json({ valid: false, error: 'Invalid license key', should_retry: false });
    const license = result.rows[0];
    
    if (app_id && license.app_id && license.app_id !== '*' && license.app_id !== app_id) {
      return res.json({ valid: false, error: 'License not valid for this application', valid_for: license.app_id, should_retry: false });
    }
    
    if (!license.is_active) return res.json({ valid: false, error: 'License is inactive', should_retry: false });
    if (license.expires_at && new Date(license.expires_at) < new Date()) return res.json({ valid: false, error: 'License has expired', expired_at: license.expires_at, should_retry: false });
    if (!license.device_record_id) return res.json({ valid: false, error: 'Device not activated', should_retry: false });
    await pool.query('UPDATE license_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1', [license.device_record_id]);
    res.json({ valid: true, verified_at: new Date().toISOString(), license: {company_name: license.company_name, app_id: license.app_id, expires_at: license.expires_at, max_devices: license.max_devices, grace_period_days: license.grace_period_days, last_verified: new Date().toISOString()}});
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

// ============================================
// SYNC ENDPOINTS FOR MOBILE APP
// ============================================

// GET /api/sync - Sincronizare pentru mobile app
app.get('/api/sync', authenticateToken, async (req, res) => {
  try {
    console.log(`📱 Sync request from user: ${req.user.username} (role: ${req.user.role})`);
    
    // Get categorii disponibile pentru user
    let categoriesQuery;
    let categoriesParams = [];
    
    if (req.user.role === 'admin') {
      categoriesQuery = 'SELECT DISTINCT category FROM csv_files WHERE category IS NOT NULL ORDER BY category';
    } else {
      categoriesQuery = `
        SELECT DISTINCT category 
        FROM user_categories 
        WHERE user_id = $1 AND can_read = true 
        ORDER BY category
      `;
      categoriesParams = [req.user.id];
    }
    
    const categoriesResult = await pool.query(categoriesQuery, categoriesParams);
    const categories = categoriesResult.rows.map(row => row.category);

    // Get datasets disponibile pentru user
    let datasetsQuery = `
      SELECT
        f.id,
        f.filename,
        f.category,
        f.uploaded_at,
        COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
    `;
    
    const datasetsParams = [];
    const whereClauses = [];
    
    // Filtru permisiuni
    if (req.user.role !== 'admin') {
      whereClauses.push(`f.category IN (SELECT category FROM user_categories WHERE user_id = $${datasetsParams.length + 1} AND can_read = true)`);
      datasetsParams.push(req.user.id);
    }
    
    if (whereClauses.length > 0) {
      datasetsQuery += ' WHERE ' + whereClauses.join(' AND ');
    }

    datasetsQuery += ' GROUP BY f.id ORDER BY f.uploaded_at DESC';
    
    const datasetsResult = await pool.query(datasetsQuery, datasetsParams);

    const response = {
      success: true,
      categories: categories,
      datasets: datasetsResult.rows,
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        company_id: req.user.company_id || null
      },
      synced_at: new Date().toISOString(),
      server_version: '7.0.0'
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

// GET /api/datasets/:id/data - Download data pentru un dataset specific
app.get('/api/datasets/:id/data', authenticateToken, async (req, res) => {
  try {
    const datasetId = req.params.id;
    console.log(`📥 Download request for dataset ${datasetId} by user ${req.user.username}`);
    
    // Verifică dacă dataset-ul există și ia categoria
    const fileCheck = await pool.query(
      'SELECT id, filename, category, app_id, user_id, company_id FROM csv_files WHERE id = $1',
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
    const category = file.category;
    
    // Verifică permisiuni
    if (req.user.role !== 'admin') {
      const permCheck = await pool.query(
        'SELECT can_read FROM user_categories WHERE user_id = $1 AND category = $2',
        [req.user.id, category]
      );
      
      if (permCheck.rows.length === 0 || !permCheck.rows[0].can_read) {
        console.log(`❌ Permission denied for user ${req.user.username} on category ${category}`);
        return res.status(403).json({ 
          success: false,
          error: 'Permission denied for this category' 
        });
      }
    }
    
    // Get data
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
      category: category,
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

// GET /api/categories - List categorii (pentru compatibility)
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    let query;
    let params = [];
    
    if (req.user.role === 'admin') {
      query = 'SELECT DISTINCT category FROM csv_files WHERE category IS NOT NULL ORDER BY category';
    } else {
      query = 'SELECT DISTINCT category FROM user_categories WHERE user_id = $1 AND can_read = true ORDER BY category';
      params = [req.user.id];
    }
    
    const result = await pool.query(query, params);
    const categories = result.rows.map(row => row.category);
    
    res.json({ 
      success: true,
      categories: categories, 
      count: categories.length 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch categories' 
    });
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