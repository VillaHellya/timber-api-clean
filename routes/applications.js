/**
 * Applications API Routes
 *
 * Handles application discovery, registration, and management
 * for the multi-app dashboard system.
 *
 * Endpoints:
 *   GET  /api/applications              - List apps user can access
 *   GET  /api/applications/:app_id      - Get specific app details
 *   POST /api/admin/applications        - Register new app (admin only)
 *   PUT  /api/admin/applications/:id    - Update app (admin only)
 *   GET  /api/admin/company-apps        - Manage company-app access (admin)
 *   POST /api/admin/company-apps        - Grant company access to app (admin)
 */

const express = require('express');
const router = express.Router();

// Pool will be accessed via req.app.locals.pool (set in server.js)
// Middleware will be applied in server.js
// Assumes authenticateToken middleware is available on protected routes

/**
 * GET /api/applications
 * Returns list of applications the current user has access to
 *
 * Access:
 *   - Admin: sees all active apps
 *   - User: sees only apps their company has access to
 */
router.get('/', async (req, res) => {
  try {
    // Verify user is authenticated (set by authenticateToken middleware)
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    let query;
    const params = [];

    if (req.user.role === 'admin') {
      // Admin sees all active applications with aggregated stats
      query = `
        SELECT
          a.app_id,
          a.app_name,
          a.app_description,
          a.app_icon_url,
          a.app_color,
          a.landing_url,
          a.api_base_path,
          a.is_active,
          COUNT(DISTINCT ca.company_id) as companies_count,
          COUNT(DISTINCT ld.device_id) as total_devices
        FROM applications a
        LEFT JOIN company_applications ca ON a.app_id = ca.app_id AND ca.is_enabled = true
        LEFT JOIN licenses l ON l.app_id = a.app_id
        LEFT JOIN license_devices ld ON ld.license_id = l.id
        WHERE a.is_active = true
        GROUP BY a.id
        ORDER BY a.app_name
      `;
    } else {
      // Regular users see only apps their company has access to
      const userResult = await req.app.locals.pool.query(
        'SELECT company_id FROM users WHERE id = $1',
        [req.user.id]
      );

      if (!userResult.rows[0]?.company_id) {
        return res.status(403).json({
          error: 'User not associated with a company',
          message: 'Your account must be linked to a company to access applications'
        });
      }

      const companyId = userResult.rows[0].company_id;

      query = `
        SELECT
          a.app_id,
          a.app_name,
          a.app_description,
          a.app_icon_url,
          a.app_color,
          a.landing_url,
          ca.last_activity,
          ca.license_expires_at,
          CASE
            WHEN ca.license_expires_at IS NOT NULL AND ca.license_expires_at < NOW()
            THEN true
            ELSE false
          END as is_expired
        FROM applications a
        JOIN company_applications ca ON a.app_id = ca.app_id
        WHERE a.is_active = true
          AND ca.is_enabled = true
          AND ca.company_id = $1
        ORDER BY a.app_name
      `;
      params.push(companyId);
    }

    const result = await req.app.locals.pool.query(query, params);

    res.json({
      success: true,
      applications: result.rows,
      count: result.rows.length,
      user: {
        username: req.user.username,
        full_name: req.user.full_name,
        role: req.user.role
      }
    });

  } catch (err) {
    console.error('Error fetching applications:', err);
    res.status(500).json({
      error: 'Failed to fetch applications',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * GET /api/applications/:app_id
 * Get detailed information about a specific application
 */
router.get('/:app_id', async (req, res) => {
  const { app_id } = req.params;

  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user has access to this app (unless admin)
    let accessQuery;
    const params = [app_id];

    if (req.user.role === 'admin') {
      accessQuery = `
        SELECT
          a.*,
          COUNT(DISTINCT ca.company_id) as companies_with_access,
          COUNT(DISTINCT ld.device_id) as total_active_devices
        FROM applications a
        LEFT JOIN company_applications ca ON a.app_id = ca.app_id AND ca.is_enabled = true
        LEFT JOIN licenses l ON l.app_id = a.app_id
        LEFT JOIN license_devices ld ON ld.license_id = l.id
        WHERE a.app_id = $1
        GROUP BY a.id
      `;
    } else {
      const userResult = await req.app.locals.pool.query(
        'SELECT company_id FROM users WHERE id = $1',
        [req.user.id]
      );

      if (!userResult.rows[0]?.company_id) {
        return res.status(403).json({ error: 'User not associated with a company' });
      }

      const companyId = userResult.rows[0].company_id;

      accessQuery = `
        SELECT
          a.*,
          ca.is_enabled,
          ca.last_activity,
          ca.license_expires_at
        FROM applications a
        JOIN company_applications ca ON a.app_id = ca.app_id
        WHERE a.app_id = $1
          AND ca.company_id = $2
          AND ca.is_enabled = true
      `;
      params.push(companyId);
    }

    const result = await req.app.locals.pool.query(accessQuery, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Application not found or access denied',
        app_id: app_id
      });
    }

    res.json({
      success: true,
      application: result.rows[0]
    });

  } catch (err) {
    console.error('Error fetching application details:', err);
    res.status(500).json({ error: 'Failed to fetch application details' });
  }
});

/**
 * POST /api/admin/applications
 * Register a new application in the system
 *
 * Body:
 *   - app_id (required): Unique identifier (e.g., 'control-anual')
 *   - app_name (required): Display name (e.g., 'Annual Control')
 *   - app_description: Description text
 *   - app_icon_url: Icon emoji or URL
 *   - app_color: Hex color code (e.g., '#51cf66')
 *   - landing_url: Frontend URL (e.g., '/apps/control-anual/')
 *   - api_base_path: API prefix (e.g., '/api/control-anual')
 */
router.post('/admin/applications', async (req, res) => {
  // Admin check
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const {
    app_id,
    app_name,
    app_description,
    app_icon_url,
    app_color,
    landing_url,
    api_base_path,
    requires_license
  } = req.body;

  // Validation
  if (!app_id || !app_name) {
    return res.status(400).json({
      error: 'app_id and app_name are required',
      received: { app_id, app_name }
    });
  }

  // Validate app_id format (lowercase, alphanumeric with hyphens)
  if (!/^[a-z0-9-]+$/.test(app_id)) {
    return res.status(400).json({
      error: 'app_id must be lowercase alphanumeric with hyphens only',
      example: 'control-anual'
    });
  }

  try {
    const result = await req.app.locals.pool.query(`
      INSERT INTO applications (
        app_id,
        app_name,
        app_description,
        app_icon_url,
        app_color,
        landing_url,
        api_base_path,
        requires_license
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      app_id,
      app_name,
      app_description || null,
      app_icon_url || '📱',
      app_color || '#667eea',
      landing_url || `/apps/${app_id}/`,
      api_base_path || `/api/${app_id}`,
      requires_license !== false
    ]);

    res.json({
      success: true,
      application: result.rows[0],
      message: `Application '${app_name}' registered successfully`
    });

  } catch (err) {
    if (err.constraint === 'applications_app_id_key') {
      return res.status(409).json({
        error: 'Application ID already exists',
        app_id: app_id
      });
    }

    console.error('Error registering application:', err);
    res.status(500).json({
      error: 'Failed to register application',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * PUT /api/admin/applications/:app_id
 * Update an existing application
 */
router.put('/admin/applications/:app_id', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { app_id } = req.params;
  const {
    app_name,
    app_description,
    app_icon_url,
    app_color,
    landing_url,
    api_base_path,
    is_active
  } = req.body;

  try {
    const result = await req.app.locals.pool.query(`
      UPDATE applications
      SET
        app_name = COALESCE($1, app_name),
        app_description = COALESCE($2, app_description),
        app_icon_url = COALESCE($3, app_icon_url),
        app_color = COALESCE($4, app_color),
        landing_url = COALESCE($5, landing_url),
        api_base_path = COALESCE($6, api_base_path),
        is_active = COALESCE($7, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE app_id = $8
      RETURNING *
    `, [app_name, app_description, app_icon_url, app_color, landing_url, api_base_path, is_active, app_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({
      success: true,
      application: result.rows[0],
      message: 'Application updated successfully'
    });

  } catch (err) {
    console.error('Error updating application:', err);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

/**
 * GET /api/admin/company-apps
 * Get all company-application access relationships
 */
router.get('/admin/company-apps', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = await req.app.locals.pool.query(`
      SELECT
        ca.*,
        c.name as company_name,
        a.app_name,
        COUNT(DISTINCT ld.device_id) as active_devices
      FROM company_applications ca
      JOIN companies c ON ca.company_id = c.id
      JOIN applications a ON ca.app_id = a.app_id
      LEFT JOIN licenses l ON l.company_id = ca.company_id AND l.app_id = ca.app_id
      LEFT JOIN license_devices ld ON ld.license_id = l.id
      GROUP BY ca.id, c.name, a.app_name
      ORDER BY c.name, a.app_name
    `);

    res.json({
      success: true,
      company_apps: result.rows,
      total: result.rows.length
    });

  } catch (err) {
    console.error('Error fetching company-app relationships:', err);
    res.status(500).json({ error: 'Failed to fetch company-app access' });
  }
});

/**
 * POST /api/admin/company-apps
 * Grant a company access to an application
 *
 * Body:
 *   - company_id (required)
 *   - app_id (required)
 *   - max_devices (optional, default: 3)
 *   - license_expires_at (optional)
 */
router.post('/admin/company-apps', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { company_id, app_id, max_devices, license_expires_at, notes } = req.body;

  if (!company_id || !app_id) {
    return res.status(400).json({
      error: 'company_id and app_id are required'
    });
  }

  try {
    const result = await req.app.locals.pool.query(`
      INSERT INTO company_applications
        (company_id, app_id, max_devices, license_expires_at, notes, is_enabled)
      VALUES ($1, $2, $3, $4, $5, true)
      ON CONFLICT (company_id, app_id)
      DO UPDATE SET
        is_enabled = true,
        max_devices = EXCLUDED.max_devices,
        license_expires_at = EXCLUDED.license_expires_at,
        notes = EXCLUDED.notes
      RETURNING *
    `, [company_id, app_id, max_devices || 3, license_expires_at || null, notes || null]);

    res.json({
      success: true,
      company_app: result.rows[0],
      message: 'Company access granted successfully'
    });

  } catch (err) {
    console.error('Error granting company app access:', err);
    res.status(500).json({
      error: 'Failed to grant access',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * DELETE /api/admin/company-apps/:id
 * Revoke company access to an application
 */
router.delete('/admin/company-apps/:id', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;

  try {
    const result = await req.app.locals.pool.query(`
      UPDATE company_applications
      SET is_enabled = false
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company-app relationship not found' });
    }

    res.json({
      success: true,
      message: 'Company access revoked successfully'
    });

  } catch (err) {
    console.error('Error revoking company app access:', err);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

module.exports = router;
