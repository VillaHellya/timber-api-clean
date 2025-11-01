# 🚀 Multi-App Dashboard System - Ghid Complet

## 📋 Ce Am Implementat

Sistem complet de dashboard multi-aplicații cu control acces hibrid (companie + utilizator) pentru platforma timber-api.

### ✨ Funcționalități Principale

1. **Dashboard Centralizat** - Un singur login pentru toate aplicațiile
2. **Control Acces Hibrid** - Nivel companie + override-uri individuale pentru utilizatori
3. **Panel Admin Complet** - Gestionare aplicații, acces companii, override-uri utilizatori
4. **Arhitectură Extensibilă** - Adaugi o aplicație nouă în ~4 ore
5. **Securitate Multi-Tenant** - Fiecare companie vede doar datele sale

---

## 🗂️ Structură Fișiere

```
timber-api-clean/
├── server.js                    ✅ Actualizat (înregistrare routes)
├── routes/
│   └── applications.js          ✅ NOU - API pentru aplicații
├── middleware/
│   └── appAccess.js             ✅ NOU - Control acces hibrid
├── migrations/
│   └── 001_multi_app_hybrid_access.sql  ✅ NOU - Migrare DB
├── public/
│   ├── index.html               ✅ NOU - Login page
│   ├── dashboard.html           ✅ NOU - App launcher
│   ├── admin-apps.html          ✅ NOU - Panel admin
│   ├── csv-upload.html          (redenumit din index.html)
│   ├── field-inventory.html     (păstrat pentru backward compatibility)
│   └── apps/
│       └── timber-inventory/
│           └── index.html       ✅ NOU - Copie field-inventory.html
└── README_MULTI_APP.md          ✅ Acest fișier
```

---

## 🔐 Sistem de Autentificare

### Login
**URL**: `https://timber-api-clean-production.up.railway.app/`

**Credențiale Default**:
- Username: `admin`
- Password: `admin123`

**Flow**:
1. Introduci username/password
2. Server returnează JWT token
3. Token salvat în `localStorage`
4. Redirect la `/dashboard.html`

### Logout
Click butonul "🚪 Deconectare" din orice pagină → șterge token → redirect la login

---

## 🎯 Control Acces Hibrid

### Nivel 1: Companie (company_applications)
Administrator acordă **acces la nivel de companie**:
```
Compania "ACME Forestry" are acces la:
  ✅ Timber Inventory
  ❌ Control Anual (disabled)
```
→ **Toți utilizatorii** din ACME văd doar Timber Inventory

### Nivel 2: Override Utilizator (user_applications)
Administrator poate face **override la nivel individual**:

**3 Tipuri de Override**:
1. **inherit** (default) - Utilizatorul moștenește accesul companiei
2. **allow** - Acordă acces CHIAR DACĂ compania nu are
3. **deny** - Interzice acces CHIAR DACĂ compania are

**Exemplu**:
```
Compania ACME: Timber Inventory = ❌ disabled
User Ion Popescu: Timber Inventory = ✅ allow

→ Ion vede Timber Inventory (override allow)
→ Ceilalți din ACME NU văd (company disabled)
```

### Nivel 3: Admin Bypass
**Utilizatori cu rol 'admin'** au acces la TOATE aplicațiile, indiferent de setări.

---

## 📱 Interfețe Utilizator

### 1. Login Page (`/`)
- Design modern cu gradient violet
- Validare username/password
- Mesaje de eroare user-friendly
- Auto-redirect dacă deja autentificat

### 2. Dashboard (`/dashboard.html`)
**Pentru utilizatori normali**:
- Card-uri colorate pentru fiecare aplicație disponibilă
- Click → navigare la aplicație
- Afișare nume complet utilizator + companie
- Buton logout

**Pentru admini**:
- Același dashboard + buton "⚙️ Admin Panel"

### 3. Panel Admin (`/admin-apps.html`)
**DOAR pentru admini** (redirect non-admini)

**4 Tab-uri**:

#### Tab 1: Overview
- Statistici: Total Apps, Companii cu Acces, Override-uri

#### Tab 2: Gestionare Aplicații
- Tabel cu toate aplicațiile
- Buton "+ Adaugă Aplicație"
- Form: app_id, nume, descriere, icon, culoare, URL, etc.
- Edit/Delete aplicații existente

#### Tab 3: Acces Companii
- Tabel: Companie × Aplicație
- Buton "Acordă Acces" → Modal cu form:
  - Selectează companie
  - Selectează aplicație
  - Max devices (override)
  - Expirare licență (opțional)
  - Note
- Buton "Revocă" pentru fiecare acces

