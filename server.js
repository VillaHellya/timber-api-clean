const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Directory unde sunt CSV-urile
const DATA_DIR = path.join(__dirname, 'data');

// Cache pentru datele încărcate
let dataCache = {};
let lastLoadTime = null;

/**
 * Funcție generică care citește ORICE fișier CSV
 * și returnează un array cu obiectele parsate
 */
function loadCSV(filename) {
  return new Promise((resolve, reject) => {
    const results = [];
    const filePath = path.join(DATA_DIR, filename);
    
    // Verifică dacă fișierul există
    if (!fs.existsSync(filePath)) {
      reject(new Error(`Fișierul ${filename} nu există`));
      return;
    }

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
}

/**
 * Încarcă TOATE fișierele CSV din folderul data/
 * și le pune în cache
 */
async function loadAllCSVFiles() {
  console.log('📂 Încărcare fișiere CSV...');
  
  try {
    // Verifică dacă directorul există
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log('✅ Director data/ creat');
    }

    // Găsește toate fișierele .csv
    const files = fs.readdirSync(DATA_DIR).filter(file => file.endsWith('.csv'));
    
    if (files.length === 0) {
      console.log('⚠️  Nu există fișiere CSV în folderul data/');
      console.log('📝 Adaugă fișierele tale CSV în:', DATA_DIR);
      return;
    }

    // Încarcă fiecare fișier
    for (const file of files) {
      const dataName = file.replace('.csv', '');
      dataCache[dataName] = await loadCSV(file);
      console.log(`✅ ${file}: ${dataCache[dataName].length} înregistrări`);
    }

    lastLoadTime = new Date();
    console.log('🎉 Toate fișierele CSV au fost încărcate!\n');
    
  } catch (error) {
    console.error('❌ Eroare la încărcarea CSV-urilor:', error.message);
  }
}

// Încarcă datele la pornirea serverului
loadAllCSVFiles();

// ============================================
// ENDPOINTS API
// ============================================

/**
 * Health check
 */
app.get('/', (req, res) => {
  res.json({
    message: 'Timber Inventory API',
    version: '1.0.0',
    status: 'running',
    availableDatasets: Object.keys(dataCache),
    totalRecords: Object.values(dataCache).reduce((sum, arr) => sum + arr.length, 0),
    lastLoaded: lastLoadTime
  });
});

/**
 * Listează toate dataset-urile disponibile
 * GET /api/datasets
 */
app.get('/api/datasets', (req, res) => {
  const datasets = Object.keys(dataCache).map(name => ({
    name: name,
    records: dataCache[name].length,
    fields: dataCache[name][0] ? Object.keys(dataCache[name][0]) : []
  }));

  res.json({
    datasets: datasets,
    lastLoaded: lastLoadTime
  });
});

/**
 * Obține toate datele dintr-un dataset
 * GET /api/data/:datasetName
 * 
 * Exemplu: GET /api/data/volume-unitare
 */
app.get('/api/data/:datasetName', (req, res) => {
  const { datasetName } = req.params;
  
  if (!dataCache[datasetName]) {
    return res.status(404).json({
      error: 'Dataset nu există',
      availableDatasets: Object.keys(dataCache)
    });
  }

  res.json({
    dataset: datasetName,
    count: dataCache[datasetName].length,
    data: dataCache[datasetName]
  });
});

/**
 * Filtrare date după un câmp specific
 * GET /api/data/:datasetName/filter?field=value
 * 
 * Exemplu: GET /api/data/volume-unitare/filter?specie=Molid
 */
app.get('/api/data/:datasetName/filter', (req, res) => {
  const { datasetName } = req.params;
  const filters = req.query;
  
  if (!dataCache[datasetName]) {
    return res.status(404).json({
      error: 'Dataset nu există'
    });
  }

  // Filtrează datele
  let filtered = dataCache[datasetName];
  
  Object.keys(filters).forEach(key => {
    filtered = filtered.filter(item => {
      // Compară case-insensitive
      return String(item[key]).toLowerCase() === String(filters[key]).toLowerCase();
    });
  });

  res.json({
    dataset: datasetName,
    filters: filters,
    count: filtered.length,
    data: filtered
  });
});

/**
 * Sincronizare completă - returnează TOATE datele
 * GET /api/sync
 */
app.get('/api/sync', (req, res) => {
  res.json({
    timestamp: new Date(),
    datasets: dataCache
  });
});

/**
 * Reîncarcă datele din CSV-uri (fără restart server)
 * POST /api/reload
 */
app.post('/api/reload', async (req, res) => {
  try {
    await loadAllCSVFiles();
    res.json({
      message: 'Datele au fost reîncărcate cu succes',
      datasets: Object.keys(dataCache),
      timestamp: lastLoadTime
    });
  } catch (error) {
    res.status(500).json({
      error: 'Eroare la reîncărcarea datelor',
      message: error.message
    });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log('🌲 ================================');
  console.log('🌲 Timber Inventory API');
  console.log('🌲 ================================');
  console.log(`🚀 Server pornit pe: http://localhost:${PORT}`);
  console.log(`📊 Datasets disponibile: ${Object.keys(dataCache).length}`);
  console.log('🌲 ================================\n');
  console.log('📖 Endpoints disponibile:');
  console.log(`   GET  /                              - Info server`);
  console.log(`   GET  /api/datasets                  - Lista datasets`);
  console.log(`   GET  /api/data/:datasetName         - Toate datele`);
  console.log(`   GET  /api/data/:name/filter?field=  - Filtrare`);
  console.log(`   GET  /api/sync                      - Sincronizare totală`);
  console.log(`   POST /api/reload                    - Reîncarcă CSV-uri`);
  console.log('\n');
});
