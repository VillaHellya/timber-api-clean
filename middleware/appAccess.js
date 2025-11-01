/**
 * ============================================================================
 * MULTI-APP DASHBOARD - HYBRID ACCESS CONTROL MIDDLEWARE
 * ============================================================================
 *
 * Middleware pentru verificarea accesului la aplicații:
 * - Nivel 1: company_applications (acces la nivel de companie)
 * - Nivel 2: user_applications (override la nivel de user)
 * - Admin bypass: Adminii au acces la toate aplicațiile
 *
 * Logica Hibridă:
 * 1. Dacă user.role === 'admin' → PERMITE (bypass complet)
 * 2. Verifică user_applications pentru override
 *    - access_type = 'allow' AND is_enabled = true → PERMITE
 *    - access_type = 'deny' → INTERZICE
 *    - access_type = 'inherit' → Continuă la verificare companie
 * 3. Verifică company_applications
 *    - is_enabled = true → PERMITE
 *    - is_enabled = false sau lipsă → INTERZICE
 *
 * ============================================================================
 */

/**
 * Middleware: Verificare acces la aplicație (Hybrid Access Control)
 */
function checkAppAccess(pool, app_id) {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;
      const userRole = req.user.role;

      // BYPASS 1: Adminii au acces la toate aplicațiile
      if (userRole === 'admin') {
        req.app_context = {
          access_level: 'admin',
          app_id: app_id,
          company_id: null,
          bypass: true
        };
        return next();
      }

      // Obține company_id al userului
      const userInfo = await pool.query(
        'SELECT company_id FROM users WHERE id = $1',
        [userId]
      );

      if (userInfo.rows.length === 0 || !userInfo.rows[0].company_id) {
        return res.status(403).json({
          success: false,
          error: 'User not associated with any company'
        });
      }

      const companyId = userInfo.rows[0].company_id;

      // NIVEL 2: Verificare override la nivel de user
      const userOverride = await pool.query(`
        SELECT access_type, is_enabled
        FROM user_applications
        WHERE user_id = $1 AND app_id = $2
      `, [userId, app_id]);

      if (userOverride.rows.length > 0) {
        const override = userOverride.rows[0];

        if (override.access_type === 'allow' && override.is_enabled) {
          req.app_context = {
            access_level: 'user_override_allow',
            app_id: app_id,
            company_id: companyId,
            bypass: false
          };
          return next();
        }

        if (override.access_type === 'deny') {
          return res.status(403).json({
            success: false,
            error: 'Access denied by user override'
          });
        }
      }

      // NIVEL 1: Verificare acces la nivel de companie
      const companyAccess = await pool.query(`
        SELECT ca.is_enabled, ca.license_expires_at, a.app_name
        FROM company_applications ca
        JOIN applications a ON ca.app_id = a.app_id
        WHERE ca.company_id = $1 AND ca.app_id = $2
      `, [companyId, app_id]);

      if (companyAccess.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Application not available for your company'
        });
      }

      const access = companyAccess.rows[0];

      if (!access.is_enabled) {
        return res.status(403).json({
          success: false,
          error: 'Application access disabled'
        });
      }

      if (access.license_expires_at) {
        const expiryDate = new Date(access.license_expires_at);
        if (new Date() > expiryDate) {
          return res.status(403).json({
            success: false,
            error: 'License expired'
          });
        }
      }

      req.app_context = {
        access_level: 'company',
        app_id: app_id,
        company_id: companyId,
        app_name: access.app_name,
        bypass: false
      };

      next();

    } catch (err) {
      console.error('App access check error:', err);
      return res.status(500).json({
        success: false,
        error: 'Access verification failed'
      });
    }
  };
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }
  next();
}

module.exports = {
  checkAppAccess,
  requireAdmin
};