#### Tab 4: Override-uri Utilizatori
- Tabel: User × Aplicație × Tip Acces
- Buton "Adaugă Override" → Modal cu form:
  - Selectează user
  - Selectează aplicație
  - Tip acces: inherit/allow/deny
  - Note (motivul)
- Buton "Șterge" pentru fiecare override

### 4. Timber Inventory (`/apps/timber-inventory/`)
- Interfața existentă (field-inventory.html)
- Funcționează exact ca înainte
- Acum în structura apps/

---

## 🛠️ Adăugare Aplicație Nouă

### Pas 1: Înregistrare în Baza de Date

**Via Panel Admin** (recomandat):
1. Login ca admin → Admin Panel
2. Tab "Aplicații" → "+ Adaugă Aplicație"
3. Completează:
   - **app_id**: `control-anual` (identificator unic, no spaces)
   - **Nume**: `Control Anual Regenerări`
   - **Descriere**: `Rapoarte anuale pentru regenerări forestiere`
   - **Icon**: `🌲` (emoji sau URL imagine)
   - **Culoare**: `#51cf66` (hex color)
   - **URL**: `/apps/control-anual/`
   - **API Path**: `/api/control-anual`
4. Click "Adaugă"

**Via SQL** (alternativ):
```sql
INSERT INTO applications (
  app_id,
  app_name,
  app_description,
  app_icon_url,
  app_color,
  landing_url,
  api_base_path,
  display_order
) VALUES (
  'control-anual',
  'Control Anual Regenerări',
  'Rapoarte anuale pentru regenerări forestiere',
  '🌲',
  '#51cf66',
  '/apps/control-anual/',
  '/api/control-anual',
  2
);
```

### Pas 2: Acordă Acces Companiilor

**Via Panel Admin**:
1. Tab "Acces Companii" → "Acordă Acces"
2. Selectează companie
3. Selectează app: `control-anual`
4. Click "Acordă Acces"

**Via SQL**:
```sql
-- Acordă acces tuturor companiilor
INSERT INTO company_applications (company_id, app_id, is_enabled)
SELECT id, 'control-anual', true
FROM companies
WHERE is_active = true;

-- SAU acordă doar unei companii
INSERT INTO company_applications (company_id, app_id, is_enabled)
VALUES (5, 'control-anual', true);
```

### Pas 3: Creează Interfața Web

1. **Creează directorul**:
```bash
mkdir -p public/apps/control-anual
```

2. **Creează fișierul** `public/apps/control-anual/index.html`:
```html
<!DOCTYPE html>
<html lang="ro">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Control Anual - Regenerări</title>
    <!-- Copiază style-urile din apps/timber-inventory/index.html -->
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 Control Anual Regenerări</h1>
            <p>Interfața pentru rapoarte anuale</p>
        </div>

        <!-- Conținutul tău specific -->
    </div>

    <script>
        // Verificare JWT
        const authToken = localStorage.getItem('authToken');
        if (!authToken) {
            window.location.href = '/';
        }

        // API calls folosind authToken
        async function loadData() {
            const response = await fetch('/api/control-anual/data', {
                headers: {
                    'Authorization': `Bearer ${authToken}`
                }
            });
            const data = await response.json();
            // ...
        }
    </script>
</body>
</html>
```

### Pas 4: Creează API Endpoints

În `server.js`, adaugă:

```javascript
// API pentru Control Anual
app.get('/api/control-anual/data',
  authenticateToken,
  checkAppAccess(pool, 'control-anual'),
  async (req, res) => {
    try {
      const companyId = req.app_context.company_id;

      // Query date filtrate pe companie
      const result = await pool.query(
        'SELECT * FROM control_anual_data WHERE company_id = $1',
        [companyId]
      );

      res.json({
        success: true,
        data: result.rows
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
});
```

**Middleware `checkAppAccess`** va verifica automat:
1. User are acces la `control-anual`?
2. Filtrare automată pe `company_id` (dacă nu e admin)

### Pas 5: Deploy

```bash
git add .
git commit -m "Add control-anual app"
git push
```

Railway va face deploy automat!

---

## 🗄️ Schema Bază de Date

### Tabele Noi

#### `applications`
```sql
app_id VARCHAR(100) PRIMARY KEY    -- 'timber-inventory', 'control-anual'
app_name VARCHAR(255)              -- 'Inventar Forestier'
app_description TEXT
app_icon_url VARCHAR(500)          -- emoji sau URL
app_color VARCHAR(20)              -- '#667eea'
landing_url VARCHAR(500)           -- '/apps/timber-inventory/'
api_base_path VARCHAR(200)         -- '/api/field-inventory'
is_active BOOLEAN                  -- Poate fi dezactivată global
display_order INTEGER              -- Ordine în dashboard
```

