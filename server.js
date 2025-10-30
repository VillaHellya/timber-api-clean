console.log('✅ Default admin created (username: admin, password: admin123)');
      } else {
        console.log('✅ Default admin already exists');
      }
    } catch (adminErr) {
      console.error('⚠️ Admin creation error (non-fatal):', adminErr.message);
    }

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
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
    message: 'Timber Inventory API with Authentication & Licenses (Grace Period Support)',
    version: '5.1.0',
    status: 'running',
    features: ['offline_mode', 'grace_period', 'license_management'],
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        me: 'GET /api/auth/me'
      },
      admin: {
        users: 'GET /api/admin/users',
        createUser: 'POST /api/admin/users',
        updateUser: 'PUT /api/admin/users/:id',
        deleteUser: 'DELETE /api/admin/users/:id',
        licenses: 'GET /api/admin/licenses',
        createLicense: 'POST /api/admin/licenses'
      },
      licenses: {
        activate: 'POST /api/licenses/activate',
        verify: 'POST /api/licenses/verify',
        deactivate: 'POST /api/licenses/deactivate',
        info: 'GET /api/licenses/info/:licenseKey'
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
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

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

    updateQuery = updateQuery.slice(0, -2);
    updateQuery += ` WHERE id = $${paramCount}`;
    updateParams.push(userId);

    await client.query(updateQuery, updateParams);

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

// Get categories
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

// Upload CSV
app.post('/api/upload', authenticateToken, checkCategoryAccess('can_write'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const client = await pool.connect();
  
  try {
    const category = req.body.category || 'general';
    const filename = req.file.originalname;

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

    const rows = [];
    const stream = Readable.from(req.file.buffer.toString());
    
    await new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

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

// Get datasets
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

// Delete dataset
app.delete('/api/data/:id', authenticateToken, async (req, res) => {
  try {
    const fileResult = await pool.query('SELECT category FROM csv_files WHERE id = $1', [req.params.id]);
    
    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const category = fileResult.rows[0].category;

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

// ============= LICENSE MANAGEMENT WITH GRACE PERIOD =============

// Generate license key
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = 4;
  const segmentLength = 4;
  
  let key = 'TBR-';
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segmentLength; j++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (i < segments - 1) key += '-';
  }
  return key;
}

// Get all licenses (admin only)
app.get('/api/admin/licenses', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        u.username,
        u.full_name,
        COUNT(ld.id) as active_devices
      FROM licenses l
      LEFT JOIN users u ON l.user_id = u.id
      LEFT JOIN license_devices ld ON l.id = ld.license_id
      GROUP BY l.id, u.username, u.full_name
      ORDER BY l.created_at DESC
    `);

    res.json({ licenses: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Error fetching licenses:', err);
    res.status(500).json({ error: 'Failed to fetch licenses' });
  }
});

// Create license (admin only)
app.post('/api/admin/licenses', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { user_id, company_name, max_devices, grace_period_days, expires_at, notes } = req.body;

  try {
    const licenseKey = generateLicenseKey();
    
    const result = await pool.query(
      `INSERT INTO licenses (license_key, user_id, company_name, max_devices, grace_period_days, expires_at, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [
        licenseKey, 
        user_id || null, 
        company_name || null, 
        max_devices || 3, 
        grace_period_days || 7,
        expires_at || null, 
        notes || null
      ]
    );

    res.json({ success: true, license: result.rows[0] });
  } catch (err) {
    console.error('Create license error:', err);
    res.status(500).json({ error: 'Failed to create license' });
  }
});

// Update license (admin only)
app.put('/api/admin/licenses/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { user_id, company_name, max_devices, grace_period_days, expires_at, is_active, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE licenses 
       SET user_id = $1, company_name = $2, max_devices = $3, grace_period_days = $4, expires_at = $5, is_active = $6, notes = $7
       WHERE id = $8
       RETURNING *`,
      [
        user_id || null, 
        company_name || null, 
        max_devices, 
        grace_period_days || 7,
        expires_at || null, 
        is_active, 
        notes || null, 
        id
      ]
    );

    res.json({ success: true, license: result.rows[0] });
  } catch (err) {
    console.error('Update license error:', err);
    res.status(500).json({ error: 'Failed to update license' });
  }
});

// Delete license (admin only)
app.delete('/api/admin/licenses/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    await pool.query('DELETE FROM licenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete license error:', err);
    res.status(500).json({ error: 'Failed to delete license' });
  }
});

// Get devices for a license (admin only)
app.get('/api/admin/licenses/:id/devices', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM license_devices WHERE license_id = $1 ORDER BY activated_at DESC',
      [req.params.id]
    );

    res.json({ devices: result.rows });
  } catch (err) {
    console.error('Error fetching devices:', err);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// Remove device from license (admin only)
app.delete('/api/admin/licenses/:licenseId/devices/:deviceId', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    await pool.query(
      'DELETE FROM license_devices WHERE license_id = $1 AND id = $2',
      [req.params.licenseId, req.params.deviceId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Remove device error:', err);
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

// ============= PUBLIC LICENSE ENDPOINTS (for Android) =============

// Activate license on device
app.post('/api/licenses/activate', async (req, res) => {
  const { license_key, device_id, device_name, device_model } = req.body;

  if (!license_key || !device_id) {
    return res.status(400).json({ error: 'License key and device ID required' });
  }

  try {
    const licenseResult = await pool.query(
      'SELECT * FROM licenses WHERE license_key = $1',
      [license_key]
    );

    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid license key' });
    }

    const license = licenseResult.rows[0];

    if (!license.is_active) {
      return res.status(403).json({ error: 'License is inactive' });
    }

    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ error: 'License has expired' });
    }

    const existingDevice = await pool.query(
      'SELECT * FROM license_devices WHERE license_id = $1 AND device_id = $2',
      [license.id, device_id]
    );

    if (existingDevice.rows.length > 0) {
      await pool.query(
        'UPDATE license_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1',
        [existingDevice.rows[0].id]
      );
      return res.json({ 
        success: true, 
        message: 'Device already activated',
        license: {
          license_key: license.license_key,
          company_name: license.company_name,
          max_devices: license.max_devices,
          grace_period_days: license.grace_period_days,
          expires_at: license.expires_at
        },
        device: existingDevice.rows[0]
      });
    }

    const deviceCount = await pool.query(
      'SELECT COUNT(*) FROM license_devices WHERE license_id = $1',
      [license.id]
    );

    if (parseInt(deviceCount.rows[0].count) >= license.max_devices) {
      return res.status(403).json({ 
        error: 'Device limit reached',
        max_devices: license.max_devices
      });
    }

    const deviceResult = await pool.query(
      `INSERT INTO license_devices (license_id, device_id, device_name, device_model) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [license.id, device_id, device_name || 'Unknown', device_model || 'Unknown']
    );

    res.json({ 
      success: true, 
      message: 'Device activated successfully',
      license: {
        license_key: license.license_key,
        company_name: license.company_name,
        max_devices: license.max_devices,
        grace_period_days: license.grace_period_days,
        expires_at: license.expires_at
      },
      device: deviceResult.rows[0]
    });

  } catch (err) {
    console.error('License activation error:', err);
    res.status(500).json({ error: 'Activation failed' });
  }
});

