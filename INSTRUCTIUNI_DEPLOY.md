# 🚀 Instrucțiuni Deploy Multi-App Dashboard

## ❌ Problema Actuală

Dashboard-ul arată: **"Eroare la încărcarea aplicațiilor - Failed to load applications"**

**Cauză**: Tabelele din migrare nu există încă în baza de date Railway.

---

## ✅ Soluție: Rulează Migrarea

### Pasul 1: Accesează Railway Dashboard

1. Deschide: https://railway.app/
2. Login cu contul tău
3. Selectează proiectul: **timber-api-clean**
4. Click pe serviciul **PostgreSQL**

### Pasul 2: Deschide Query Editor

1. În serviciul PostgreSQL, click pe tab-ul **"Data"**
2. Vei vedea un editor SQL în partea de jos

### Pasul 3: Copiază și Rulează Migrarea

1. **DESCHIDE** fișierul: `C:\SOFT\SERVER\timber-api-clean\DEPLOY_MIGRATION.sql`
2. **SELECTEAZĂ TOT** conținutul (Ctrl+A)
3. **COPIAZĂ** (Ctrl+C)
4. **LIPEȘTE** în Railway Query Editor
5. Click butonul **"Run Query"** sau **"Execute"**

### Pasul 4: Verificare

După executare, ar trebui să vezi:

```
BEGIN
CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE INDEX (x9)
INSERT 0 1        ← Aplicația înregistrată
INSERT 0 X        ← X = numărul de companii active
COMMIT
```

Apoi rulează query-urile de verificare din partea de jos a fișierului:

```sql
SELECT * FROM applications;
```

Ar trebui să vezi:
```
app_id: timber-inventory
app_name: Inventar Forestier
...
```

---

## 🧪 Testare După Migrare

### 1. Reîmprospătează Dashboard-ul

În browser:
1. Du-te la: https://timber-api-clean-production.up.railway.app/dashboard.html
2. Apasă **F5** (refresh)
3. Ar trebui să vezi card-ul **"Inventar Forestier 🌲"**

### 2. Test Login

1. Du-te la: https://timber-api-clean-production.up.railway.app/
2. Login cu:
   - Username: `admin`
   - Password: `admin123`
3. Ar trebui să fii redirectat la dashboard

### 3. Test Click pe Aplicație

1. În dashboard, click pe card-ul "Inventar Forestier"
2. Ar trebui să te ducă la: `/apps/timber-inventory/`
3. Interfața field inventory ar trebui să se încarce

### 4. Test Admin Panel

1. În dashboard, click pe **"⚙️ Admin Panel"** (dacă ești admin)
2. Ar trebui să vezi 4 tab-uri:
   - Overview
   - Aplicații
   - Acces Companii
   - Override-uri Utilizatori

---

## 🔧 Alternative: Rulare via CLI (Opțional)

Dacă ai Railway CLI instalat:

```bash
# Conectează-te la Railway
railway login

# Link project
railway link

# Rulează migrarea
railway run psql < migrations/001_multi_app_hybrid_access.sql
```

SAU cu psql direct:

```bash
# Obține DATABASE_URL din Railway Dashboard → PostgreSQL → Variables
export DATABASE_URL="postgresql://..."

# Rulează migrarea
psql $DATABASE_URL < migrations/001_multi_app_hybrid_access.sql
```

---

## 🐛 Troubleshooting

### Eroare: "relation companies does not exist"

**Cauză**: Baza de date nu are tabelele de bază
**Soluție**: Verifică că serverul s-a pornit corect cel puțin o dată (server.js creează tabelele la startup)

### Eroare: "duplicate key value violates unique constraint"

**Cauză**: Ai rulat migrarea de 2 ori
**Soluție**: IGNORE - migrarea este idempotentă, nu strică nimic

### Dashboard încă arată eroare după migrare

**Verificări**:
1. Șterge cache browser (Ctrl+Shift+Del)
2. Logout și login din nou
3. Verifică în Railway → PostgreSQL → Data:
   ```sql
   SELECT * FROM applications;
   SELECT * FROM company_applications;
   ```
4. Verifică logs Railway → timber-api-clean → Deployments → View logs

### Cum verific dacă migrarea a reușit?

Rulează în Railway Query Editor:

```sql
-- Ar trebui să returneze 4 rânduri
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE '%app%';

-- Ar trebui să returneze 1 rând (timber-inventory)
SELECT COUNT(*) FROM applications;

-- Ar trebui să returneze numărul de companii active
SELECT COUNT(*) FROM company_applications;
```

---

## 📊 Ce Se Va Întâmpla După Migrare

### Înainte (acum):
```
Dashboard → ❌ Eroare la încărcarea aplicațiilor
```

### După:
```
Dashboard → ✅ Card "Inventar Forestier 🌲"
           → Click → /apps/timber-inventory/ → Funcționează!
```

### Pentru Admini:
```
Dashboard → ✅ Buton "⚙️ Admin Panel"
           → Click → Panel cu 4 tab-uri
              → Pot înregistra aplicații noi
              → Pot gestiona acces companii
              → Pot crea override-uri utilizatori
```

---

## 📝 Notes Important

1. **Migrarea este SAFE**: Nu afectează datele existente
2. **Idempotentă**: Poate fi rulată de mai multe ori fără probleme
3. **Backward compatible**: Field inventory continuă să funcționeze
4. **Zero downtime**: Nu trebuie să oprești serverul

---

## 🎯 După Ce Funcționează

### Următorii Pași:

1. **Schimbă parola admin**:
   ```sql
   -- Generează hash pentru o parolă nouă
   -- Folosește https://bcrypt-generator.com/
   UPDATE users
   SET password_hash = '$2a$10$...' -- hash-ul generat
   WHERE username = 'admin';
   ```

2. **Setează JWT_SECRET** în Railway:
   - Railway Dashboard → timber-api-clean → Variables
   - Add variable: `JWT_SECRET` = `un-secret-foarte-lung-si-sigur-minim-32-caractere`

3. **Explorează Admin Panel**:
   - Înregistrează aplicații noi
   - Acordă acces companiilor
   - Creează override-uri pentru utilizatori specifici

---

## 📞 Suport

Dacă întâmpini probleme:
1. Verifică logs Railway
2. Consultă `README_MULTI_APP.md` secțiunea Troubleshooting
3. Rulează query-urile de verificare din `DEPLOY_MIGRATION.sql`

---

**Succes! 🚀**
