const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const csv = require('csv-parser');
const { Readable } = require('stream');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Configure multer for memory storage
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

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Timber Inventory API with Categories',
    version: '3.0.0',
    status: 'running',
    endpoints: {
      upload: 'POST /api/upload',
      categories: 'GET /api/categories',
      datasets: 'GET /api/datasets?category=xxx',
      search: 'GET /api/search?q=xxx',
      data: 'GET /api/data/:filename',
      delete: 'DELETE /api/data/:id'
    }
  });
});

// Get all available categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT category 
      FROM csv_files 
      WHERE category IS NOT NULL 
      ORDER BY category
    `);
    
    const categories = result.rows.map(row => row.category);
    
    res.json({
      categories: categories,
      count: categories.length
    });
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Upload CSV endpoint with duplicate check
app.post('/api/upload', upload.single('file'), async (req, res) => {
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
        message: `Fișierul "${filename}" există deja în categoria "${category}"`,
        existingId: duplicateCheck.rows[0].id
      });
    }

    await client.query('BEGIN');

    // Insert file record
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

    // Insert data rows
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
    res.status(500).json({ error: 'Failed to upload file', details: err.message });
  } finally {
    client.release();
  }
});

// Get all datasets (with optional category filter)
app.get('/api/datasets', async (req, res) => {
  try {
    const category = req.query.category;
    
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
    
    query += ' GROUP BY f.id, f.filename, f.category, f.uploaded_at ORDER BY f.uploaded_at DESC';
    
    const result = await pool.query(query, params);

    res.json({
      datasets: result.rows,
      total: result.rows.length
    });
  } catch (err) {
    console.error('Error fetching datasets:', err);
    res.status(500).json({ error: 'Failed to fetch datasets' });
  }
});

// Search datasets
app.get('/api/search', async (req, res) => {
  try {
    const searchTerm = req.query.q;
    
    if (!searchTerm) {
      return res.status(400).json({ error: 'Search term required' });
    }

    const result = await pool.query(`
      SELECT 
        f.id,
        f.filename,
        f.category,
        f.uploaded_at,
        COUNT(d.id) as record_count
      FROM csv_files f
      LEFT JOIN csv_data d ON f.id = d.file_id
      WHERE 
        f.filename ILIKE $1 OR 
        f.category ILIKE $1
      GROUP BY f.id, f.filename, f.category, f.uploaded_at
      ORDER BY f.uploaded_at DESC
    `, [`%${searchTerm}%`]);

    res.json({
      results: result.rows,
      count: result.rows.length,
      searchTerm: searchTerm
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get data from specific dataset
app.get('/api/data/:filename', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.row_data
      FROM csv_data d
      JOIN csv_files f ON d.file_id = f.id
      WHERE f.filename = $1
      ORDER BY d.id
    `, [req.params.filename]);

    const data = result.rows.map(row => row.row_data);

    res.json({
      filename: req.params.filename,
      count: data.length,
      data: data
    });
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Delete dataset
app.delete('/api/data/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM csv_files WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Dataset deleted' });
  } catch (err) {
    console.error('Error deleting dataset:', err);
    res.status(500).json({ error: 'Failed to delete dataset' });
  }
});

// Sync all data (for Android)
app.get('/api/sync', async (req, res) => {
  try {
    const filesResult = await pool.query('SELECT id, filename, category FROM csv_files');
    const syncData = {};

    for (const file of filesResult.rows) {
      const dataResult = await pool.query(
        'SELECT row_data FROM csv_data WHERE file_id = $1',
        [file.id]
      );
      syncData[file.filename] = {
        category: file.category,
        data: dataResult.rows.map(r => r.row_data)
      };
    }

    res.json({
      timestamp: new Date().toISOString(),
      datasets: syncData
    });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initDatabase();
});