-- ============================================================================
-- RULEAZĂ ACEST SCRIPT ÎN RAILWAY DASHBOARD → POSTGRESQL → QUERY TAB
-- ============================================================================
-- Aceasta este versiunea simplificată a migrării pentru executare manuală
-- ============================================================================

BEGIN;

-- 1. APPLICATIONS TABLE
CREATE TABLE IF NOT EXISTS applications (
  app_id VARCHAR(100) PRIMARY KEY,
  app_name VARCHAR(255) NOT NULL,
  app_description TEXT,
  app_icon_url VARCHAR(500),
  app_color VARCHAR(20) DEFAULT '#667eea',
  landing_url VARCHAR(500) NOT NULL,
  api_base_path VARCHAR(200),
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. COMPANY_APPLICATIONS TABLE
CREATE TABLE IF NOT EXISTS company_applications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_id VARCHAR(100) NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  is_enabled BOOLEAN DEFAULT true,
  max_devices INTEGER,
  license_expires_at TIMESTAMP,
  notes TEXT,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by INTEGER REFERENCES users(id),
  last_activity TIMESTAMP,
  UNIQUE(company_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_company_apps_company ON company_applications(company_id);
CREATE INDEX IF NOT EXISTS idx_company_apps_app ON company_applications(app_id);
CREATE INDEX IF NOT EXISTS idx_company_apps_enabled ON company_applications(is_enabled);

-- 3. USER_APPLICATIONS TABLE
CREATE TABLE IF NOT EXISTS user_applications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id VARCHAR(100) NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
  access_type VARCHAR(20) NOT NULL DEFAULT 'inherit',
  is_enabled BOOLEAN DEFAULT true,
  notes TEXT,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by INTEGER REFERENCES users(id),
  UNIQUE(user_id, app_id),
  CONSTRAINT check_access_type CHECK (access_type IN ('inherit', 'allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_apps_app ON user_applications(app_id);

-- 4. USER_APP_ACTIVITY TABLE
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

-- 5. SEED TIMBER-INVENTORY APP
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

-- 6. GRANT ACCESS TO ALL ACTIVE COMPANIES
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
-- VERIFICARE (rulează acestea DUPĂ ce ai rulat scriptul de mai sus)
-- ============================================================================

-- Verificare 1: Tabelele au fost create?
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE '%app%'
ORDER BY table_name;

-- Verificare 2: Aplicația timber-inventory este înregistrată?
SELECT * FROM applications;

-- Verificare 3: Câte companii au acces?
SELECT COUNT(*) as companies_with_access
FROM company_applications
WHERE app_id = 'timber-inventory';

-- Verificare 4: Detalii acces companii
SELECT c.name, ca.is_enabled, ca.granted_at
FROM company_applications ca
JOIN companies c ON ca.company_id = c.id
WHERE ca.app_id = 'timber-inventory'
ORDER BY c.name;
