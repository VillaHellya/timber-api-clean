-- ============================================================================
-- MULTI-APP DASHBOARD - HYBRID ACCESS CONTROL MIGRATION
-- ============================================================================
-- Această migrare adaugă suport pentru:
-- 1. Registru aplicații (applications)
-- 2. Acces la nivel de companie (company_applications)
-- 3. Acces la nivel de user - override (user_applications)
-- 4. Analytics activitate (user_app_activity)
--
-- SAFE: Verifică existența fiecărei tabele înainte de creare
-- IDEMPOTENT: Poate fi rulat de multiple ori fără probleme
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. TABELA APPLICATIONS - Registru aplicații disponibile
-- ============================================================================
CREATE TABLE IF NOT EXISTS applications (
  app_id VARCHAR(100) PRIMARY KEY,
  app_name VARCHAR(255) NOT NULL,
  app_description TEXT,
  app_icon_url VARCHAR(500),              -- URL sau emoji (🌲, 📊, etc.)
  app_color VARCHAR(20) DEFAULT '#667eea', -- Culoare hex pentru UI
  landing_url VARCHAR(500) NOT NULL,      -- URL interfață (/apps/timber-inventory/)
  api_base_path VARCHAR(200),             -- Path API (/api/field-inventory)
  is_active BOOLEAN DEFAULT true,         -- Poate fi dezactivată global
  display_order INTEGER DEFAULT 0,        -- Ordine afișare în dashboard
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE applications IS 'Registru central al tuturor aplicațiilor disponibile în sistem';
COMMENT ON COLUMN applications.app_id IS 'Identificator unic (ex: timber-inventory, control-anual)';
COMMENT ON COLUMN applications.app_icon_url IS 'Emoji sau URL imagine pentru card în dashboard';
COMMENT ON COLUMN applications.landing_url IS 'URL către interfața web a aplicației';

-- ============================================================================
-- 2. TABELA COMPANY_APPLICATIONS - Acces la nivel de companie
-- ============================================================================
CREATE TABLE IF NOT EXISTS company_applications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_id VARCHAR(100) NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  is_enabled BOOLEAN DEFAULT true,        -- Compania are acces la app?
  max_devices INTEGER,                    -- Limită dispozitive pentru această companie (override)
  license_expires_at TIMESTAMP,           -- Expirare acces la app (opțional)
  notes TEXT,                             -- Note admin
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by INTEGER REFERENCES users(id), -- Care admin a acordat accesul
  last_activity TIMESTAMP,                -- Ultima sincronizare de la această companie

  UNIQUE(company_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_company_apps_company ON company_applications(company_id);
CREATE INDEX IF NOT EXISTS idx_company_apps_app ON company_applications(app_id);
CREATE INDEX IF NOT EXISTS idx_company_apps_enabled ON company_applications(is_enabled);

COMMENT ON TABLE company_applications IS 'Control acces la aplicații la nivel de COMPANIE';
COMMENT ON COLUMN company_applications.is_enabled IS 'true = Toți userii din companie au acces implicit';

-- ============================================================================
-- 3. TABELA USER_APPLICATIONS - Override la nivel de user
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_applications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id VARCHAR(100) NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  access_type VARCHAR(20) NOT NULL DEFAULT 'inherit', -- 'inherit', 'allow', 'deny'
  is_enabled BOOLEAN DEFAULT true,        -- Dacă access_type = 'allow'/'deny', acest flag controlează
  notes TEXT,                             -- Motivul override-ului
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by INTEGER REFERENCES users(id), -- Care admin a făcut override-ul

  UNIQUE(user_id, app_id),

  CONSTRAINT check_access_type CHECK (access_type IN ('inherit', 'allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_apps_app ON user_applications(app_id);

COMMENT ON TABLE user_applications IS 'Override acces la nivel de USER individual';
COMMENT ON COLUMN user_applications.access_type IS '
  inherit = moștenește de la company_applications (default)
  allow   = acordă acces CHIAR DACĂ compania nu are
  deny    = interzice acces CHIAR DACĂ compania are
';

-- ============================================================================
-- 4. TABELA USER_APP_ACTIVITY - Analytics și tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_app_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id VARCHAR(100) NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER DEFAULT 1,
  last_ip VARCHAR(50),
  user_agent TEXT,

  UNIQUE(user_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_user_activity_user ON user_app_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_app ON user_app_activity(app_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_last ON user_app_activity(last_accessed);

COMMENT ON TABLE user_app_activity IS 'Tracking utilizare aplicații pentru analytics';

-- ============================================================================
-- 5. SEED DATA - Înregistrare aplicație existentă
-- ============================================================================

-- Înregistrare Timber Inventory (aplicația existentă)
INSERT INTO applications (
  app_id,
  app_name,
  app_description,
  app_icon_url,
  app_color,
  landing_url,
  api_base_path,
  is_active,
  display_order
) VALUES (
  'timber-inventory',
  'Inventar Forestier',
  'Sincronizare date inventar din teren - arbori, volume, specii',
  '🌲',
  '#51cf66',
  '/apps/timber-inventory/',
  '/api/field-inventory',
  true,
  1
) ON CONFLICT (app_id) DO UPDATE SET
  app_name = EXCLUDED.app_name,
  app_description = EXCLUDED.app_description,
  app_icon_url = EXCLUDED.app_icon_url,
  app_color = EXCLUDED.app_color,
  landing_url = EXCLUDED.landing_url,
  api_base_path = EXCLUDED.api_base_path,
  updated_at = CURRENT_TIMESTAMP;

-- Acordă acces TUTUROR companiilor existente la Timber Inventory
-- (menține compatibilitatea cu sistemul actual)
INSERT INTO company_applications (company_id, app_id, is_enabled, granted_at)
SELECT
  id,
  'timber-inventory',
  true,
  CURRENT_TIMESTAMP
FROM companies
WHERE is_active = true
ON CONFLICT (company_id, app_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- ROLLBACK SCRIPT (rulează doar dacă vrei să anulezi migrarea)
-- ============================================================================
/*
BEGIN;
DROP TABLE IF EXISTS user_app_activity CASCADE;
DROP TABLE IF EXISTS user_applications CASCADE;
DROP TABLE IF EXISTS company_applications CASCADE;
DROP TABLE IF EXISTS applications CASCADE;
COMMIT;
*/

-- ============================================================================
-- QUERY-URI UTILE DUPĂ MIGRARE
-- ============================================================================

-- Verificare tabele create
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE '%app%';

-- Verificare aplicații înregistrate
-- SELECT * FROM applications;

-- Verificare acces companii
-- SELECT c.name, ca.app_id, ca.is_enabled
-- FROM company_applications ca
-- JOIN companies c ON ca.company_id = c.id;

-- Verificare override-uri useri
-- SELECT u.username, ua.app_id, ua.access_type, ua.is_enabled
-- FROM user_applications ua
-- JOIN users u ON ua.user_id = u.id;
