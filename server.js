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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Configure multer
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

// Initialize database
async function initDatabase() {
  try {
    // CSV tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS csv_files (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS csv_data (
        id SERIAL PRIMARY KEY,
        file_id INTEGER REFERENCES csv_files(id) ON DELETE CASCADE,
        row_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Auth tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100),
        role VARCHAR(20) DEFAULT 'user',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_categories (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        category VARCHAR(50) NOT NULL,
        can_read BOOLEAN DEFAULT true,
        can_write BOOLEAN DEFAULT false,
        can_delete BOOLEAN DEFAULT false,
        UNIQUE(user_id, category)
      )
    `);

// Create default admin if not exists
try {
  const adminCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
  if (adminCheck.rows.length === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)',
      ['admin', hashedPassword, 'Administrator', 'admin']
    );
    console.log('✅ Default admin created (username: admin, password: admin123)');
  } else {
    console.log('✅ Default admin already exists');
  }
} catch (adminErr) {
  console.error('⚠️ Admin creation error (non-fatal):', adminErr.message);
}

// Auth middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT id, username, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return res.status(403).json({ error: 'Invalid or inactive user' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Check category permissions
const checkCategoryAccess = (permission) => {
  return async (req, res, next) => {
    const category = req.body.category || req.query.category || req.params.category;
    
    // Admin has all permissions
    if (req.user.role === 'admin') {
      return next();
    }

    if (!category) {
      return res.status(400).json({ error: 'Category required' });
    }

    try {
      const result = await pool.query(
        `SELECT ${permission} FROM user_categories WHERE user_id = $1 AND category = $2`,
        [req.user.id, category]
      );

      if (result.rows.length === 0 || !result.rows[0][permission]) {
        return res.status(403).json({ error: 'Permission denied for this category' });
      }

      next();
    } catch (err) {
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Timber Inventory API with Authentication',
    version: '4.0.0',
    status: 'running',
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        me: 'GET /api/auth/me'
      },
      admin: {
        users: 'GET /api/admin/users',
        createUser: 'POST /api/admin/users',
        updateUser: 'PUT /api/admin/users/:id',
        deleteUser: 'DELETE /api/admin/users/:id'
      },
      data: {
        upload: 'POST /api/upload [Auth Required]',
        categories: 'GET /api/categories [Auth Required]',
        datasets: 'GET /api/datasets [Auth Required]',
        search: 'GET /api/search [Auth Required]',
        data: 'GET /api/data/:filename [Auth Required]',
        delete: 'DELETE /api/data/:id [Auth Required]'
      }
    }
  });
});

// ============ AUTH ENDPOINTS ============

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token: token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role,
              array_agg(uc.category) as categories
       FROM users u
       LEFT JOIN user_categories uc ON u.id = uc.user_id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// ============ ADMIN ENDPOINTS ============

// Get all users (admin only)
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.username, u.full_name, u.role, u.is_active, u.created_at,
        json_agg(
          json_build_object(
            'category', uc.category,
            'can_read', uc.can_read,
            'can_write', uc.can_write,
            'can_delete', uc.can_delete
          )
        ) FILTER (WHERE uc.category IS NOT NULL) as categories
      FROM users u
      LEFT JOIN user_categories uc ON u.id = uc.user_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    res.json({ users: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create user (admin only)
app.post('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { username, password, full_name, role, categories } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, hashedPassword, full_name || username, role || 'user']
    );

    const userId = userResult.rows[0].id;

    // Add category permissions
    if (categories && categories.length > 0) {
      for (const cat of categories) {
        await client.query(
          'INSERT INTO user_categories (user_id, category, can_read, can_write, can_delete) VALUES ($1, $2, $3, $4, $5)',
          [userId, cat.category, cat.can_read !== false, cat.can_write || false, cat.can_delete || false]
        );
      }
    }

    await client.query('COMMIT');

    res.json({ success: true, userId: userId, message: 'User created successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create user error:', err);
    if (err.constraint === 'users_username_key') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create user' });
    }
  } finally {
    client.release();
  }
});

// Update user (admin only)
app.put('/api/admin/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const userId = req.params.id;
  const { full_name, role, is_active, categories, password } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Update user info
    let updateQuery = 'UPDATE users SET ';
    const updateParams = [];
    let paramCount = 1;

    if (full_name !== undefined) {
      updateQuery += `full_name = $${paramCount}, `;
      updateParams.push(full_name);
      paramCount++;
    }

    if (role !== undefined) {
      updateQuery += `role = $${paramCount}, `;
      updateParams.push(role);
      paramCount++;
    }

    if (is_active !== undefined) {
      updateQuery += `is_active = $${paramCount}, `;
      updateParams.push(is_active);
      paramCount++;
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updateQuery += `password_hash = $${paramCount}, `;
      updateParams.push(hashedPassword);
      paramCount++;
    }

    updateQuery = updateQuery.slice(0, -2); // Remove last comma
    updateQuery += ` WHERE id = $${paramCount}`;
    updateParams.push(userId);

    await client.query(updateQuery, updateParams);

    // Update categories if provided
    if (categories !== undefined) {
      await client.query('DELETE FROM user_categories WHERE user_id = $1', [userId]);
      
      for (const cat of categories) {
        await client.query(
          'INSERT INTO user_categories (user_id, category, can_read, can_write, can_delete) VALUES ($1, $2, $3, $4, $5)',
          [userId, cat.category, cat.can_read !== false, cat.can_write || false, cat.can_delete || false]
        );
      }
    }

    await client.query('COMMIT');

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  } finally {
    client.release();
  }
});

// Delete user (admin only)
app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const userId = req.params.id;

  if (parseInt(userId) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  try {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ============ DATA ENDPOINTS (Protected) ============

// Get categories (user sees only their categories)
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    let query;
    let params = [];

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
    console.error('Error fetching categories:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Upload CSV (requires write permission)
app.post('/api/upload', authenticateToken, checkCategoryAccess('can_write'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const client = await pool.connect();
  
  try {
    const category = req.body.category || 'general';
    const filename = req.file.originalname;

    // Check for duplicate
    const duplicateCheck = await client.query(
      'SELECT id FROM csv_files WHERE filename = $1 AND category = $2',
      [filename, category]
    );

    if (duplicateCheck.rows.length > 0) {
      client.release();
      return res.status(409).json({ 
        error: 'Duplicate file',
        message: `Fișierul "${filename}" există deja în categoria "${category}"`
      });
    }

    await client.query('BEGIN');

    const fileResult = await client.query(
      'INSERT INTO csv_files (filename, category) VALUES ($1, $2) RETURNING id',
      [filename, category]
    );
    const fileId = fileResult.rows[0].id;

    // Parse CSV
    const rows = [];
    const stream = Readable.from(req.file.buffer.toString());
    
    await new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    // Insert data
    for (const row of rows) {
      await client.query(
        'INSERT INTO csv_data (file_id, row_data) VALUES ($1, $2)',
        [fileId, JSON.stringify(row)]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'File uploaded successfully',
      filename: filename,
      category: category,
      rows: rows.length,
      fileId: fileId
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  } finally {
    client.release();
  }
});

// Get datasets (filtered by user permissions)
app.get('/api/datasets', authenticateToken, async (req, res) => {
  try {
    const category = req.query.category;
    
    let query = `
      SELECT 
        f.id, f.filename, f.category, f.uploaded_at,
        COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
    `;
    
    const params = [];
    const whereClauses = [];

    if (req.user.role !== 'admin') {
      whereClauses.push(`f.category IN (
        SELECT category FROM user_categories WHERE user_id = $${params.length + 1}
      )`);
      params.push(req.user.id);
    }

    if (category) {
      whereClauses.push(`f.category = $${params.length + 1}`);
      params.push(category);
    }

    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }

    query += ' GROUP BY f.id ORDER BY f.uploaded_at DESC';

    const result = await pool.query(query, params);
    res.json({ datasets: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Error fetching datasets:', err);
    res.status(500).json({ error: 'Failed to fetch datasets' });
  }
});

// Search datasets
app.get('/api/search', authenticateToken, async (req, res) => {
  try {
    const searchTerm = req.query.q;
    
    if (!searchTerm) {
      return res.status(400).json({ error: 'Search term required' });
    }

    let query = `
      SELECT 
        f.id, f.filename, f.category, f.uploaded_at,
        COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
      WHERE (f.filename ILIKE $1 OR f.category ILIKE $1)
    `;

    const params = [`%${searchTerm}%`];

    if (req.user.role !== 'admin') {
      query += ` AND f.category IN (
        SELECT category FROM user_categories WHERE user_id = $2
      )`;
      params.push(req.user.id);
    }

    query += ' GROUP BY f.id ORDER BY f.uploaded_at DESC';

    const result = await pool.query(query, params);
    res.json({ results: result.rows, count: result.rows.length, searchTerm: searchTerm });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get CSV data
app.get('/api/data/:filename', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.row_data, f.category
      FROM csv_data d
      JOIN csv_files f ON d.file_id = f.id
      WHERE f.filename = $1
      ORDER BY d.id
    `, [req.params.filename]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const category = result.rows[0].category;

    // Check read permission
    if (req.user.role !== 'admin') {
      const permCheck = await pool.query(
        'SELECT can_read FROM user_categories WHERE user_id = $1 AND category = $2',
        [req.user.id, category]
      );

      if (permCheck.rows.length === 0 || !permCheck.rows[0].can_read) {
        return res.status(403).json({ error: 'Permission denied' });
      }
    }

    const data = result.rows.map(row => row.row_data);
    res.json({ filename: req.params.filename, count: data.length, data: data });
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Delete dataset (requires delete permission)
app.delete('/api/data/:id', authenticateToken, async (req, res) => {
  try {
    // Get file category first
    const fileResult = await pool.query('SELECT category FROM csv_files WHERE id = $1', [req.params.id]);
    
    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const category = fileResult.rows[0].category;

    // Check delete permission
    if (req.user.role !== 'admin') {
      const permCheck = await pool.query(
        'SELECT can_delete FROM user_categories WHERE user_id = $1 AND category = $2',
        [req.user.id, category]
      );

      if (permCheck.rows.length === 0 || !permCheck.rows[0].can_delete) {
        return res.status(403).json({ error: 'Permission denied' });
      }
    }

    await pool.query('DELETE FROM csv_files WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Dataset deleted' });
  } catch (err) {
    console.error('Error deleting dataset:', err);
    res.status(500).json({ error: 'Failed to delete dataset' });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initDatabase();
});