// Verify license (with grace period support)
app.post('/api/licenses/verify', async (req, res) => {
  const { license_key, device_id } = req.body;

  if (!license_key || !device_id) {
    return res.status(400).json({ error: 'License key and device ID required' });
  }

  try {
    const result = await pool.query(`
      SELECT l.*, ld.id as device_record_id, ld.last_seen
      FROM licenses l
      LEFT JOIN license_devices ld ON l.id = ld.license_id AND ld.device_id = $2
      WHERE l.license_key = $1
    `, [license_key, device_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        valid: false, 
        error: 'Invalid license key',
        should_retry: false
      });
    }

    const license = result.rows[0];

    if (!license.is_active) {
      return res.json({ 
        valid: false, 
        error: 'License is inactive',
        should_retry: false
      });
    }

    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return res.json({ 
        valid: false, 
        error: 'License has expired',
        expired_at: license.expires_at,
        should_retry: false
      });
    }

    if (!license.device_record_id) {
      return res.json({ 
        valid: false, 
        error: 'Device not activated',
        should_retry: false
      });
    }

    // Update last_seen timestamp
    await pool.query(
      'UPDATE license_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [license.device_record_id]
    );

    // Return license info with grace period
    res.json({ 
      valid: true,
      verified_at: new Date().toISOString(),
      license: {
        company_name: license.company_name,
        expires_at: license.expires_at,
        max_devices: license.max_devices,
        grace_period_days: license.grace_period_days,
        last_verified: new Date().toISOString()
      }
    });

  } catch (err) {
    console.error('License verification error:', err);
    res.status(500).json({ 
      valid: false, 
      error: 'Verification failed',
      should_retry: true // Network error, can retry
    });
  }
});

// Get license info (offline-friendly endpoint)
app.get('/api/licenses/info/:licenseKey', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT license_key, company_name, max_devices, grace_period_days, expires_at, is_active FROM licenses WHERE license_key = $1',
      [req.params.licenseKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'License not found' });
    }

    res.json({ license: result.rows[0] });
  } catch (err) {
    console.error('Error fetching license info:', err);
    res.status(500).json({ error: 'Failed to fetch license info' });
  }
});

// Deactivate device
app.post('/api/licenses/deactivate', async (req, res) => {
  const { license_key, device_id } = req.body;

  if (!license_key || !device_id) {
    return res.status(400).json({ error: 'License key and device ID required' });
  }

  try {
    const licenseResult = await pool.query(
      'SELECT id FROM licenses WHERE license_key = $1',
      [license_key]
    );

    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid license key' });
    }

    await pool.query(
      'DELETE FROM license_devices WHERE license_id = $1 AND device_id = $2',
      [licenseResult.rows[0].id, device_id]
    );

    res.json({ success: true, message: 'Device deactivated' });

  } catch (err) {
    console.error('Deactivation error:', err);
    res.status(500).json({ error: 'Deactivation failed' });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Grace Period Support: ENABLED`);
  await initDatabase();
});