#### `company_applications`
```sql
company_id INTEGER → companies(id)
app_id VARCHAR(100) → applications(app_id)
is_enabled BOOLEAN                 -- Compania are acces?
max_devices INTEGER                -- Limită dispozitive (override)
license_expires_at TIMESTAMP       -- Expirare acces
notes TEXT
granted_by INTEGER → users(id)     -- Care admin a acordat
```

#### `user_applications`
```sql
user_id INTEGER → users(id)
app_id VARCHAR(100) → applications(app_id)
access_type VARCHAR(20)            -- 'inherit', 'allow', 'deny'
is_enabled BOOLEAN
notes TEXT                         -- Motivul override-ului
granted_by INTEGER → users(id)
```

#### `user_app_activity` (analytics)
```sql
user_id INTEGER → users(id)
app_id VARCHAR(100) → applications(app_id)
last_accessed TIMESTAMP
access_count INTEGER
last_ip VARCHAR(50)
user_agent TEXT
```

---

## 🔌 API Endpoints

### Endpoints Utilizator (require JWT)

#### `GET /api/applications`
**Descriere**: Listează aplicațiile la care utilizatorul are acces

**Headers**: `Authorization: Bearer <token>`

**Răspuns**:
```json
{
  "success": true,
  "apps": [
    {
      "app_id": "timber-inventory",
      "app_name": "Inventar Forestier",
      "app_description": "Sincronizare date inventar...",
      "app_icon_url": "🌲",
      "app_color": "#51cf66",
      "landing_url": "/apps/timber-inventory/",
      "access_level": "company"
    }
  ],
  "count": 1
}
```

#### `GET /api/applications/:app_id`
**Descriere**: Detalii despre o aplicație specifică

**Răspuns**:
```json
{
  "success": true,
  "app": { /* detalii app */ }
}
```

### Endpoints Admin (require JWT + role=admin)

#### `POST /api/admin/applications`
**Descriere**: Înregistrează aplicație nouă

**Body**:
```json
{
  "app_id": "control-anual",
  "app_name": "Control Anual",
  "app_description": "...",
  "app_icon_url": "🌲",
  "app_color": "#51cf66",
  "landing_url": "/apps/control-anual/",
  "api_base_path": "/api/control-anual",
  "display_order": 2
}
```

#### `PUT /api/admin/applications/:app_id`
**Descriere**: Actualizează aplicație

#### `DELETE /api/admin/applications/:app_id`
**Descriere**: Șterge aplicație (cu verificare siguranță)

#### `GET /api/admin/company-apps`
**Descriere**: Listează toate relațiile companie-aplicație

#### `POST /api/admin/company-apps`
**Descriere**: Acordă acces companie la aplicație

**Body**:
```json
{
  "company_id": 5,
  "app_id": "timber-inventory",
  "max_devices": 10,
  "license_expires_at": "2025-12-31T23:59:59Z"
}
```

#### `DELETE /api/admin/company-apps/:id`
**Descriere**: Revocă acces companie

#### `GET /api/admin/user-apps`
**Descriere**: Listează toate override-urile utilizatori

#### `POST /api/admin/user-apps`
**Descriere**: Creează override utilizator

**Body**:
```json
{
  "user_id": 10,
  "app_id": "timber-inventory",
  "access_type": "allow",
  "notes": "CEO needs access for reports"
}
```

#### `PUT /api/admin/user-apps/:id`
**Descriere**: Actualizează override

#### `DELETE /api/admin/user-apps/:id`
**Descriere**: Șterge override

---

## 🧪 Testare

### Checklist Testare Completă

**Autentificare**:
- [ ] Login cu admin/admin123 funcționează
- [ ] Credențiale greșite arată eroare
- [ ] Logout șterge token și redirecționează

**Dashboard**:
- [ ] Card Timber Inventory se afișează
- [ ] Click pe card → navigare la `/apps/timber-inventory/`
- [ ] Buton Admin apare pentru admini
- [ ] Buton Admin NU apare pentru useri normali

**Field Inventory**:
- [ ] Interfața se încarcă corect
- [ ] Sincronizare date funcționează
- [ ] Export CSV/Excel funcționează
- [ ] Filtrare pe companie funcționează

**Panel Admin**:
- [ ] Tab Overview arată statistici corecte
- [ ] Pot înregistra aplicație nouă
- [ ] Pot edita aplicație existentă
- [ ] Pot acorda acces companie la app
- [ ] Pot revoca acces companie
- [ ] Pot crea override utilizator (allow/deny)
- [ ] Pot șterge override utilizator

