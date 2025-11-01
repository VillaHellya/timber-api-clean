-- ============================================================================
-- Multi-App Dashboard Migration
-- Version: 1.0
-- Date: 2025-11-01
-- Description: Adds multi-application support with company-app access control
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. APPLICATIONS REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  app_id VARCHAR(100) UNIQUE NOT NULL,
  app_name VARCHAR(255) NOT NULL,
  app_description TEXT,
  app_icon_url VARCHAR(500),
  app_color VARCHAR(7) DEFAULT '#667eea',
  landing_url VARCHAR(500),
  api_base_path VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  requires_license BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_applications_app_id ON applications(app_id);
CREATE INDEX IF NOT EXISTS idx_applications_active ON applications(is_active);

-- ============================================================================
-- 2. COMPANY-APPLICATION ACCESS CONTROL
-- ============================================================================

CREATE TABLE IF NOT EXISTS company_applications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  app_id VARCHAR(100) REFERENCES applications(app_id) ON DELETE CASCADE,
  is_enabled BOOLEAN DEFAULT true,
  max_devices INTEGER DEFAULT 3,
  license_expires_at TIMESTAMP,
  notes TEXT,
  activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_company_apps_company ON company_applications(company_id);
CREATE INDEX IF NOT EXISTS idx_company_apps_app ON company_applications(app_id);
CREATE INDEX IF NOT EXISTS idx_company_apps_active ON company_applications(is_enabled);

-- ============================================================================
-- 3. USER ACTIVITY TRACKING (OPTIONAL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_app_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  app_id VARCHAR(100) REFERENCES applications(app_id) ON DELETE CASCADE,
  session_token VARCHAR(500),
  accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_user ON user_app_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_app ON user_app_activity(app_id);
CREATE INDEX IF NOT EXISTS idx_activity_accessed ON user_app_activity(accessed_at);

-- ============================================================================
-- 4. SEED DATA - Register existing application
-- ============================================================================

INSERT INTO applications (
  app_id,
  app_name,
  app_description,
  app_icon_url,
  app_color,
  landing_url,
  api_base_path
) VALUES (
  'timber-inventory',
  'Forest Field Inventory',
  'Mobile inventory system for forest data collection with GPS tracking',
  '📊',
  '#667eea',
  '/apps/timber-inventory/',
  '/api/field-inventory'
)
ON CONFLICT (app_id) DO NOTHING;

-- ============================================================================
-- 5. GRANT ACCESS - All existing companies get timber-inventory
-- ============================================================================

INSERT INTO company_applications (company_id, app_id, is_enabled, activated_at)
SELECT
  id,
  'timber-inventory',
  true,
  CURRENT_TIMESTAMP
FROM companies
WHERE is_active = true
ON CONFLICT (company_id, app_id) DO NOTHING;

-- ============================================================================
-- 6. UPDATE EXISTING TABLES - Add app_id reference (SAFE)
-- ============================================================================

-- Add app_id to field_inventory_sessions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='field_inventory_sessions' AND column_name='app_id'
  ) THEN
    ALTER TABLE field_inventory_sessions
    ADD COLUMN app_id VARCHAR(100) DEFAULT 'timber-inventory' REFERENCES applications(app_id);

    CREATE INDEX idx_field_sessions_app ON field_inventory_sessions(app_id);

    RAISE NOTICE 'Added app_id to field_inventory_sessions';
  ELSE
    RAISE NOTICE 'app_id already exists in field_inventory_sessions';
  END IF;
END $$;

-- Add app_id to field_trees
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='field_trees' AND column_name='app_id'
  ) THEN
    ALTER TABLE field_trees
    ADD COLUMN app_id VARCHAR(100) DEFAULT 'timber-inventory' REFERENCES applications(app_id);

    CREATE INDEX idx_field_trees_app ON field_trees(app_id);

    RAISE NOTICE 'Added app_id to field_trees';
  ELSE
    RAISE NOTICE 'app_id already exists in field_trees';
  END IF;
END $$;

-- ============================================================================
-- 7. PERFORMANCE INDEXES - Optimize multi-app queries
-- ============================================================================

-- Compound index for common query pattern: company + app + date
CREATE INDEX IF NOT EXISTS idx_field_sessions_company_app_date
ON field_inventory_sessions(company_id, app_id, synced_at DESC)
WHERE company_id IS NOT NULL;

-- Partial index for active company-app relationships
CREATE INDEX IF NOT EXISTS idx_company_apps_active_lookup
ON company_applications(company_id, app_id, is_enabled)
WHERE is_enabled = true;

-- ============================================================================
-- 8. VIEWS - Convenience views for common queries
-- ============================================================================

CREATE OR REPLACE VIEW v_company_app_access AS
SELECT
  ca.company_id,
  c.name as company_name,
  c.is_active as company_active,
  ca.app_id,
  a.app_name,
  a.app_description,
  a.app_icon_url,
  a.app_color,
  a.landing_url,
  ca.is_enabled as app_enabled,
  ca.max_devices,
  ca.license_expires_at,
  ca.last_activity,
  COUNT(DISTINCT ld.device_id) as active_devices
FROM company_applications ca
JOIN companies c ON ca.company_id = c.id
JOIN applications a ON ca.app_id = a.app_id
LEFT JOIN licenses l ON l.company_id = ca.company_id AND (l.app_id = ca.app_id OR l.app_id = '*')
LEFT JOIN license_devices ld ON ld.license_id = l.id
WHERE ca.is_enabled = true AND a.is_active = true
GROUP BY ca.id, c.name, c.is_active, a.app_name, a.app_description, a.app_icon_url, a.app_color, a.landing_url;

-- ============================================================================
-- 9. VERIFICATION QUERIES
-- ============================================================================

DO $$
DECLARE
  app_count INTEGER;
  company_app_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO app_count FROM applications;
  SELECT COUNT(*) INTO company_app_count FROM company_applications;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'Migration completed successfully!';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Applications registered: %', app_count;
  RAISE NOTICE 'Company-app relationships: %', company_app_count;
  RAISE NOTICE '========================================';
END $$;

-- ============================================================================
-- 10. ROLLBACK SCRIPT (for reference - don't execute)
-- ============================================================================

-- To rollback this migration, run:
-- BEGIN;
-- DROP VIEW IF EXISTS v_company_app_access CASCADE;
-- DROP TABLE IF EXISTS user_app_activity CASCADE;
-- DROP TABLE IF EXISTS company_applications CASCADE;
-- DROP TABLE IF EXISTS applications CASCADE;
-- ALTER TABLE field_inventory_sessions DROP COLUMN IF EXISTS app_id;
-- ALTER TABLE field_trees DROP COLUMN IF EXISTS app_id;
-- COMMIT;

COMMIT;

-- Success message
SELECT 'Multi-app dashboard migration completed successfully!' as status;