**Control Acces**:
- [ ] User normal vede doar apps din compania sa
- [ ] Admin vede toate apps
- [ ] Override 'allow' acordă acces chiar dacă companie denied
- [ ] Override 'deny' blochează acces chiar dacă companie allowed
- [ ] Override 'inherit' respectă setarea companiei

**Mobile Sync** (backward compatibility):
- [ ] Aplicația Flutter continuă să sincronizeze fără modificări
- [ ] Device-ul este validat corect
- [ ] Datele sunt salvate cu company_id corect

---

## 🚨 Troubleshooting

### Problema: "Cannot read property 'id' of undefined"
**Cauză**: Token JWT invalid sau expirat
**Soluție**: Logout și login din nou

### Problema: "Application not available for your company"
**Cauză**: Compania nu are acces la aplicație
**Soluție**: Admin trebuie să acorde acces via Panel Admin → Tab "Acces Companii"

### Problema: "Admin access required"
**Cauză**: Utilizator încearcă să acceseze panel admin fără rol de admin
**Soluție**: Doar admini pot accesa `/admin-apps.html`

### Problema: Dashboard gol (nu arată aplicații)
**Cauză**: Migrarea DB nu a fost rulată SAU compania nu are acces la nicio aplicație
**Soluție**:
1. Rulează migrarea: `psql $DATABASE_URL < migrations/001_multi_app_hybrid_access.sql`
2. Verifică: `SELECT * FROM company_applications WHERE company_id = X;`

### Problema: Eroare "checkAppAccess is not a function"
**Cauză**: Middleware nu este importat corect
**Soluție**: Verifică `const { checkAppAccess } = require('./middleware/appAccess');` în server.js

---

## 📊 Monitorizare

### Logs Utile

**Verificare aplicații înregistrate**:
```sql
SELECT * FROM applications ORDER BY display_order;
```

**Verificare acces companii**:
```sql
SELECT c.name, a.app_name, ca.is_enabled, ca.license_expires_at
FROM company_applications ca
JOIN companies c ON ca.company_id = c.id
JOIN applications a ON ca.app_id = a.app_id
ORDER BY c.name, a.app_name;
```

**Verificare override-uri utilizatori**:
```sql
SELECT u.username, a.app_name, ua.access_type, ua.is_enabled, ua.notes
FROM user_applications ua
JOIN users u ON ua.user_id = u.id
JOIN applications a ON ua.app_id = a.app_id
ORDER BY u.username, a.app_name;
```

**Analytics utilizare** (dacă activat):
```sql
SELECT u.username, a.app_name, ua.access_count, ua.last_accessed
FROM user_app_activity ua
JOIN users u ON ua.user_id = u.id
JOIN applications a ON ua.app_id = a.app_id
ORDER BY ua.access_count DESC;
```

---

## 🔧 Configurare Avansată

### Activare Analytics Utilizare

În Railway, setează variabila de mediu:
```
TRACK_USER_ACTIVITY=true
```

Acest lucru va activa tracking-ul în `user_app_activity` pentru fiecare acces la aplicație.

### Schimbare JWT Secret (IMPORTANT pentru producție!)

În Railway, setează:
```
JWT_SECRET=un-secret-foarte-sigur-si-lung-minimum-32-caractere
```

### Modificare Timp Expirare Token

În `server.js`, linia 196:
```javascript
const token = jwt.sign({ userId, username, role }, JWT_SECRET, {
  expiresIn: '7d'  // Schimbă în '1d', '12h', etc.
});
```

---

## 📝 Changelog

### v7.2.0 (2025-11-01)
✨ Multi-app dashboard system
✨ Hybrid access control (company + user)
✨ Admin panel pentru gestionare
✨ Login page modernă
✨ Dashboard cu app launcher
🔒 JWT authentication
🔒 Role-based authorization
📁 Apps directory structure
🗄️ 4 tabele noi în DB
📚 Documentație completă

### v7.1.0
🔒 Field inventory security (company isolation)
🔒 Device validation
📊 Web interface cu autentificare

---

## 🎓 Resurse

- **Arhitectură Completă**: `MULTI_APP_DASHBOARD_ARCHITECTURE.md`
- **Quick Start**: `QUICK_START_MULTI_APP.md`
- **Migrare DB**: `migrations/001_multi_app_hybrid_access.sql`
- **Middleware**: `middleware/appAccess.js`
- **API Routes**: `routes/applications.js`

---

## 👥 Suport

Pentru întrebări sau probleme:
1. Verifică această documentație
2. Citește `MULTI_APP_DASHBOARD_ARCHITECTURE.md`
3. Consultă logs-urile Railway
4. Rulează query-uri SQL de debugging

---

**Sistem implementat cu Claude Code 🤖**

**Data ultimei actualizări**: 2025-11-01
