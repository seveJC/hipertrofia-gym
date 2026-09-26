// ---------- Storage ----------
const STORAGE_KEY = 'hipertrofia_db_v1';

function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.error('DB load error', e); }
  return null;
}

function saveDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  markBackupPending();
}

let db = loadDB();

// ---------- Sesión en curso (autoguardado) ----------
// Guarda el progreso de una sesión que aún no se ha finalizado, para que
// sobreviva a una navegación fuera de la pantalla de sesión (por ejemplo,
// entrar a "Editar rutina" para añadir un ejercicio a mitad de entreno).
const SESSION_DRAFTS_KEY = 'hipertrofia_session_drafts_v1';
const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 horas: pasado eso se considera abandonada

function loadSessionDrafts() {
  try { return JSON.parse(localStorage.getItem(SESSION_DRAFTS_KEY)) || {}; } catch (e) { return {}; }
}

function loadSessionDraft(routineId) {
  const all = loadSessionDrafts();
  const draft = all[routineId];
  if (!draft) return null;
  if (Date.now() - (draft.sessionStartedAt || 0) > DRAFT_MAX_AGE_MS) {
    clearSessionDraft(routineId);
    return null;
  }
  return draft;
}

function saveSessionDraft(routineId, draft) {
  try {
    const all = loadSessionDrafts();
    all[routineId] = draft;
    localStorage.setItem(SESSION_DRAFTS_KEY, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

function clearSessionDraft(routineId) {
  try {
    const all = loadSessionDrafts();
    delete all[routineId];
    localStorage.setItem(SESSION_DRAFTS_KEY, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

// ---------- Copia automática en GitHub ----------
// El token se guarda solo en el localStorage de este navegador; nunca viaja
// al código fuente ni se sube al repositorio.
const GH_OWNER = 'seveJC';
const GH_REPO = 'hipertrofia-gym';
const GH_PATH = 'hipertrofia_import.json';
const GH_TOKEN_KEY = 'hipertrofia_gh_token_v1';

function getGhToken() {
  try { return localStorage.getItem(GH_TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function setGhToken(token) {
  try {
    if (token) localStorage.setItem(GH_TOKEN_KEY, token);
    else localStorage.removeItem(GH_TOKEN_KEY);
  } catch (e) { /* ignore */ }
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// ---------- Copia pendiente y reintentos ----------
// Cualquier cambio en la base deja una marca hasta que la copia sube bien.
// Si falla (sin cobertura al salir del gimnasio), se reintenta al volver la
// red, al abrir la app o al volver a primer plano, y la home lo avisa.
const BACKUP_PENDING_KEY = 'hipertrofia_backup_pending_v1';

function isBackupPending() {
  try { return !!localStorage.getItem(BACKUP_PENDING_KEY); } catch (e) { return false; }
}

function markBackupPending() {
  try { localStorage.setItem(BACKUP_PENDING_KEY, new Date().toISOString()); } catch (e) { /* ignore */ }
}

function clearBackupPending() {
  try { localStorage.removeItem(BACKUP_PENDING_KEY); } catch (e) { /* ignore */ }
}

let backupRetryTimer = null;
let backupRetryCount = 0;
const BACKUP_RETRY_DELAYS_MS = [30000, 120000, 600000];

function scheduleBackupRetry() {
  clearTimeout(backupRetryTimer);
  const delay = BACKUP_RETRY_DELAYS_MS[Math.min(backupRetryCount, BACKUP_RETRY_DELAYS_MS.length - 1)];
  backupRetryCount++;
  backupRetryTimer = setTimeout(() => retryBackupIfPending(), delay);
}

function retryBackupIfPending() {
  if (!getGhToken() || !isBackupPending()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  pushBackupToGitHub(false);
}

window.addEventListener('online', retryBackupIfPending);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryBackupIfPending(); });

function updateBackupBanner() {
  const el = document.getElementById('backup-banner');
  if (!el) return;
  el.hidden = !(getGhToken() && isBackupPending());
}

let backupInFlight = false;

async function pushBackupToGitHub(notify) {
  const token = getGhToken();
  if (!token) {
    if (notify) showToast('Configura primero la copia en GitHub');
    return false;
  }
  // Dos subidas a la vez chocan en GitHub (409 por sha desfasado).
  if (backupInFlight) return false;
  backupInFlight = true;
  // Lo que se sube es lo que hay ahora; si cambia algo mientras tanto,
  // saveDB volverá a marcar pendiente.
  clearBackupPending();
  const apiUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  };
  try {
    const getRes = await fetch(apiUrl, { headers });
    if (!getRes.ok) throw new Error(`No se pudo leer el fichero en GitHub (${getRes.status})`);
    const current = await getRes.json();
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Backup automático — ${new Date().toISOString()}`,
        content: utf8ToBase64(JSON.stringify(db, null, 2)),
        sha: current.sha,
      }),
    });
    if (!putRes.ok) {
      const detail = await putRes.text().catch(() => '');
      throw new Error(`GitHub devolvió ${putRes.status}: ${detail.slice(0, 200)}`);
    }
    backupRetryCount = 0;
    clearTimeout(backupRetryTimer);
    updateBackupBanner();
    if (notify) showToast('Copia en GitHub actualizada ☁️');
    return true;
  } catch (e) {
    console.error('Backup en GitHub falló', e);
    markBackupPending();
    updateBackupBanner();
    scheduleBackupRetry();
    if (notify) showToast('No se pudo subir la copia; se reintentará solo');
    return false;
  } finally {
    backupInFlight = false;
  }
}

function openGhConfigPrompt(onDone) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const hasToken = !!getGhToken();
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>🔗 Copia automática en GitHub</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">Pega tu token de acceso personal de GitHub (con permiso de escritura solo en este repositorio). Se guarda únicamente en este navegador.</p>
      <div class="field">
        <input id="gh-token-input" type="password" placeholder="github_pat_..." value="${escapeHtml(getGhToken())}" autocomplete="off" />
      </div>
      <button class="btn btn-primary btn-block" id="gh-token-save">Guardar</button>
      <div style="height:8px;"></div>
      ${hasToken ? '<button class="btn btn-danger btn-block" id="gh-token-remove">Quitar token</button><div style="height:8px;"></div>' : ''}
      <button class="btn btn-block" id="gh-token-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.getElementById('gh-token-save').addEventListener('click', () => {
    const val = document.getElementById('gh-token-input').value.trim();
    if (!val) { showToast('Pega un token válido'); return; }
    setGhToken(val);
    document.body.removeChild(backdrop);
    showToast('Token guardado');
    if (onDone) onDone();
  });
  const removeBtn = document.getElementById('gh-token-remove');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    setGhToken('');
    document.body.removeChild(backdrop);
    showToast('Token eliminado');
    if (onDone) onDone();
  });
  document.getElementById('gh-token-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
}

// Si este navegador todavía no tiene datos guardados, se siembra desde el
// fichero hipertrofia_import.json (publicado junto a la app) para que un
// dispositivo nuevo no arranque con la app vacía.
async function ensureDB() {
  if (db) return;
  try {
    const res = await fetch('./hipertrofia_import.json');
    db = await res.json();
  } catch (e) {
    console.error('No se pudo cargar hipertrofia_import.json', e);
    db = { exercises: [], routines: [], sessions: [] };
  }
  saveDB();
}

// Además de la siembra inicial, en cada carga se añaden a la biblioteca los
// ejercicios nuevos que haya en hipertrofia_import.json (por id) sin tocar
// rutinas, sesiones ni ejercicios ya existentes o editados localmente.
async function mergeExerciseLibrary() {
  try {
    const res = await fetch('./hipertrofia_import.json', { cache: 'no-store' });
    const data = await res.json();
    const existingIds = new Set(db.exercises.map(e => e.id));
    const newOnes = (data.exercises || []).filter(e => !existingIds.has(e.id));
    if (newOnes.length) {
      db.exercises.push(...newOnes);
      saveDB();
    }
  } catch (e) {
    console.error('No se pudo actualizar la biblioteca de ejercicios', e);
  }
}

// ---------- Colores por músculo ----------
const MUSCLE_COLORS = {
  'Pecho': '#6fa8dc',
  'Deltoide anterior': '#e6a8d7',
  'Tríceps': '#93c47d',
  'Espalda': '#f6b26b',
  'Bíceps': '#ffe066',
  'Deltoide posterior': '#a4c2f4',
  'Deltoide lateral': '#6d9eeb',
  'Cuádriceps': '#e06666',
  'Isquiotibiales': '#f4b183',
  'Gemelos': '#b7b7b7',
  'Abdominales': '#c27ba0',
};

// Abreviaturas para el resumen compacto de la home.
const MUSCLE_ABBR = {
  'Pecho': 'Pec',
  'Deltoide anterior': 'D.ant',
  'Deltoide lateral': 'D.lat',
  'Deltoide posterior': 'D.post',
  'Tríceps': 'Tri',
  'Bíceps': 'Bic',
  'Espalda': 'Back',
  'Cuádriceps': 'Quad',
  'Isquiotibiales': 'Isq',
  'Gemelos': 'Gem',
  'Abdominales': 'Abd',
};

function muscleAbbr(muscle) {
  if (!muscle) return '?';
  return muscle.split('+').map(m => MUSCLE_ABBR[m.trim()] || m.trim()).join('+');
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Nombres de músculo de un ejercicio, combinados incluidos ("Pecho + Tríceps"
// → ["Pecho", "Tríceps"]). Sin músculo → ["Sin músculo"].
function muscleNames(muscle) {
  const parts = (muscle || '').split('+').map(m => m.trim()).filter(Boolean);
  return parts.length ? parts : ['Sin músculo'];
}

function muscleParts(muscle) {
  if (!muscle) return [];
  return muscle.split('+').map(m => m.trim()).filter(m => MUSCLE_COLORS[m]);
}

function muscleBackgroundStyle(muscle) {
  const parts = muscleParts(muscle);
  if (!parts.length) return '';
  const alpha = 0.16;
  if (parts.length === 1) {
    const [r, g, b] = hexToRgb(MUSCLE_COLORS[parts[0]]);
    return `background: linear-gradient(rgba(${r},${g},${b},${alpha}), rgba(${r},${g},${b},${alpha})), var(--bg-card);`;
  }
  const pct = 100 / parts.length;
  const stops = parts.map((m, i) => {
    const [r, g, b] = hexToRgb(MUSCLE_COLORS[m]);
    return `rgba(${r},${g},${b},${alpha}) ${i * pct}%, rgba(${r},${g},${b},${alpha}) ${(i + 1) * pct}%`;
  }).join(', ');
  return `background: linear-gradient(90deg, ${stops}), var(--bg-card);`;
}

function muscleBadgeHtml(muscle) {
  if (!muscle) return '';
  const parts = muscleParts(muscle);
  const color = parts[0] ? MUSCLE_COLORS[parts[0]] : 'var(--text-dim)';
  return `<div class="muscle-badge" style="color:${color};border-color:${color};">${escapeHtml(muscle)}</div>`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getExercise(id) {
  return db.exercises.find(e => e.id === id);
}

function getRoutine(id) {
  return db.routines.find(r => r.id === id);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// A mano: algún navegador ignora el '2-digit' de toLocaleDateString y saca 31/8.
function fmtDateShort(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return dd + '/' + mm;
}

// 70' en vez de 1h 10min: para el resumen compacto de la home.
function fmtMinutesShort(sec) {
  if (sec == null) return null;
  return `${Math.round(sec / 60)}'`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Acepta tanto "," como "." como separador decimal, y añade el 0 delante
// cuando se deja el número empezando por el separador (".5" o ",5" -> "0.5").
// "90" → 90 · "1:30" → 90 · "2 min" → 120 · "" → null (sin objetivo).
// undefined = no se entiende, el que llama decide qué hacer (no borrar nunca).
function parseSeconds(txt) {
  const t = String(txt == null ? '' : txt).trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  const mmss = t.match(/^(\d+)\s*[:'’]\s*(\d{1,2})$/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(s|seg|segs|segundos|m|min|mins|minutos)?$/);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!(v > 0)) return null;
  return /^m/.test(m[2] || '') ? Math.round(v * 60) : Math.round(v);
}

function normalizeDecimal(str) {
  if (str == null) return str;
  let s = String(str).replace(',', '.');
  if (s.startsWith('.')) s = '0' + s;
  else if (s.startsWith('-.')) s = '-0' + s.slice(1);
  return s;
}

// ---------- Router ----------
const app = document.getElementById('app');

function navigate(hash) {
  window.location.hash = hash;
}

window.addEventListener('hashchange', render);
// ---------- Migraciones de datos ----------
// Cambios puntuales sobre datos ya guardados. Cada una se marca en db.meta
// para no repetirse, y se decide por nombres/fechas, no por ids, para que
// funcione igual en cualquier dispositivo.
// Histórico de mediciones de la hoja "gim v2" (26/10/2020 – 17/03/2026).
// Columnas: fecha, peso, cintura, muslo, bíceps (brazo D), hombros. _ = sin dato.
const MEASURES_SEED = (() => { const _ = null; return [
  ["2020-10-26",68.5,83,52.1,33.8,112.5],
  ["2020-11-02",68.4,81,52.3,34,111.5],
  ["2020-11-16",68,80.7,52.7,33.8,118.1],
  ["2020-11-21",67.7,79.8,54.7,33.9,117.9],
  ["2020-11-30",67.8,79.5,54.8,33.9,118],
  ["2020-12-07",67.6,78.4,55.3,33.9,117.8],
  ["2020-12-16",67.4,77.8,54.5,33.6,117.2],
  ["2020-12-23",67.5,77.6,54.7,33.4,118.4],
  ["2021-01-02",66.8,77.2,55,33.4,118.5],
  ["2021-01-10",66,76.6,54,33,114],
  ["2021-01-17",66.3,76.4,54.5,33.3,114.2],
  ["2021-01-25",65.9,76,54,33,113.2],
  ["2021-02-06",65.9,75.7,53.8,33,114],
  ["2021-02-14",65.9,75.6,54.2,33.1,114.5],
  ["2021-02-28",66.3,75.9,54.3,33.3,114.5],
  ["2021-03-13",65.8,75.9,53.8,33.3,114.3],
  ["2021-03-19",66.1,75.9,54,33.4,114.7],
  ["2021-03-28",66.1,75.6,54.5,33.2,115],
  ["2021-04-03",66,75.5,55.1,33.3,114.8],
  ["2021-04-10",65.8,75.3,55,33.6,114.8],
  ["2021-04-18",65,75,54.9,33.4,113.3],
  ["2021-04-24",64.4,74.2,54.8,33.6,112.8],
  ["2021-05-29",63.8,73.8,53,33.1,111.1],
  ["2021-06-28",64.2,74.8,51.8,33,111.5],
  ["2021-08-27",66.6,78.5,52,33.1,_],
  ["2021-09-06",66.6,77.5,53,33.2,115.2],
  ["2021-09-15",67.2,78,54,33.5,114.5],
  ["2021-09-24",66.7,77.9,54.3,33.5,114.6],
  ["2021-10-06",67.5,78.5,53,33.7,114.8],
  ["2021-10-28",68.3,81.1,53.8,33.5,116.5],
  ["2021-11-16",69.6,81.5,54.5,34,117],
  ["2021-11-22",70.3,80.7,54.9,34.2,117.2],
  ["2021-12-31",68.8,80.1,54,34.1,117.7],
  ["2022-01-06",70.2,81.8,55.8,34.5,119.5],
  ["2022-02-09",71.3,82.1,56.4,34.9,120.2],
  ["2022-03-02",70.5,81.8,54.1,34.7,118.9],
  ["2022-03-16",69.5,80.9,_,34.2,_],
  ["2022-03-23",68.8,79.3,54.1,34.3,118.8],
  ["2022-03-31",69.6,78.8,54.5,34.6,118.2],
  ["2022-04-08",69.2,78.4,55,34.6,117.3],
  ["2022-04-13",69.1,78,55.1,34.6,117.9],
  ["2022-04-22",69,77.5,55.1,34.4,119.2],
  ["2022-04-29",68.3,77.5,55,34.5,117.8],
  ["2022-05-09",67.8,77.7,55.1,34.4,119.6],
  ["2022-05-13",_,77,55,34.5,120.2],
  ["2022-05-28",67.2,75.6,55.1,34.4,118.1],
  ["2022-06-09",66.6,75,54.2,34.3,117.2],
  ["2022-06-15",65.5,74.5,54.9,34,119.3],
  ["2022-06-29",_,74.1,_,33.7,_],
  ["2022-08-06",65.2,74.6,52.6,33.8,116.7],
  ["2022-08-22",65.8,75.7,50.5,33.1,116.6],
  ["2022-08-26",65.7,75.1,51.1,33.8,118.2],
  ["2022-09-30",67.2,77.8,52,33.6,117.5],
  ["2022-10-07",67.8,77.7,53.2,34.3,119.3],
  ["2022-10-22",68.2,78.3,53.3,33.9,118.3],
  ["2022-10-28",69.1,78.4,53.4,34.3,118.6],
  ["2022-11-04",69.7,79.3,54,34.5,119.6],
  ["2022-11-11",69.9,79.8,54.5,34.7,120.6],
  ["2022-11-18",70,80,54.5,34.7,120.8],
  ["2022-11-30",70.8,80.4,55.1,35,120.9],
  ["2022-12-15",71.8,81.1,55.5,35.5,122.2],
  ["2023-01-05",72.3,83,55.7,35.4,121.6],
  ["2023-01-13",72.2,83,56,35.3,122.8],
  ["2023-01-20",73.1,83.3,56.3,35.6,122.5],
  ["2023-01-27",73.4,82.7,56.6,35.7,122.9],
  ["2023-02-04",73.1,82.7,56.1,35.7,123.5],
  ["2023-02-08",72.6,83.6,56.1,35.3,123.2],
  ["2023-02-15",72.6,83.3,56.2,35.3,123],
  ["2023-02-22",72.3,82.6,56,35.3,123],
  ["2023-03-03",72.4,81.8,56.2,35.1,123.2],
  ["2023-03-09",71.8,81.5,55.8,35,122.4],
  ["2023-03-17",72.1,81.5,55.6,35,122.5],
  ["2023-03-30",71.6,80.9,55.9,35,121.9],
  ["2023-04-20",70.9,80.6,54.7,34.6,120],
  ["2023-04-27",71.3,80.2,55.1,34.6,122],
  ["2023-05-10",70.6,79.8,55.3,34.6,122],
  ["2023-05-26",_,79.1,55.2,34.6,121.3],
  ["2023-06-07",69.5,78.3,54.4,34.4,121],
  ["2023-06-22",68.2,77.1,53.6,34.1,120.3],
  ["2023-07-12",67.9,76.6,53.9,34,120],
  ["2023-08-23",67.1,76.6,52.6,34,119.5],
  ["2023-10-24",69.5,80.7,55,34.5,121.2],
  ["2023-12-01",70.3,80.6,54.5,34.6,120.4],
  ["2023-12-14",70.9,80.8,55.1,35,122.7],
  ["2024-01-07",71.9,82.5,55.6,35,122.2],
  ["2024-01-18",72.4,82,55.7,35,122],
  ["2024-02-01",72.7,82.3,56,35.3,122.7],
  ["2024-02-16",73.5,84,57.2,35.7,122.9],
  ["2024-03-13",74.2,87.2,56.3,35.6,124.7],
  ["2024-04-09",72.7,84.6,56.5,35.5,_],
  ["2024-04-17",71.8,82.3,55.8,35,_],
  ["2024-04-27",71.3,80.6,55.6,35.3,121.5],
  ["2024-05-08",69.5,79.6,55.4,34.9,122],
  ["2024-05-22",69.6,78.8,55.4,34.9,121.2],
  ["2024-06-05",68.7,78.2,54.1,34.7,121.2],
  ["2024-06-19",67.7,77,54.1,34.8,121.2],
  ["2024-07-09",66.9,76.3,54.1,34.4,120.5],
  ["2024-07-25",65.6,74.3,53.1,34.3,120.5],
  ["2024-08-12",65.6,75.2,53,34.1,120.7],
  ["2024-09-06",66.7,74.8,53.1,34.5,119.8],
  ["2024-09-25",66.5,75.3,53.6,34.4,120.6],
  ["2024-10-03",67.7,75.8,53.9,34.7,121.9],
  ["2024-12-02",69.9,79.2,55.5,35,122.3],
  ["2025-01-06",69.9,80.3,54.5,35,121.9],
  ["2025-01-21",71.2,81.3,55.5,35.3,122],
  ["2025-02-05",72.2,83.5,56,35.5,123],
  ["2025-02-20",72.4,82.9,56.2,35.6,123.6],
  ["2025-05-01",71.6,80.4,55.4,35.4,123.1],
  ["2025-06-11",69,78.5,54,34.8,121.5],
  ["2025-07-02",67.5,76.8,54.4,34.5,121],
  ["2025-07-24",66.6,76.2,52.5,34.7,119],
  ["2025-12-12",70,79.8,54.5,35,122.1],
  ["2026-01-14",71.6,81.6,55.2,35.3,122.7],
  ["2026-02-26",71.3,79.6,55.5,35.4,122.8],
  ["2026-03-17",69,79,54.6,35.4,121.7]
]; })();

function runMigrations() {
  db.meta = db.meta || {};
  let changed = false;

  // Pierna se parte en dos rutinas con los mismos ejercicios: Hipertrofia y
  // Fuerza. Las sesiones del 28/08 y 04/09 de 2026 fueron de fuerza.
  if (!db.meta.legSplitDone) {
    const leg = db.routines.find(r => /^Pierna/i.test(r.name) && !/Fuerza|Hipertrofia/i.test(r.name));
    if (leg) {
      leg.name = 'Pierna (Hipertrofia)';
      const fuerza = { id: uid(), name: 'Pierna (Fuerza)', slots: leg.slots.map(sl => ({ ...sl })) };
      db.routines.splice(db.routines.indexOf(leg) + 1, 0, fuerza);
      const FUERZA_DAYS = ['2026-08-28', '2026-09-04'];
      const localDay = (iso) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      db.sessions.forEach(ses => {
        if (ses.routineId === leg.id && FUERZA_DAYS.includes(localDay(ses.date))) ses.routineId = fuerza.id;
      });
    }
    db.meta.legSplitDone = true;
    changed = true;
  }

  // El descanso objetivo pasa a vivir en la rutina (slot.restSec). Se siembra
  // con el último que se usó en cada ejercicio, que hasta ahora se guardaba en
  // la sesión (restNote).
  if (!db.meta.restTargetsSeeded) {
    db.routines.forEach(r => {
      const sessions = db.sessions.filter(ses => ses.routineId === r.id).sort((a, b) => b.date.localeCompare(a.date));
      r.slots.forEach(sl => {
        if (sl.restSec != null) return;
        for (const ses of sessions) {
          const e = ses.entries.find(x => x.slotId === sl.id);
          if (e && e.restNote) {
            const n = Number(String(e.restNote).split('-')[0]);
            if (n > 0) { sl.restSec = n; break; }
          }
        }
      });
    });
    db.meta.restTargetsSeeded = true;
    changed = true;
  }

  // Lista de gimnasios: se siembra con los que ya aparecen en sesiones más
  // los que faltaban por dar de alta.
  if (!db.meta.gymsSeeded) {
    const seen = new Set(db.gyms || []);
    db.sessions.forEach(ses => { if (ses.gym && ses.gym.trim()) seen.add(ses.gym.trim()); });
    ['Basic-Fit Huelva', 'VivaGym Bravo Murillo', 'Quality Fitness (Aljaraque)'].forEach(g => seen.add(g));
    db.gyms = [...seen].sort((a, b) => a.localeCompare(b, 'es'));
    db.meta.gymsSeeded = true;
    changed = true;
  }

  // Unilaterales: la primera casilla pasa a ser la derecha. Hasta ahora reps
  // era izq y reps2 der; se intercambian en lo ya guardado para que el
  // histórico se lea igual que lo nuevo (der primero).
  if (!db.meta.uniRightFirst) {
    db.sessions.forEach(ses => ses.entries.forEach(e => e.sets.forEach(st => {
      if (st.reps2 != null && st.reps2 !== '') { const t = st.reps; st.reps = st.reps2; st.reps2 = t; }
    })));
    db.meta.uniRightFirst = true;
    changed = true;
  }

  // Gimnasios duplicados por mayúsculas/espacios/guiones ("Basic-Fit Bravo
  // Murillo" dos veces): se quedan con una sola forma y las sesiones se
  // corrigen para apuntar a ella.
  if (!db.meta.gymsDeduped) {
    const norm = (g) => g.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const canonical = {};
    (db.gyms || []).forEach(g => {
      const k = norm(g);
      // Preferir la forma con guion y mayúsculas "bien" si hay varias.
      if (!canonical[k] || (/[A-Z].*-.*[A-Z]/.test(g) && !/[A-Z].*-.*[A-Z]/.test(canonical[k]))) canonical[k] = g.trim();
    });
    db.gyms = [...new Set(Object.values(canonical))].sort((a, b) => a.localeCompare(b, 'es'));
    db.sessions.forEach(ses => { if (ses.gym) { const c = canonical[norm(ses.gym)]; if (c) ses.gym = c; } });
    db.meta.gymsDeduped = true;
    changed = true;
  }

  // Mensaje dejado a mano el 11/09/2026 para la siguiente sesión de Fuerza
  // (ese día no se pudo dejar desde la app).
  if (!db.meta.msgFuerza20260911) {
    const fuerza = db.routines.find(r => /^Fuerza/i.test(r.name));
    if (fuerza) {
      db.messages = db.messages || [];
      db.messages.push({ id: uid(), routineId: fuerza.id, fromRoutineId: null, text: 'Hacer Gemelos y Abdominales', createdAt: '2026-09-11T20:00:00.000Z' });
    }
    db.meta.msgFuerza20260911 = true;
    changed = true;
  }

  // Segunda pasada de unificación: en el móvil seguía "Basic-fit Bravo Murillo"
  // junto a "Basic-Fit Bravo Murillo". Se prefiere la forma con mayúsculas
  // oficial y se corrigen las sesiones.
  if (!db.meta.gymsDeduped2) {
    const preferred = ['Basic-Fit Bravo Murillo', 'Basic-Fit Huelva', 'Hi-Fitness', 'QFitness Aljaraque', 'VivaGym Bravo Murillo'];
    const canonical = {};
    preferred.forEach(g => { canonical[gymKey(g)] = g; });
    (db.gyms || []).forEach(g => { const k = gymKey(g); if (k && !canonical[k]) canonical[k] = g.trim(); });
    db.gyms = [...new Set(Object.values(canonical))].sort((a, b) => a.localeCompare(b, 'es'));
    db.sessions.forEach(ses => { if (ses.gym) { const c = canonical[gymKey(ses.gym)]; if (c) ses.gym = c; } });
    db.meta.gymsDeduped2 = true;
    changed = true;
  }

  // Quality Fitness (Aljaraque) pasa a llamarse QFitness Aljaraque.
  if (!db.meta.gymQFitness) {
    const from = 'Quality Fitness (Aljaraque)', to = 'QFitness Aljaraque';
    db.gyms = [...new Set((db.gyms || []).map(g => g === from ? to : g))].sort((a, b) => a.localeCompare(b, 'es'));
    db.sessions.forEach(ses => { if (ses.gym === from) ses.gym = to; });
    db.meta.gymQFitness = true;
    changed = true;
  }

  // 14/09/2026: en Push, press banca mancuernas y press banca inclinado a 8–10
  // repes (si no tienen ya un rango propio).
  if (!db.meta.repRangePush20260914) {
    const push = db.routines.find(r => /^Empuje|push/i.test(r.name));
    if (push) {
      push.slots.forEach(sl => {
        const ex = getExercise(sl.exerciseId);
        if (!ex || sl.repLo) return;
        if (/^press banca mancuernas$/i.test(ex.name.trim()) || /^press banca inclinado$/i.test(ex.name.trim())) { sl.repLo = 8; sl.repHi = 10; }
      });
    }
    db.meta.repRangePush20260914 = true;
    changed = true;
  }

  // 14/09/2026: rangos de repes definidos ejercicio a ejercicio. Se buscan por
  // nombre de rutina y de ejercicio (sin tildes ni mayúsculas); los que no
  // aparecen siguen con el rango por defecto de su rutina.
  if (!db.meta.repRanges20260914b) {
    const RANGES = {
      'empuje': {
        'press hombro mancuernas': [10, 12], 'press frances': [10, 12], 'peck deck / contractora': [12, 14],
        'extension triceps cuerda': [10, 14], 'elevacion lateral polea': [10, 16], 'katana polea': [10, 12],
        'fondos en maquina': [10, 12],
      },
      'tiron': {
        'remo pecho apoyado agarre prono': [8, 10], 'remo en maquina': [8, 10], 'curl biceps mancuernas': [10, 12],
        'jalon al pecho polea': [10, 12], 'dominadas': [6, 8], 'curl biceps polea': [12, 14], 'facepull': [10, 16],
        'elevacion lateral tumbado polea': [10, 16], 'curl martillo polea': [12, 14],
      },
      'pierna (hipertrofia)': {
        'sentadilla hack / pendular': [6, 8], 'prensa 45º': [8, 10], 'extension de cuadriceps': [10, 12],
        'curl femoral sentado': [10, 12], 'curl femoral maquina extension de cuadriceps': [12, 14],
        'elevacion lateral polea': [10, 16], 'jaca pendular (gemelos)': [12, 14],
      },
      'pierna (fuerza)': {
        'prensa 45º': [6, 8], 'extension de cuadriceps': [8, 10], 'curl femoral sentado': [6, 8],
        'curl femoral maquina extension de cuadriceps': [8, 10], 'elevacion lateral polea': [10, 16],
        'jaca pendular (gemelos)': [12, 14],
      },
      'fuerza (push+pull)': {
        'press banca mancuernas': [4, 6], 'press banca inclinado': [6, 8], 'extension triceps': [8, 10],
        'katana polea': [10, 12], 'remo pecho apoyado agarre prono': [6, 8], 'jalon al pecho agarre doble': [6, 8],
        'curl biceps mancuernas': [6, 8], 'remo maquina dorsal agarre neutro': [6, 8], 'curl martillo mancuernas': [8, 10],
        'curl martillo polea': [8, 10], 'facepull': [10, 16],
      },
    };
    const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    db.routines.forEach(r => {
      const rn = norm(r.name);
      const key = Object.keys(RANGES).find(k => rn.startsWith(k));
      if (!key) return;
      r.slots.forEach(sl => {
        const ex = getExercise(sl.exerciseId);
        const range = ex && RANGES[key][norm(ex.name)];
        if (range) { sl.repLo = range[0]; sl.repHi = range[1]; }
      });
    });
    db.meta.repRanges20260914b = true;
    changed = true;
  }

  // Abdominales y gemelos que quedaban sin rango: 12–15 en todas las rutinas.
  if (!db.meta.repRangesAbsCalves20260914) {
    db.routines.forEach(r => r.slots.forEach(sl => {
      const ex = getExercise(sl.exerciseId);
      if (!ex || sl.repLo) return;
      const muscles = muscleNames(ex.muscle);
      if (muscles.includes('Abdominales') || muscles.includes('Gemelos')) { sl.repLo = 12; sl.repHi = 15; }
    }));
    db.meta.repRangesAbsCalves20260914 = true;
    changed = true;
  }

  // 16/09/2026: carga del histórico de mediciones. No pisa una fecha que ya exista.
  if (!db.meta.measuresSeeded20260916) {
    db.measures = db.measures || [];
    const have = new Set(db.measures.map(m => m.date));
    MEASURES_SEED.forEach(([date, weight, waist, thigh, biceps, shoulders]) => {
      if (have.has(date)) return;
      db.measures.push({ id: uid(), date, weight, waist, thigh, biceps, chest: null, shoulders });
    });
    db.meta.measuresSeeded20260916 = true;
    changed = true;
  }

  // 16/09/2026: mediciones de mayo a septiembre de 2026 (fecha, peso, cintura, muslo, bíceps, pecho).
  if (!db.meta.measuresSeeded20260916b) {
    db.measures = db.measures || [];
    const have = new Set(db.measures.map(m => m.date));
    const _ = null;
    [
      ['2026-05-21', _, 74.6, _, 34.4, _],
      ['2026-06-04', _, 74.6, _, 34.5, _],
      ['2026-06-14', _, 74.2, _, 34.5, _],
      ['2026-06-17', 65.8, 73.8, 52.7, 34.5, 96.5],
      ['2026-07-10', _, 73.1, _, _, _],
      ['2026-07-17', _, 72.7, _, 34.6, _],
      ['2026-08-27', 65.2, 72.7, _, 34.1, _],
      ['2026-09-09', _, 73, _, 33.6, _],
    ].forEach(([date, weight, waist, thigh, biceps, chest]) => {
      if (have.has(date)) return;
      db.measures.push({ id: uid(), date, weight, waist, thigh, biceps, chest, shoulders: null });
    });
    db.meta.measuresSeeded20260916b = true;
    changed = true;
  }

  // 17/09/2026: en Elevación lateral polea, el "+N" de rest-pause del 16/09 y
  // de las series 1–3 del 17/09 eran repes parciales; la última caída del drop
  // set de la serie 4 del 17/09 también.
  if (!db.meta.partialsLateral20260917) {
    const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const toPartials = (st) => {
      const m = String(st.reps).match(/^(\d+)\+(\d+)$/);
      if (!m || !st.restPause) return;
      st.reps = Number(m[1]); st.partialReps = Number(m[2]);
      delete st.restPause; delete st.pauseSec;
    };
    db.sessions.forEach(ses => {
      const day = ses.date.slice(0, 10);
      if (day !== '2026-09-16' && day !== '2026-09-17') return;
      ses.entries.forEach(e => {
        const ex = getExercise(e.exerciseId);
        if (!ex || norm(ex.name) !== 'elevacion lateral polea') return;
        e.sets.forEach((st, i) => {
          if (day === '2026-09-16') toPartials(st);
          else if (i < 3) toPartials(st);
          else if (i === 3 && st.dropset && String(st.weight) === '4.5/2.5/2.5' && String(st.reps) === '8/7/2') {
            st.weight = '4.5/2.5'; st.reps = '8/7'; st.partialReps = 2;
          }
        });
      });
    });
    db.meta.partialsLateral20260917 = true;
    changed = true;
  }

  if (changed) saveDB();
}

// Clave para comparar gimnasios sin mayúsculas, tildes, guiones ni espacios.
function gymKey(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Devuelve el nombre tal como está en la lista si ya existe uno equivalente
// ("basic-fit bravo murillo" → "Basic-Fit Bravo Murillo"); si no, el dado.
function canonicalGym(name) {
  const k = gymKey(name);
  if (!k) return '';
  return (db.gyms || []).find(g => gymKey(g) === k) || String(name).trim();
}

function gymOptionsHtml(selected) {
  const gyms = db.gyms || [];
  const current = gyms.includes(selected) ? selected : gyms[0];
  return [
    ...gyms.map(g => `<option value="${escapeHtml(g)}"${g === current ? ' selected' : ''}>${escapeHtml(g)}</option>`),
    `<option value="__new__">➕ Añadir gimnasio…</option>`,
  ].join('');
}

// Un <select> de gimnasios con la opción de dar de alta uno nuevo. onChange
// recibe el nombre elegido (ya guardado en db.gyms si es nuevo).
function bindGymSelect(select, onChange) {
  select.addEventListener('change', () => {
    if (select.value !== '__new__') { onChange(select.value); return; }
    const name = canonicalGym(prompt('Nombre del gimnasio') || '');
    if (!name) { select.value = ''; onChange(''); return; }
    db.gyms = db.gyms || [];
    if (!db.gyms.includes(name)) { db.gyms.push(name); db.gyms.sort((a, b) => a.localeCompare(b, 'es')); saveDB(); }
    select.innerHTML = gymOptionsHtml(name);
    onChange(name);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  await ensureDB();
  await mergeExerciseLibrary();
  runMigrations();
  render();
  retryBackupIfPending();
});

function currentRoute() {
  const hash = window.location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  return parts;
}

let currentCleanup = null;

function render() {
  if (currentCleanup) { currentCleanup(); currentCleanup = null; }
  // Los diálogos cuelgan de body, no de #app: al cambiar de pantalla con uno
  // abierto se quedaría pegado encima de la pantalla nueva.
  document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
  const parts = currentRoute();
  if (parts.length === 0) return renderHome();
  if (parts[0] === 'exercises') return renderExercises();
  if (parts[0] === 'history') return renderHistory(parts[1] || null);
  if (parts[0] === 'progress' && parts[1]) return renderProgress(parts[1]);
  if (parts[0] === 'measures') return renderMeasures();
  if (parts[0] === 'session-view' && parts[1]) return renderSessionDetail(parts[1]);
  if (parts[0] === 'routine-new') return renderRoutineEditor(null);
  if (parts[0] === 'routine-edit' && parts[1]) return renderRoutineEditor(parts[1]);
  if (parts[0] === 'session' && parts[1]) return renderSession(parts[1]);
  return renderHome();
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ---------- Resumen de últimas sesiones (home) ----------
function formatDurationHuman(sec) {
  if (sec == null) return null;
  const totalMin = Math.round(sec / 60);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${totalMin}min`;
}

// Una sesión partida en dos días (parcial + continuación) se resume como un
// solo bloque; una parcial sin continuar muestra a 0 los músculos que faltan.
function summarizeSessionParts(routine, parts) {
  const hasDuration = parts.every(p => p.durationSec != null);
  const muscleStats = {};
  const groupSizes = {};
  const groupNames = {};
  let totalExercises = 0;
  parts.forEach(s => {
    const totalSets = s.entries.reduce((sum, e) => sum + e.sets.length, 0) || 1;
    totalExercises += s.entries.length;
    s.entries.forEach(e => {
      // Una superserie = un grupo con al menos 2 ejercicios enlazados ese día.
      if (e.supersetGroup) {
        const k = s.id + ':' + e.supersetGroup;
        groupSizes[k] = (groupSizes[k] || 0) + 1;
        const exName = (getExercise(e.exerciseId) || { name: '?' }).name;
        (groupNames[k] = groupNames[k] || []).push(exName);
      }
      // Un ejercicio combinado (Pecho + Tríceps) cuenta en los dos músculos;
      // su tiempo se reparte a partes iguales para que la suma siga siendo
      // la duración de la sesión.
      const ex = getExercise(e.exerciseId);
      const muscles = muscleNames(ex && ex.muscle);
      const sec = hasDuration ? s.durationSec * (e.sets.length / totalSets) / muscles.length : 0;
      muscles.forEach(muscle => {
        if (!muscleStats[muscle]) muscleStats[muscle] = { count: 0, sec: 0 };
        muscleStats[muscle].count += 1;
        muscleStats[muscle].sec += sec;
      });
    });
  });
  const last = parts[parts.length - 1];
  const partial = !!last.partial;
  const deload = parts.some(p => p.deload);
  const plannedMuscles = [...new Set(routine.slots.flatMap(sl => {
    const ex = getExercise(sl.exerciseId);
    return muscleNames(ex && ex.muscle);
  }))];
  const missingMuscles = partial ? plannedMuscles.filter(m => !muscleStats[m]) : [];
  return {
    date: last.date,
    dates: parts.map(p => p.date),
    gym: [...new Set(parts.map(p => p.gym).filter(Boolean))].join(' + '),
    totalExercises,
    durations: parts.map(p => p.durationSec),
    durationSec: hasDuration ? parts.reduce((n, p) => n + p.durationSec, 0) : null,
    hasDuration,
    supersets: Object.values(groupSizes).filter(n => n >= 2).length,
    supersetPairs: Object.keys(groupSizes).filter(k => groupSizes[k] >= 2).map(k => groupNames[k].join(' + ')),
    partial,
    deload,
    missingMuscles,
    muscleStats,
    notes: parts.map(p => p.notes).filter(Boolean).join(' · '),
  };
}

function computeRoutineSummary(routine) {
  const sessions = db.sessions
    .filter(s => s.routineId === routine.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!sessions.length) return null;

  const consumed = new Set();
  const days = [];
  sessions.forEach(s => {
    if (consumed.has(s.id)) return;
    consumed.add(s.id);
    // La parte 2 (más reciente) aparece antes en la lista y arrastra a su parte 1.
    const first = s.continuesSessionId ? sessions.find(x => x.id === s.continuesSessionId) : null;
    if (first) consumed.add(first.id);
    days.push(summarizeSessionParts(routine, first ? [first, s] : [s]));
  });
  return days;
}

// Mensajes que te dejaste para esta rutina ("hacer gemelos"). Se borran al
// marcarlos como leídos.
function pendingMessagesHtml(routineId) {
  const msgs = (db.messages || []).filter(m => m.routineId === routineId);
  if (!msgs.length) return '';
  return msgs.map(m => `
    <div class="msg-card">
      <div class="msg-text">📨 ${escapeHtml(m.text)}</div>
      <div class="msg-meta">del ${fmtDateShort(m.createdAt)} · <span class="msg-dismiss" data-msg-done="${m.id}">✓ leído</span></div>
    </div>`).join('');
}

function bindMessageDismiss(root, afterDismiss) {
  root.querySelectorAll('[data-msg-done]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    db.messages = (db.messages || []).filter(m => m.id !== el.dataset.msgDone);
    saveDB();
    afterDismiss();
  }));
}

// Al tocar una rutina: ¿entrenar o solo mirarla? Abrir la sesión directamente
// arrancaba el cronómetro y creaba un borrador aunque solo quisieras consultar.
// ---------- Traslado de ejercicios entre rutinas ----------
// db.transfers = [{ id, fromSessionId, fromRoutineId, toRoutineId, slotIds[], createdAt }]
// Lo que quedó sin hacer en una sesión parcial se hace durante otra rutina,
// pero las series se guardan en la sesión de origen (con su propia fecha).
function allTransfers() { return db.transfers || []; }

function findSlotAnywhere(slotId) {
  for (const r of db.routines) {
    const sl = r.slots.find(x => x.id === slotId);
    if (sl) return { routine: r, slot: sl };
  }
  return null;
}

function pendingTransfersFor(routineId) {
  const out = [];
  allTransfers().filter(t => t.toRoutineId === routineId).forEach(t => {
    const from = getRoutine(t.fromRoutineId);
    const session = db.sessions.find(x => x.id === t.fromSessionId);
    if (!from || !session) return;
    t.slotIds.forEach(id => {
      const slot = from.slots.find(sl => sl.id === id);
      if (slot) out.push({ transfer: t, fromRoutine: from, fromSession: session, slot });
    });
  });
  return out;
}

// Huecos de una sesión que siguen sin registrar (ni en ella, ni en su continuación).
function missingSlotsOf(session) {
  const routine = getRoutine(session.routineId);
  if (!routine) return [];
  const done = new Set();
  db.sessions.forEach(s2 => {
    if (s2.id === session.id || s2.continuesSessionId === session.id) s2.entries.forEach(e => done.add(e.slotId));
  });
  const moved = new Set();
  allTransfers().forEach(t => { if (t.fromSessionId === session.id) t.slotIds.forEach(id => moved.add(id)); });
  return routine.slots.filter(sl => !done.has(sl.id) && !moved.has(sl.id));
}

function openTransferDialog(session, afterChange) {
  const missing = missingSlotsOf(session);
  const targets = db.routines.filter(r => r.id !== session.routineId);
  if (!missing.length || !targets.length) { if (afterChange) afterChange(); return; }
  const fromRoutine = getRoutine(session.routineId);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>↗ Trasladar a otra rutina</h2>
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px;">Los harás durante otro entreno, pero se guardarán en esta sesión de ${escapeHtml(fromRoutine ? fromRoutine.name : '')} del ${fmtDateShort(session.date)}.</p>
      <div class="transfer-list">
        ${missing.map(sl => { const ex = getExercise(sl.exerciseId); return `
          <label class="transfer-item"><input type="checkbox" data-tr-slot="${sl.id}" checked /> <span>${escapeHtml(ex ? ex.name : '(ejercicio eliminado)')}</span></label>`; }).join('')}
      </div>
      <div class="field" style="margin-top:12px;">
        <label>Hacerlos en</label>
        <select id="transfer-target">${targets.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}</select>
      </div>
      <button class="btn btn-primary btn-block" id="transfer-ok">↗ Trasladar</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="transfer-cancel">Ahora no</button>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => { if (backdrop.parentNode) document.body.removeChild(backdrop); };
  document.getElementById('transfer-ok').addEventListener('click', () => {
    const slotIds = [...backdrop.querySelectorAll('[data-tr-slot]')].filter(c => c.checked).map(c => c.dataset.trSlot);
    if (!slotIds.length) { showToast('No has marcado ningún ejercicio'); return; }
    const toRoutineId = document.getElementById('transfer-target').value;
    db.transfers = allTransfers();
    const existing = db.transfers.find(t => t.fromSessionId === session.id && t.toRoutineId === toRoutineId);
    if (existing) existing.slotIds = [...new Set(existing.slotIds.concat(slotIds))];
    else db.transfers.push({ id: uid(), fromSessionId: session.id, fromRoutineId: session.routineId, toRoutineId, slotIds, createdAt: new Date().toISOString() });
    saveDB();
    close();
    const target = getRoutine(toRoutineId);
    showToast(`${slotIds.length} ejercicio${slotIds.length === 1 ? '' : 's'} → ${target ? target.name : ''}`);
    if (afterChange) afterChange();
  });
  document.getElementById('transfer-cancel').addEventListener('click', () => { close(); if (afterChange) afterChange(); });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { close(); if (afterChange) afterChange(); } });
}

// Aviso en la home con los traslados pendientes.
function transfersBannerHtml() {
  const rows = allTransfers().filter(t => t.slotIds.length).map(t => {
    const from = getRoutine(t.fromRoutineId), to = getRoutine(t.toRoutineId);
    const ses = db.sessions.find(x => x.id === t.fromSessionId);
    if (!from || !to || !ses) return '';
    const names = t.slotIds.map(id => { const sl = from.slots.find(x => x.id === id); const ex = sl && getExercise(sl.exerciseId); return ex ? ex.name : '?'; }).join(' · ');
    return `<div class="transfer-bar">↗ <b>${escapeHtml(names)}</b> (de ${escapeHtml(from.name)} ${fmtDateShort(ses.date)}) se harán en <b>${escapeHtml(to.name)}</b> · <span class="transfer-cancel" data-cancel-transfer="${t.id}">cancelar</span></div>`;
  }).join('');
  return rows;
}

function bindTransferCancel(afterChange) {
  document.querySelectorAll('[data-cancel-transfer]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    db.transfers = allTransfers().filter(t => t.id !== el.dataset.cancelTransfer);
    saveDB();
    showToast('Traslado cancelado');
    afterChange();
  }));
}

function openRoutineChoice(routineId) {
  const routine = getRoutine(routineId);
  if (!routine) return;
  const inProgress = !!loadSessionDraft(routineId);
  // Última sesión parcial, reciente y aún sin continuar: se ofrece terminarla.
  const last = db.sessions.filter(s => s.routineId === routineId).sort((a, b) => b.date.localeCompare(a.date))[0];
  const CONTINUE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
  const resumable = !inProgress && last && last.partial
    && !db.sessions.some(s => s.continuesSessionId === last.id)
    && (Date.now() - new Date(last.date).getTime()) < CONTINUE_WINDOW_MS ? last : null;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>${escapeHtml(routine.name)}</h2>
      ${pendingMessagesHtml(routineId)}
      ${inProgress ? '<p style="color:var(--green);font-size:13px;margin-top:-8px;">Tienes un entreno en curso de esta rutina.</p>' : ''}
      ${resumable ? `<button class="btn btn-primary btn-block" id="choice-resume">↪ Continuar la sesión del ${fmtDateShort(resumable.date)}</button><div style="height:8px;"></div>` : ''}
      ${resumable && missingSlotsOf(resumable).length && db.routines.length > 1 ? `<button class="btn btn-block" id="choice-transfer">↗ Trasladar lo que falta a otra rutina</button><div style="height:8px;"></div>` : ''}
      <button class="btn ${resumable ? '' : 'btn-primary'} btn-block" id="choice-train">🏋️ ${inProgress ? 'Continuar entreno' : 'Empezar entreno'}</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="choice-view">📋 Consultar rutina</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="choice-progress">📈 Progreso y recomendaciones</button>
      <div style="height:8px;"></div>
      <button class="btn btn-ghost btn-block" id="choice-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => document.body.removeChild(backdrop);
  bindMessageDismiss(backdrop, () => { close(); openRoutineChoice(routineId); });
  document.getElementById('choice-train').addEventListener('click', () => { close(); navigate(`session/${routineId}`); });
  const resumeBtn = document.getElementById('choice-resume');
  if (resumeBtn) resumeBtn.addEventListener('click', () => {
    // Borrador ya enlazado a la parte 1: sus ejercicios salen como hechos.
    saveSessionDraft(routineId, {
      gym: resumable.gym || '',
      askGym: true,
      entries: {},
      restStart: null,
      restSlotId: null,
      sessionStartedAt: Date.now(),
      continuesSessionId: resumable.id,
      doneFrom: { sessionId: resumable.id, date: resumable.date, slotIds: resumable.entries.map(e => e.slotId) },
    });
    close();
    navigate(`session/${routineId}`);
  });
  const transferBtn = document.getElementById('choice-transfer');
  if (transferBtn) transferBtn.addEventListener('click', () => { close(); openTransferDialog(resumable, renderHome); });
  document.getElementById('choice-view').addEventListener('click', () => { close(); navigate(`history/${routineId}`); });
  document.getElementById('choice-progress').addEventListener('click', () => { close(); navigate(`progress/${routineId}`); });
  document.getElementById('choice-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

// ---------- Home: lista de rutinas ----------
// ---------- Semana de descarga ----------
// db.deloadUntil = ISO del último día de descarga. Las sesiones guardadas con
// descarga activa llevan deload:true y no cuentan para Progreso.
function isDeloadActive() {
  if (!db.deloadUntil) return false;
  const end = new Date(db.deloadUntil); end.setHours(23, 59, 59, 999);
  return Date.now() <= end.getTime();
}

function endOfThisWeek() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const sunday = new Date(d.getTime() + ((7 - d.getDay()) % 7) * 24 * 60 * 60 * 1000);
  return sunday;
}

// Aviso discreto si hace más de 14 días de la última medición.
function measureReminderHtml() {
  const last = measuresSorted().pop();
  if (!last) return '';
  const days = Math.floor((Date.now() - new Date(last.date).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 14) return '';
  return `<div class="measure-reminder" data-nav="measures">📏 Última medición hace ${days} días · medir</div>`;
}

function deloadBannerHtml() {
  const until = isDeloadActive() ? new Date(db.deloadUntil) : null;
  return until
    ? `<div class="deload-bar active">🪫 Semana de descarga hasta el ${fmtDateShort(until.toISOString())} · <span class="deload-toggle" id="deload-toggle">desactivar</span></div>`
    : `<div class="deload-bar"><span class="deload-toggle" id="deload-toggle">🪫 Activar semana de descarga</span></div>`;
}

function bindDeloadToggle(afterChange) {
  const el = document.getElementById('deload-toggle');
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isDeloadActive()) {
      db.deloadUntil = null;
      showToast('Descarga desactivada');
    } else {
      const sunday = endOfThisWeek();
      db.deloadUntil = sunday.toISOString();
      showToast(`Descarga activa hasta el ${fmtDateShort(sunday.toISOString())}`);
    }
    saveDB();
    afterChange();
  });
}

// Series por músculo en una ventana de días (combinados cuentan en ambos).
// Las series trasladadas llevan su propia fecha (doneOn) y cuentan el día en
// que se hicieron, aunque se guarden en la sesión de origen.
function weeklyStats(fromMs, toMs) {
  const inWindow = (iso) => { const t = new Date(iso).getTime(); return t >= fromMs && t < toMs; };
  const perMuscle = {};
  let minutes = 0;
  let count = 0;
  db.sessions.forEach(ses => {
    if (inWindow(ses.date)) {
      count++;
      if (ses.durationSec) minutes += ses.durationSec / 60;
    }
    ses.entries.forEach(e => {
      if (!inWindow(e.doneOn || ses.date)) return;
      const ex = getExercise(e.exerciseId);
      muscleNames(ex && ex.muscle).forEach(m => { perMuscle[m] = (perMuscle[m] || 0) + e.sets.length; });
    });
  });
  return { sessions: count, minutes: Math.round(minutes), perMuscle };
}

// Tabla de las últimas 3 semanas naturales (lunes a domingo), una fila por
// semana y las mismas columnas de músculo en todas, sin saltos de línea.
// Series/semana orientativas por músculo; el deltoide anterior ya trabaja en
// los presses, por eso su mínimo es 0. Se pueden cambiar desde la home (🎯).
const DEFAULT_VOLUME_TARGETS = {
  'Pecho': [10, 20], 'Espalda': [10, 20], 'Cuádriceps': [10, 20], 'Isquiotibiales': [8, 16],
  'Tríceps': [8, 16], 'Bíceps': [8, 16], 'Deltoide lateral': [8, 16], 'Deltoide posterior': [6, 12],
  'Deltoide anterior': [0, 8], 'Gemelos': [6, 12], 'Abdominales': [6, 12],
};

function volumeTargetOf(m) {
  const t = db.volumeTargets && db.volumeTargets[m];
  return (t && t.length === 2) ? t : (DEFAULT_VOLUME_TARGETS[m] || [10, 20]);
}

// Clase de color de una celda: la semana en curso no se marca en rojo (aún no ha acabado).
function volumeClass(m, n, current) {
  const [lo, hi] = volumeTargetOf(m);
  if (n > hi) return ' vol-high';
  if (n >= lo && n > 0) return ' vol-ok';
  if (current) return '';
  return ' vol-low';
}

function openVolumeTargetsDialog() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>🎯 Series por semana</h2>
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px;">Rango objetivo por músculo. Verde dentro, rojo por debajo (semanas pasadas), ámbar por encima.</p>
      ${Object.keys(MUSCLE_COLORS).map(m => { const [lo, hi] = volumeTargetOf(m); return `
        <div class="vol-row">
          <span style="color:${MUSCLE_COLORS[m]};">${escapeHtml(m)}</span>
          <input type="number" inputmode="numeric" min="0" data-vol-lo="${escapeHtml(m)}" value="${lo}" /> –
          <input type="number" inputmode="numeric" min="0" data-vol-hi="${escapeHtml(m)}" value="${hi}" />
        </div>`; }).join('')}
      <div style="height:10px;"></div>
      <button class="btn btn-primary btn-block" id="vol-save">Guardar</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="vol-reset">Valores por defecto</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="vol-cancel">Cancelar</button>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => document.body.removeChild(backdrop);
  document.getElementById('vol-save').addEventListener('click', () => {
    const out = {};
    Object.keys(MUSCLE_COLORS).forEach(m => {
      const lo = Number(backdrop.querySelector(`[data-vol-lo="${CSS.escape(m)}"]`).value);
      const hi = Number(backdrop.querySelector(`[data-vol-hi="${CSS.escape(m)}"]`).value);
      if (!isNaN(lo) && !isNaN(hi) && hi >= lo) out[m] = [lo, hi];
    });
    db.volumeTargets = out;
    saveDB();
    close();
    renderHome();
  });
  document.getElementById('vol-reset').addEventListener('click', () => { delete db.volumeTargets; saveDB(); close(); renderHome(); });
  document.getElementById('vol-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

function weeklySummaryHtml() {
  const DAY = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Lunes de esta semana (getDay: 0 = domingo)
  const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY);
  const weeks = [0, 1, 2].map(i => {
    const from = new Date(monday.getTime() - i * 7 * DAY);
    const to = new Date(from.getTime() + 7 * DAY);
    return { from, to, stats: weeklyStats(from.getTime(), to.getTime()) };
  });
  if (!weeks.some(w => w.stats.sessions)) return '';
  const muscles = Object.keys(MUSCLE_COLORS).filter(m => weeks.some(w => w.stats.perMuscle[m]));
  const fmt = (d) => `${d.getDate()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const head = `<tr><th>Semana</th><th>Ses</th><th>Min</th>${muscles.map(m => { const [lo, hi] = volumeTargetOf(m); return `<th style="color:${MUSCLE_COLORS[m]};">${escapeHtml(muscleAbbr(m))}<br><small>${lo}–${hi}</small></th>`; }).join('')}</tr>`;
  const rows = weeks.map((w, i) => {
    const last = new Date(w.to.getTime() - DAY);
    const label = i === 0 ? 'Esta' : (w.from.getMonth() === last.getMonth() ? `${w.from.getDate()}–${fmt(last)}` : `${fmt(w.from)}–${fmt(last)}`);
    return `<tr${i === 0 ? ' class="week-current"' : ''}>
      <td class="date-cell">${label}</td>
      <td>${w.stats.sessions || '·'}</td>
      <td>${w.stats.minutes || '·'}</td>
      ${muscles.map(m => `<td class="vol-cell${volumeClass(m, w.stats.perMuscle[m] || 0, i === 0)}">${w.stats.perMuscle[m] || '·'}</td>`).join('')}
    </tr>`;
  }).join('');
  return `
    <div class="card weekly-card">
      <div class="weekly-head">📊 Series por músculo · lunes a domingo <span class="weekly-targets" id="vol-targets-btn">🎯 objetivos</span></div>
      <div class="history-table-wrap"><table class="history-table week-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    </div>`;
}

function renderHome() {
  const routines = db.routines;

  const cards = routines.map(r => {
    const lastSession = db.sessions
      .filter(s => s.routineId === r.id)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const lastText = lastSession ? `Última vez: ${fmtDate(lastSession.date)}` : 'Sin sesiones registradas';

    const summaries = computeRoutineSummary(r);
    const VISIBLE = 3;
    const dayHtml = (day, hidden) => {
      const head = [
        // Mismo día en dos partes (mañana y tarde): una fecha y el nº de partes.
        [...new Set(day.dates.map(fmtDateShort))].join(' + ') + (day.dates.length > 1 && new Set(day.dates.map(fmtDateShort)).size < day.dates.length ? ` · ${day.dates.length} partes` : ''),
        `${day.totalExercises} ej`,
        day.hasDuration ? day.durations.map(fmtMinutesShort).join('+') : null,
        day.supersets ? `🔗${day.supersets}` : null,
        day.partial ? '⏸ parcial' : null,
        day.deload ? '🪫 descarga' : null,
        day.gym ? `📍${escapeHtml(day.gym)}` : null,
      ].filter(Boolean).join(' · ');
      const chips = Object.entries(day.muscleStats).map(([m, st]) => {
        const color = MUSCLE_COLORS[muscleParts(m)[0]] || 'var(--border)';
        const timeTxt = day.hasDuration ? `·${fmtMinutesShort(st.sec)}` : '';
        return `<span class="muscle-chip" style="border-color:${color};color:${color};">${escapeHtml(muscleAbbr(m))} ${st.count}${timeTxt}</span>`;
      }).join('') + day.missingMuscles.map(m => `<span class="muscle-chip muscle-chip-zero">${escapeHtml(muscleAbbr(m))} 0</span>`).join('');
      return `
          <div class="summary-day${hidden ? ' summary-extra' : ''}"${hidden ? ' hidden' : ''}>
            <div class="summary-row">${head}</div>
            <div class="summary-muscles">${chips}</div>
            ${day.supersetPairs.length ? `<div class="summary-notes">🔗 ${escapeHtml(day.supersetPairs.join(' · '))}</div>` : ''}
            ${day.notes ? `<div class="summary-notes">📝 ${escapeHtml(day.notes)}</div>` : ''}
          </div>`;
    };
    const extra = summaries ? summaries.length - VISIBLE : 0;
    const summaryHtml = summaries ? `
      <div class="routine-summary">
        ${summaries.map((day, i) => dayHtml(day, i >= VISIBLE)).join('')}
        ${extra > 0 ? `<button class="summary-more" data-more="${r.id}">▾ ver ${extra} más</button>` : ''}
      </div>
    ` : '';

    return `
      <div class="card routine-card" data-open-routine="${r.id}">
        <div style="width:100%;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <h3>${escapeHtml(r.name)}</h3>
              <p>${r.slots.length} ejercicio${r.slots.length === 1 ? '' : 's'} · ${lastText}</p>
            </div>
            <div class="chevron">›</div>
          </div>
          ${summaryHtml}
        </div>
      </div>`;
  }).join('');

  app.innerHTML = `
    <div class="topbar">
      <h1>Mis rutinas</h1>
      <button class="btn btn-icon" data-nav="measures" title="Mediciones">📏</button>
      <button class="btn btn-icon" data-nav="history" title="Historial de sesiones">📅</button>
      <button class="btn btn-icon" data-nav="exercises" title="Ejercicios">🏋️</button>
    </div>
    <div class="backup-banner" id="backup-banner"${getGhToken() && isBackupPending() ? '' : ' hidden'}>
      ☁️ Hay cambios sin copiar a GitHub · <span class="backup-retry" id="backup-retry-btn">subir ahora</span>
    </div>
    <div class="container">
      ${transfersBannerHtml()}
      ${measureReminderHtml()}
      ${deloadBannerHtml()}
      ${weeklySummaryHtml()}
      ${routines.length ? cards : '<div class="empty-state">Todavía no tienes rutinas.<br>Crea la primera para empezar.</div>'}
      <div class="fab-row">
        <button class="btn btn-primary btn-block" data-nav="routine-new">+ Nueva rutina</button>
      </div>
    </div>
  `;

  app.querySelectorAll('[data-open-routine]').forEach(el => {
    el.addEventListener('click', () => openRoutineChoice(el.dataset.openRoutine));
  });
  document.getElementById('backup-retry-btn').addEventListener('click', () => pushBackupToGitHub(true));
  bindDeloadToggle(renderHome);
  bindTransferCancel(renderHome);
  const volBtn = document.getElementById('vol-targets-btn');
  if (volBtn) volBtn.addEventListener('click', openVolumeTargetsDialog);
  // El desplegable vive dentro de la tarjeta, que entera abre la sesión:
  // hay que frenar el click para que no navegue.
  app.querySelectorAll('[data-more]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const extras = btn.closest('.routine-summary').querySelectorAll('.summary-extra');
      const open = extras[0].hidden;
      extras.forEach(d => { d.hidden = !open; });
      btn.textContent = open ? '▴ ver menos' : `▾ ver ${extras.length} más`;
    });
  });
  app.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.nav));
  });
}

// ---------- Gestión de ejercicios ----------
function renderExercises() {
  const items = db.exercises.map(e => `
    <div class="list-item" style="${muscleBackgroundStyle(e.muscle)}border-radius:12px;padding-left:10px;padding-right:10px;">
      <div data-edit-exercise="${e.id}" style="flex:1;cursor:pointer;">
        <div class="name">${escapeHtml(e.name)}</div>
        ${e.muscle ? `<div class="muscle-inline" style="color:${MUSCLE_COLORS[muscleParts(e.muscle)[0]] || 'var(--text-dim)'}">${escapeHtml(e.muscle)}</div>` : ''}
        ${e.notes ? `<div class="notes-line">${escapeHtml(e.notes)}</div>` : ''}
      </div>
      <button class="btn-ghost" data-edit-exercise="${e.id}" style="font-size:16px;">✎</button>
      <button class="btn-ghost" data-del-exercise="${e.id}" style="font-size:18px;">🗑</button>
    </div>
  `).join('');

  app.innerHTML = `
    <div class="topbar">
      <button class="btn btn-ghost" data-nav="">← Atrás</button>
      <h1>Ejercicios</h1>
    </div>
    <div class="container">
      <div class="tabs">
        <button class="tab active" data-tab="ex">🏋️ Ejercicios</button>
        <button class="tab" data-tab="gym">📍 Gimnasios</button>
      </div>
      <div id="tab-gym" hidden>
        <div class="card">
          <div class="field">
            <label>Nuevo gimnasio</label>
            <input id="new-gym-name" placeholder="Ej. Basic-Fit Centro" />
          </div>
          <button class="btn btn-primary btn-block" id="add-gym-btn">Añadir gimnasio</button>
        </div>
        <div class="section-title">Gimnasios (${(db.gyms || []).length})</div>
        <div class="card">
          ${(db.gyms || []).map(g => `
            <div class="list-item">
              <div class="name" style="flex:1;">📍 ${escapeHtml(g)}</div>
              <button class="btn-ghost" data-rename-gym="${escapeHtml(g)}" style="font-size:16px;">✎</button>
              <button class="btn-ghost" data-del-gym="${escapeHtml(g)}" style="font-size:18px;">🗑</button>
            </div>`).join('') || '<div class="empty-state">Sin gimnasios todavía.</div>'}
        </div>
      </div>
      <div id="tab-ex">
      <div class="card">
        <div class="field">
          <label>Nombre del ejercicio</label>
          <input id="new-ex-name" placeholder="Ej. Press banca" />
        </div>
        <div class="field">
          <label>Grupo muscular (opcional)</label>
          <input id="new-ex-muscle" placeholder="Ej. Pecho" />
        </div>
        <button class="btn btn-primary btn-block" id="add-exercise-btn">Añadir ejercicio</button>
      </div>
      <div class="section-title">Biblioteca (${db.exercises.length})</div>
      <input id="lib-search" class="picker-search" placeholder="🔍 Filtrar por nombre o músculo" autocomplete="off" />
      <div class="card" id="lib-list">
        ${db.exercises.length ? items : '<div class="empty-state">Añade tu primer ejercicio arriba.</div>'}
      </div>
      </div>
      <div class="section-title">Datos</div>
      <div class="card">
        <button class="btn btn-block" id="export-db-btn">Exportar copia de seguridad</button>
        <div style="height:8px;"></div>
        <button class="btn btn-block" id="import-db-btn">Importar datos</button>
        <input type="file" id="import-db-input" accept="application/json" style="display:none;" />
      </div>
      <div class="section-title">Copia en GitHub</div>
      <div class="card">
        <button class="btn btn-block" id="gh-config-btn">${getGhToken() ? '🔗 Cambiar token de GitHub' : '🔗 Configurar copia en GitHub'}</button>
        <div style="height:8px;"></div>
        <button class="btn btn-block" id="gh-sync-now-btn">☁️ Sincronizar ahora</button>
        <div class="rest-note" style="margin-top:8px;">${getGhToken() ? 'Activado: cada cambio se sube a GitHub; si falla, se reintenta solo al volver la conexión.' : 'Sin configurar todavía: los datos solo se guardan en este dispositivo.'}</div>
      </div>
    </div>
  `;

  app.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.nav));
  });

  // Pestañas ejercicios / gimnasios (se recuerda la última abierta).
  const showTab = (name) => {
    document.getElementById('tab-ex').hidden = name !== 'ex';
    document.getElementById('tab-gym').hidden = name !== 'gym';
    app.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    try { sessionStorage.setItem('hipertrofia_ex_tab', name); } catch (e) {}
  };
  app.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  try { if (sessionStorage.getItem('hipertrofia_ex_tab') === 'gym') showTab('gym'); } catch (e) {}

  const saveGyms = (next) => {
    db.gyms = [...new Set(next.map(g => g.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    saveDB();
    renderExercises();
  };
  document.getElementById('add-gym-btn').addEventListener('click', () => {
    const name = document.getElementById('new-gym-name').value.trim();
    if (!name) { showToast('Escribe el nombre del gimnasio'); return; }
    const canon = canonicalGym(name);
    if (canon !== name) { showToast(`Ya existe como "${canon}"`); return; }
    saveGyms([...(db.gyms || []), name]);
    showToast('Gimnasio añadido');
  });
  app.querySelectorAll('[data-rename-gym]').forEach(el => el.addEventListener('click', () => {
    const from = el.dataset.renameGym;
    const to = (prompt('Nuevo nombre', from) || '').trim();
    if (!to || to === from) return;
    db.sessions.forEach(ses => { if (ses.gym === from) ses.gym = to; });
    saveGyms((db.gyms || []).map(g => g === from ? to : g));
  }));
  app.querySelectorAll('[data-del-gym]').forEach(el => el.addEventListener('click', () => {
    const g = el.dataset.delGym;
    const used = db.sessions.filter(ses => ses.gym === g).length;
    if (!confirm(`¿Quitar "${g}" de la lista?${used ? ` Las ${used} sesiones que lo tienen conservan el nombre.` : ''}`)) return;
    saveGyms((db.gyms || []).filter(x => x !== g));
  }));

  document.getElementById('add-exercise-btn').addEventListener('click', () => {
    const name = document.getElementById('new-ex-name').value.trim();
    const muscle = document.getElementById('new-ex-muscle').value.trim();
    if (!name) return;
    db.exercises.push({ id: uid(), name, muscle });
    saveDB();
    renderExercises();
  });

  app.querySelectorAll('[data-del-exercise]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = el.dataset.delExercise;
      const usedInRoutine = db.routines.some(r => r.slots.some(s => s.exerciseId === id));
      if (usedInRoutine && !confirm('Este ejercicio se usa en alguna rutina. ¿Eliminarlo igualmente?')) return;
      db.exercises = db.exercises.filter(e => e.id !== id);
      saveDB();
      renderExercises();
    });
  });

  // Filtro de la biblioteca: oculta filas sin tocar sus listeners.
  document.getElementById('lib-search').addEventListener('input', (e) => {
    const q = e.target.value;
    app.querySelectorAll('#lib-list .list-item').forEach(row => {
      const id = row.querySelector('[data-edit-exercise]').dataset.editExercise;
      const ex = db.exercises.find(x => x.id === id);
      row.hidden = !!ex && !matchesSearch(ex, q);
    });
  });

  app.querySelectorAll('[data-edit-exercise]').forEach(el => {
    el.addEventListener('click', () => {
      const ex = getExercise(el.dataset.editExercise);
      if (ex) openExerciseEditor(ex, renderExercises);
    });
  });

  document.getElementById('export-db-btn').addEventListener('click', exportDB);
  document.getElementById('import-db-btn').addEventListener('click', () => {
    document.getElementById('import-db-input').click();
  });
  document.getElementById('import-db-input').addEventListener('change', (e) => {
    if (e.target.files[0]) importDBFile(e.target.files[0]);
  });

  document.getElementById('gh-config-btn').addEventListener('click', () => {
    openGhConfigPrompt(renderExercises);
  });
  document.getElementById('gh-sync-now-btn').addEventListener('click', () => {
    if (!getGhToken()) { openGhConfigPrompt(() => pushBackupToGitHub(true)); return; }
    pushBackupToGitHub(true);
  });
}

function exportDB() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hipertrofia_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importDBFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.exercises || !parsed.routines || !parsed.sessions) throw new Error('Formato inválido');
      if (!confirm('Esto reemplazará TODOS tus datos actuales por los del fichero importado. ¿Continuar?')) return;
      db = parsed;
      saveDB();
      runMigrations();
      showToast('Datos importados');
      navigate('');
    } catch (e) {
      alert('No se pudo importar: ' + e.message);
    }
  };
  reader.readAsText(file);
}

// ---------- Editor de rutina (crear / editar plantilla) ----------
function renderRoutineEditor(routineId) {
  const editing = routineId ? getRoutine(routineId) : null;
  const draft = editing
    ? { name: editing.name, slots: editing.slots.map(s => ({ ...s })) }
    : { name: '', slots: [] };

  let dragIdx = null;

  function onDragMove(e) {
    if (dragIdx == null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el && el.closest('.slot-editor-row');
    if (!row) return;
    const targetIdx = Number(row.dataset.idx);
    if (!isNaN(targetIdx) && targetIdx !== dragIdx) {
      const [moved] = draft.slots.splice(dragIdx, 1);
      draft.slots.splice(targetIdx, 0, moved);
      dragIdx = targetIdx;
      paint();
      const newRow = app.querySelector(`.slot-editor-row[data-idx="${targetIdx}"]`);
      if (newRow) newRow.classList.add('dragging');
    }
  }
  function onDragEnd() {
    if (dragIdx == null) return;
    dragIdx = null;
    app.querySelectorAll('.slot-editor-row.dragging').forEach(r => r.classList.remove('dragging'));
  }
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  currentCleanup = () => {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
  };

  function paint() {
    const slotRows = draft.slots.map((slot, idx) => {
      const ex = getExercise(slot.exerciseId);
      return `
        <div class="slot-editor-row" data-idx="${idx}">
          <span class="drag-handle" data-drag-handle="${idx}">⠿</span>
          <div class="name">${idx + 1}. ${ex ? escapeHtml(ex.name) : '(ejercicio eliminado)'}${slot.supersetGroup ? ' <span class="ss-tag">SS</span>' : ''}</div>
          <label class="slot-rest" title="Descanso objetivo">⏱ <input type="text" inputmode="numeric" data-slot-rest="${idx}" value="${slot.restSec ?? ''}" placeholder="s" />s</label>
          <label class="slot-rest" title="Repes objetivo (de–a)">🎯 <input type="number" inputmode="numeric" data-slot-replo="${idx}" value="${slot.repLo ?? ''}" placeholder="de" />–<input type="number" inputmode="numeric" data-slot-rephi="${idx}" value="${slot.repHi ?? ''}" placeholder="a" /></label>
          ${editing && draft.slots.length > 1 ? `<button class="rm" data-merge="${idx}" title="Fusionar con otro ejercicio de esta rutina">🔗</button>` : ''}
          <button class="rm" data-rm="${idx}">✕</button>
        </div>`;
    }).join('');

    app.innerHTML = `
      <div class="topbar">
        <button class="btn btn-ghost" data-nav="">← Atrás</button>
        <h1>${editing ? 'Editar rutina' : 'Nueva rutina'}</h1>
      </div>
      <div class="container">
        <div class="field">
          <label>Nombre de la rutina</label>
          <input id="routine-name" placeholder="Ej. Empuje A" value="${escapeHtml(draft.name)}" />
        </div>
        <div class="section-title">Ejercicios (${draft.slots.length})</div>
        <div class="card">
          ${draft.slots.length ? slotRows : '<div class="empty-state">Añade ejercicios a la rutina.</div>'}
        </div>
        <button class="btn btn-block" id="add-slot-btn">+ Añadir ejercicio</button>
        <div class="fab-row">
          <button class="btn btn-primary btn-block" id="save-routine-btn">Guardar rutina</button>
        </div>
        ${editing ? '<div class="fab-row"><button class="btn btn-danger btn-block" id="del-routine-btn">Eliminar rutina</button></div>' : ''}
      </div>
    `;

    app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));

    document.getElementById('routine-name').addEventListener('input', e => { draft.name = e.target.value; });

    app.querySelectorAll('[data-drag-handle]').forEach(el => el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragIdx = Number(el.dataset.dragHandle);
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      const row = el.closest('.slot-editor-row');
      if (row) row.classList.add('dragging');
    }));

    app.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
      draft.slots.splice(Number(el.dataset.rm), 1);
      paint();
    }));

    app.querySelectorAll('[data-slot-rest]').forEach(el => el.addEventListener('input', () => {
      const n = parseSeconds(el.value);
      if (n === undefined) return;
      draft.slots[Number(el.dataset.slotRest)].restSec = n;
    }));
    app.querySelectorAll('[data-slot-replo]').forEach(el => el.addEventListener('input', () => {
      const n = Number(el.value);
      draft.slots[Number(el.dataset.slotReplo)].repLo = n > 0 ? n : null;
    }));
    app.querySelectorAll('[data-slot-rephi]').forEach(el => el.addEventListener('input', () => {
      const n = Number(el.value);
      draft.slots[Number(el.dataset.slotRephi)].repHi = n > 0 ? n : null;
    }));

    app.querySelectorAll('[data-merge]').forEach(el => el.addEventListener('click', () => {
      const idx = Number(el.dataset.merge);
      const thisSlot = draft.slots[idx];
      const others = draft.slots.filter((s) => s.id !== thisSlot.id);
      openSlotMergePicker(others, (targetSlotId) => {
        const targetSlot = draft.slots.find(s => s.id === targetSlotId);
        const targetEx = getExercise(targetSlot.exerciseId);
        if (!confirm(`Esto fusionará todo el histórico de este ejercicio con "${targetEx ? targetEx.name : '?'}". Esta acción no se puede deshacer. ¿Continuar?`)) return;
        db.sessions.forEach(s => {
          if (s.routineId !== editing.id) return;
          s.entries.forEach(entry => {
            if (entry.slotId === thisSlot.id) {
              entry.slotId = targetSlot.id;
              entry.exerciseId = targetSlot.exerciseId;
            }
          });
        });
        draft.slots = draft.slots.filter(s => s.id !== thisSlot.id);
        editing.slots = draft.slots.map(s => ({ ...s }));
        saveDB();
        showToast('Ejercicios fusionados');
        paint();
      });
    }));

    document.getElementById('add-slot-btn').addEventListener('click', () => {
      openExercisePicker('Añadir ejercicio a la rutina', (exerciseId) => {
        draft.slots.push({ id: uid(), exerciseId });
        paint();
      });
    });

    document.getElementById('save-routine-btn').addEventListener('click', () => {
      const name = draft.name.trim();
      if (!name) { showToast('Ponle un nombre a la rutina'); return; }
      if (!draft.slots.length) { showToast('Añade al menos un ejercicio'); return; }
      if (editing) {
        editing.name = name;
        editing.slots = draft.slots;
      } else {
        db.routines.push({ id: uid(), name, slots: draft.slots });
      }
      saveDB();
      navigate('');
    });

    const delBtn = document.getElementById('del-routine-btn');
    if (delBtn) delBtn.addEventListener('click', () => {
      if (!confirm('¿Eliminar esta rutina? El histórico de sesiones se conservará pero no podrás abrirla desde aquí.')) return;
      db.routines = db.routines.filter(r => r.id !== editing.id);
      saveDB();
      navigate('');
    });
  }

  paint();
}

// ---------- Selector genérico de ejercicio (modal) ----------
function searchKey(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function matchesSearch(exercise, query) {
  const q = searchKey(query).trim();
  if (!q) return true;
  const hay = searchKey(exercise.name + ' ' + (exercise.muscle || ''));
  return q.split(/\s+/).every(tok => hay.includes(tok));
}

function exerciseRowHtml(e) {
  return `<div class="pick-row" data-pick="${e.id}">${escapeHtml(e.name)}${e.muscle ? ` <span style="color:var(--text-dim);font-size:12px;">· ${escapeHtml(e.muscle)}</span>` : ''}</div>`;
}

function openExercisePicker(title, onPick, opts = {}) {
  openMuscleGroupPicker(title, (muscle) => {
    if (muscle === '__DELETE__') { opts.onDelete && opts.onDelete(); return; }
    openExerciseListForMuscle(title, muscle, onPick);
  }, { ...opts, onPickExercise: onPick });
}

function openMuscleGroupPicker(title, onPickMuscle, opts = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const groups = Object.keys(MUSCLE_COLORS);
  const deleteRow = opts.onDelete
    ? `<div class="pick-row pick-row-danger" data-group="__DELETE__">🗑 Eliminar este ejercicio de la rutina</div>`
    : '';
  const groupRows = groups.map(m => `<div class="pick-row" data-group="${escapeHtml(m)}" style="color:${MUSCLE_COLORS[m]};">${escapeHtml(m)}</div>`).join('');
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>${escapeHtml(title)}</h2>
      <input id="picker-quick-search" class="picker-search" placeholder="🔍 Buscar ejercicio (ej. press inclinado)" autocomplete="off" />
      <div id="picker-quick-results" hidden></div>
      <div id="picker-groups">
        <p style="color:var(--text-dim);font-size:13px;margin:0 0 6px;">…o elige por músculo</p>
        ${deleteRow}
        <div class="pick-row" data-group="__ALL__">Todos los ejercicios</div>
        ${groupRows}
        <div class="pick-row" data-group="">Sin músculo asignado</div>
      </div>
      <button class="btn btn-block" id="picker-cancel" style="margin-top:10px;">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => document.body.removeChild(backdrop);
  backdrop.querySelectorAll('[data-group]').forEach(el => el.addEventListener('click', () => {
    close();
    onPickMuscle(el.dataset.group);
  }));

  // Resultados directos mientras se escribe, sin pasar por el músculo.
  const search = document.getElementById('picker-quick-search');
  const results = document.getElementById('picker-quick-results');
  const groupsBox = document.getElementById('picker-groups');
  search.addEventListener('input', () => {
    const q = search.value.trim();
    results.hidden = !q;
    groupsBox.hidden = !!q;
    if (!q) return;
    const found = db.exercises.filter(e => matchesSearch(e, q)).slice(0, 30);
    results.innerHTML = (found.map(exerciseRowHtml).join('') || '<div class="empty-state" style="padding:14px;">Nada con ese nombre.</div>')
      + `<div class="pick-row" data-create-new="1">+ Crear «${escapeHtml(q)}» como ejercicio nuevo</div>`;
    results.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => { close(); opts.onPickExercise(el.dataset.pick); }));
    results.querySelector('[data-create-new]').addEventListener('click', () => { close(); openNewExerciseForm('', opts.onPickExercise, q); });
  });
  setTimeout(() => search.focus(), 50);

  document.getElementById('picker-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

function openExerciseListForMuscle(title, muscle, onPick) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>${escapeHtml(title)}</h2>
      <input id="picker-search" placeholder="Buscar ejercicio..." style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);margin-bottom:10px;box-sizing:border-box;" />
      <button class="btn btn-block" id="picker-create-new" style="margin-bottom:10px;">+ Crear ejercicio nuevo${muscle && muscle !== '__ALL__' ? ` (${escapeHtml(muscle)})` : ''}</button>
      <div id="picker-list"></div>
      <button class="btn btn-block" id="picker-cancel" style="margin-top:10px;">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);

  const base = muscle === '__ALL__' ? db.exercises : db.exercises.filter(e => (e.muscle || '') === muscle);

  function paintList(filter) {
    const list = document.getElementById('picker-list');
    const filtered = base.filter(e => matchesSearch(e, filter));
    list.innerHTML = filtered.map(exerciseRowHtml).join('')
      || '<div class="empty-state">Sin resultados en este grupo.</div>';
    list.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => {
      document.body.removeChild(backdrop);
      onPick(el.dataset.pick);
    }));
  }

  paintList('');
  document.getElementById('picker-search').addEventListener('input', e => paintList(e.target.value));
  document.getElementById('picker-create-new').addEventListener('click', () => {
    document.body.removeChild(backdrop);
    openNewExerciseForm(muscle === '__ALL__' ? '' : muscle, onPick);
  });
  document.getElementById('picker-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
}

function openNewExerciseForm(muscle, onCreated, presetName) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>Nuevo ejercicio</h2>
      <div class="field">
        <label>Nombre</label>
        <input id="new-ex2-name" placeholder="Ej. Press banca" value="${escapeHtml(presetName || '')}" />
      </div>
      <div class="field">
        <label>Grupo muscular</label>
        <input id="new-ex2-muscle" value="${escapeHtml(muscle || '')}" placeholder="Ej. Pecho" />
      </div>
      <div class="field">
        <label>Observaciones (opcional)</label>
        <input id="new-ex2-notes" placeholder="Ej. banco pos. 2" />
      </div>
      <button class="btn btn-primary btn-block" id="new-ex2-save">Crear y usar</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="new-ex2-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.getElementById('new-ex2-save').addEventListener('click', () => {
    const name = document.getElementById('new-ex2-name').value.trim();
    if (!name) return;
    const newEx = {
      id: uid(),
      name,
      muscle: document.getElementById('new-ex2-muscle').value.trim(),
      notes: document.getElementById('new-ex2-notes').value.trim(),
    };
    db.exercises.push(newEx);
    saveDB();
    document.body.removeChild(backdrop);
    onCreated(newEx.id);
  });
  document.getElementById('new-ex2-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
}

// ---------- Selector de hueco para fusionar (dentro de la misma rutina) ----------
function openSlotMergePicker(slots, onPick) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const rows = slots.map(s => {
    const ex = getExercise(s.exerciseId);
    return `<div class="pick-row" data-pick="${s.id}">${escapeHtml(ex ? ex.name : '?')}</div>`;
  }).join('') || '<div class="empty-state">No hay otro ejercicio con el que fusionar.</div>';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>Fusionar con...</h2>
      <div>${rows}</div>
      <button class="btn btn-block" id="merge-cancel" style="margin-top:10px;">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => {
    document.body.removeChild(backdrop);
    onPick(el.dataset.pick);
  }));
  document.getElementById('merge-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
}

// ---------- Editor de ejercicio (nombre, músculo, notas) ----------
function openExerciseEditor(ex, onSaved) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>Editar ejercicio</h2>
      <div class="field">
        <label>Nombre</label>
        <input id="edit-ex-name" value="${escapeHtml(ex.name)}" />
      </div>
      <div class="field">
        <label>Grupo muscular (opcional)</label>
        <input id="edit-ex-muscle" value="${escapeHtml(ex.muscle || '')}" />
      </div>
      <div class="field">
        <label>Observaciones (ajuste de máquina, posición del banco...)</label>
        <input id="edit-ex-notes" placeholder="Ej. banco pos. 2" value="${escapeHtml(ex.notes || '')}" />
      </div>
      <button class="btn btn-primary btn-block" id="edit-ex-save">Guardar</button>
      <div style="height:8px;"></div>
      <button class="btn btn-block" id="edit-ex-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);

  document.getElementById('edit-ex-save').addEventListener('click', () => {
    const name = document.getElementById('edit-ex-name').value.trim();
    if (!name) return;
    ex.name = name;
    ex.muscle = document.getElementById('edit-ex-muscle').value.trim();
    ex.notes = document.getElementById('edit-ex-notes').value.trim();
    saveDB();
    document.body.removeChild(backdrop);
    if (onSaved) onSaved();
  });
  document.getElementById('edit-ex-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
}

// ---------- Formateo de series (histórico) ----------
function formatSetCell(s) {
  const w = s.weight === '' || s.weight == null ? '?' : s.weight;
  // Unilateral: der+izq (reps = derecha, reps2 = izquierda).
  const uni = s.reps2 != null && s.reps2 !== '';
  let main = uni
    ? `${w}×${s.reps}d·${s.reps2}i`
    : `${w}×${s.reps ?? '?'}`;
  if (s.partialReps != null) main += s.partialReps2 != null ? ` +${s.partialReps}/${s.partialReps2}p` : ` +${s.partialReps}p`;
  const sub = [];
  if (uni) sub.push('UNI');
  if (s.partialReps != null) sub.push('PARC');
  if (s.dropset) sub.push('DROP');
  if (s.restPause) sub.push(s.pauseSec ? `RP ⏱${s.pauseSec}s` : 'RP');
  if (s.rir !== null && s.rir !== undefined && s.rir !== '') {
    sub.push(s.rir2 !== null && s.rir2 !== undefined && s.rir2 !== '' ? `RIR${s.rir}/${s.rir2}` : `RIR${s.rir}`);
  }
  if (s.restSec !== null && s.restSec !== undefined) sub.push(`⏱${s.restSec}s`);
  return `<div class="cell-main">${escapeHtml(String(main))}</div>${sub.length ? `<div class="cell-sub">${escapeHtml(sub.join(' · '))}</div>` : ''}`;
}

function mmss(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* not available / denied, ignore */ }
}
document.addEventListener('visibilitychange', async () => {
  if (wakeLock && document.visibilityState === 'visible') {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
});

// ---------- Aviso de descanso (sonido + vibración best-effort) ----------
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* Web Audio not available */ }
}
function playRestBeep() {
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch (e) { /* iOS Safari never implements the Vibration API — silent no-op */ }
  try {
    if (!audioCtx) return;
    [0, 400].forEach(delay => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(audioCtx.destination);
      const t = audioCtx.currentTime + delay / 1000;
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch (e) { /* Web Audio blocked, ignore */ }
}

// ---------- Historial de sesiones guardadas ----------
// Sube la copia a GitHub tras un rato sin cambios, para no disparar una subida
// por cada tecla mientras se corrige una sesión.
let ghPushTimer = null;
function scheduleGhBackup() {
  if (!getGhToken()) return;
  clearTimeout(ghPushTimer);
  ghPushTimer = setTimeout(() => pushBackupToGitHub(true), 3000);
}

function sessionRowHtml(s, showRoutine) {
  const routine = getRoutine(s.routineId);
  const totalSets = s.entries.reduce((n, e) => n + e.sets.length, 0);
  const meta = [
    `${s.entries.length} ejercicios`,
    `${totalSets} series`,
    s.durationSec != null ? formatDurationHuman(s.durationSec) : null,
    s.partial ? '⏸ parcial' : null,
    s.deload ? '🪫 descarga' : null,
    s.continuesSessionId ? '↪ continuación' : null,
    s.gym ? `📍 ${s.gym}` : null,
  ].filter(Boolean).join(' · ');
  const title = showRoutine
    ? `${fmtDate(s.date)} · ${escapeHtml(routine ? routine.name : 'Rutina eliminada')}`
    : fmtDate(s.date);
  return `
      <div class="list-item" data-open-session="${s.id}" style="cursor:pointer;">
        <div style="flex:1;">
          <div class="name">${title}</div>
          <div class="muscle">${escapeHtml(meta)}</div>
          ${s.notes ? `<div class="notes-line">${escapeHtml(s.notes)}</div>` : ''}
        </div>
        <div class="chevron">›</div>
      </div>`;
}

// Sin routineId: todas las sesiones. Con routineId: "consultar rutina", es
// decir, sus ejercicios y solo sus sesiones.
// ---------- Progreso y recomendaciones ----------
// Primer número de un valor que puede venir compuesto: "59/52" (drop set),
// "10+3" (rest-pause), "8".
function firstNum(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

// 1RM estimado (Epley). Sirve para comparar sesiones aunque cambien peso y repes.
function e1rm(w, r) {
  if (!w || !r) return 0;
  return w * (1 + r / 30);
}

const LOWER_BODY = ['Cuádriceps', 'Isquiotibiales', 'Gemelos'];

// ---------- Exportar CSV ----------
// Separador ; y coma decimal (Excel en español), con BOM para que respete las tildes.
function csvCell(v) {
  if (v == null) return '';
  let t = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function csvText(header, rows) {
  return '\ufeff' + [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
}

// En el móvil abre el menú de compartir (Drive, WhatsApp…); si no, descarga.
async function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], filename, { type: 'text/csv' });
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Una fila por serie. routineId opcional para exportar solo una rutina.
function sessionsCsv(routineId) {
  const header = ['Fecha', 'Hora', 'Rutina', 'Gimnasio', 'Parcial', 'Descarga', 'Duración min', 'Ejercicio', 'Músculo', 'Serie', 'Peso kg', 'Reps', 'Reps izq', 'RIR', 'RIR izq', 'Técnica', 'Parciales', 'Pausa s', 'Descanso s', 'Superserie', 'Orden real', 'Notas'];
  const rows = [];
  db.sessions
    .filter(ses => !routineId || ses.routineId === routineId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(ses => {
      const r = getRoutine(ses.routineId);
      const d = new Date(ses.date);
      const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      ses.entries.forEach(e => {
        const ex = getExercise(e.exerciseId);
        e.sets.forEach((st, i) => rows.push([
          fmtDate(st.doneOn || e.doneOn || ses.date), hora, r ? r.name : '', ses.gym || '', ses.partial ? 'sí' : '', ses.deload ? 'sí' : '',
          ses.durationSec ? Math.round(ses.durationSec / 60) : '',
          ex ? ex.name : '', ex ? ex.muscle || '' : '', i + 1,
          st.weight, st.reps, st.reps2, st.rir, st.rir2,
          [st.dropset ? 'drop set' : null, st.restPause ? 'rest-pause' : null, st.partialReps != null ? 'parciales' : null].filter(Boolean).join(' + '), st.partialReps, st.pauseSec, st.restSec,
          e.supersetGroup ? 'sí' : '', e.doneOrder || '', ses.notes || '',
        ]));
      });
    });
  return csvText(header, rows);
}

function measuresCsv() {
  const header = ['Fecha', ...MEASURE_FIELDS.map(f => `${f.label} ${f.unit}`)];
  const rows = measuresSorted().map(m => [fmtDate(m.date), ...MEASURE_FIELDS.map(f => m[f.key])]);
  return csvText(header, rows);
}

// ---------- Récords (PR) ----------
// Mejor serie histórica de un ejercicio (por 1RM estimado), en cualquier
// rutina, sin sesiones de descarga. Sirve para avisar en la sesión y en Progreso.
// true si esa entrada guardada se hizo a un brazo/pierna (tiene repes izq).
function entryIsUni(e) {
  return e.sets.some(st => st.reps2 != null && st.reps2 !== '');
}

// uni: si se indica, solo cuentan las entradas hechas en ese modo. Unilateral y
// bilateral no son comparables (otro peso, otras repes).
function bestSetForExercise(exerciseId, uni) {
  let best = null;
  db.sessions.forEach(ses => {
    if (ses.deload) return;
    ses.entries.forEach(e => {
      if (e.exerciseId !== exerciseId) return;
      if (uni != null && entryIsUni(e) !== uni) return;
      e.sets.forEach(st => {
        const w = firstNum(st.weight), r = firstNum(st.reps);
        if (w == null || r == null || w <= 0 || r <= 0 || r > 100 || w > 500) return;
        const v = e1rm(w, r);
        if (!best || v > best.e1rm) best = { e1rm: v, w, r, date: ses.date };
      });
    });
  });
  return best;
}


// Por sesión: peso de trabajo (el más repetido), repes mínimas a ese peso,
// RIR medio y mejor 1RM estimado.
// exerciseId: por defecto el planificado en el hueco; en sesión, el que se está
// haciendo hoy (si hay sustitución). Las sesiones con otro ejercicio en ese
// hueco no cuentan: una máquina distinta no es una bajada de peso.
function slotProgressPoints(routine, slot, exerciseId, uni) {
  const exId = exerciseId || slot.exerciseId;
  return db.sessions
    .filter(ses => ses.routineId === routine.id)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(ses => {
      if (ses.deload) return null;
      const e = ses.entries.find(x => x.slotId === slot.id && x.exerciseId === exId);
      if (!e) return null;
      if (uni != null && entryIsUni(e) !== uni) return null;
      const sets = e.sets.map(st => ({ w: firstNum(st.weight), r: firstNum(st.reps), rir: firstNum(st.rir) }))
        // Valores imposibles (repes de miles, pesos absurdos) son errores de
        // tecleo: fuera del análisis para que no disparen recomendaciones.
        .filter(st => st.w != null && st.r != null && st.r > 0 && st.r <= 100 && st.w >= 0 && st.w <= 500);
      if (!sets.length) return null;
      const counts = {};
      sets.forEach(st => { counts[st.w] = (counts[st.w] || 0) + 1; });
      const workW = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a] || Number(b) - Number(a))[0]);
      const workSets = sets.filter(st => st.w === workW);
      const rirs = workSets.map(st => st.rir).filter(x => x != null);
      return {
        date: ses.date,
        sets,
        workW,
        minReps: Math.min(...workSets.map(st => st.r)),
        maxReps: Math.max(...workSets.map(st => st.r)),
        avgRir: rirs.length ? rirs.reduce((a, b) => a + b, 0) / rirs.length : null,
        best: Math.max(...sets.map(st => e1rm(st.w, st.r))),
        volume: sets.reduce((n, st) => n + st.w * st.r, 0),
      };
    })
    .filter(Boolean);
}

// Rango de repes objetivo de un hueco: el suyo si lo tiene; si no, por el
// nombre de la rutina (Fuerza → 4–6, resto → 8–12).
function repRangeOf(routine, slot) {
  if (slot && slot.repLo > 0 && slot.repHi >= slot.repLo) return { lo: slot.repLo, hi: slot.repHi, own: true };
  const fuerza = /fuerza/i.test(routine.name);
  return fuerza ? { lo: 4, hi: 6, own: false } : { lo: 8, hi: 12, own: false };
}

// Doble progresión: se sube peso cuando se llega al tope del rango de repes
// (o sobran repes según el RIR); se baja si las repes caen dos veces.
// Series de aproximación para el peso de trabajo W: 50 %×8, 70 %×4, 85 %×2.
// Redondeo a 2,5 kg (a 1 kg por debajo de 20, mancuernas ligeras). No se registran.
function warmupSetsFor(W) {
  if (!W || W < 10) return [];
  const round = (w) => W < 20 ? Math.round(w) : Math.round(w / 2.5) * 2.5;
  return [[0.5, 8], [0.7, 4], [0.85, 2]]
    .map(([pct, reps]) => ({ w: round(W * pct), reps }))
    .filter((st, i, arr) => st.w > 0 && (i === 0 || st.w > arr[i - 1].w));
}

function warmupHtml(pts, open) {
  const last = pts[pts.length - 1];
  if (!last || !last.workW) return '';
  const sets = warmupSetsFor(last.workW);
  if (!sets.length) return '';
  return `<div class="warmup${open ? ' open' : ''}">🔥 Calentamiento (para ${last.workW} kg): ${sets.map(st => `<b>${st.w}×${st.reps}</b>`).join(' · ')} <span class="warmup-note">no cuentan como series</span></div>`;
}

function recommendForSlot(routine, slot, pts) {
  const ex = getExercise(slot.exerciseId);
  const lower = muscleNames(ex && ex.muscle).some(m => LOWER_BODY.includes(m));
  const step = lower ? 5 : 2.5;
  const { lo, hi } = repRangeOf(routine, slot);
  const fmtW = (w) => `${Math.round(w * 4) / 4} kg`;
  if (pts.length < 2) {
    return { level: 'info', text: pts.length ? 'Con una sesión más ya puedo comparar.' : 'Sin sesiones todavía.' };
  }
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const W = last.workW;
  const rangeTxt = `${lo}–${hi}`;

  if (last.avgRir != null && last.avgRir >= 2.5) {
    return { level: 'up', text: `Te sobran repes (RIR medio ${last.avgRir.toFixed(1)}). Sube a ${fmtW(W + step)}.` };
  }
  if (last.minReps >= hi) {
    return { level: 'up', text: `Ya haces ${last.minReps}+ repes con ${fmtW(W)} (rango ${rangeTxt}). Sube a ${fmtW(W + step)} y vuelve a ${lo} repes.` };
  }
  if (W > prev.workW) {
    return { level: 'keep', text: `Acabas de subir de ${fmtW(prev.workW)} a ${fmtW(W)}. Consolida: repite ${fmtW(W)} hasta llegar a ${hi} repes en todas las series.` };
  }
  if (W === prev.workW && last.minReps > prev.minReps) {
    return { level: 'keep', text: `Progresas en repes con ${fmtW(W)} (${prev.minReps} → ${last.minReps}). Sigue así hasta ${hi}; entonces ${fmtW(W + step)}.` };
  }
  if (W === prev.workW && last.minReps < prev.minReps) {
    const twice = pts.length >= 3 && pts[pts.length - 3].workW === W && prev.minReps < pts[pts.length - 3].minReps;
    return twice
      ? { level: 'down', text: `Dos sesiones perdiendo repes con ${fmtW(W)} (${pts[pts.length - 3].minReps} → ${prev.minReps} → ${last.minReps}). Baja a ${fmtW(W - step)} o descansa más entre series.` }
      : { level: 'keep', text: `Menos repes que la vez anterior con ${fmtW(W)} (${prev.minReps} → ${last.minReps}). Repite ${fmtW(W)}; si vuelve a bajar, reduce peso.` };
  }
  if (last.minReps < lo) {
    return { level: 'down', text: `Con ${fmtW(W)} te quedas en ${last.minReps} repes, por debajo del rango ${rangeTxt}. Baja a ${fmtW(W - step)}.` };
  }
  if (pts.length >= 3) {
    const old = pts[pts.length - 3].best;
    if (old > 0 && (last.best - old) / old < 0.01) {
      return { level: 'info', text: `Tres sesiones sin avance (1RM est. ${Math.round(last.best)} kg). Prueba ${fmtW(W + step)} bajando repes, o añade una serie.` };
    }
  }
  return { level: 'keep', text: `Estable con ${fmtW(W)} × ${last.minReps}–${last.maxReps}. Busca ${hi} repes en todas las series antes de subir.` };
}

function progressChartSvg(pts) {
  const data = pts.slice(-12);
  if (data.length < 2) return '';
  const W = 320, H = 90, padL = 34, padR = 10, padT = 10, padB = 18;
  const vals = data.map(p => p.best);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1) { max += 1; min -= 1; }
  const x = (i) => padL + (i * (W - padL - padR)) / (data.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - (v - min) / (max - min));
  const path = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.best).toFixed(1)}`).join(' ');
  const dots = data.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.best).toFixed(1)}" r="3" />`).join('');
  const labels = data.map((p, i) => (i === 0 || i === data.length - 1 || data.length <= 6)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="middle">${fmtDateShort(p.date)}</text>` : '').join('');
  return `
    <svg class="progress-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <text x="2" y="${(padT + 4).toFixed(1)}">${Math.round(max)}</text>
      <text x="2" y="${(H - padB).toFixed(1)}">${Math.round(min)}</text>
      <path d="${path}" fill="none" />
      ${dots}
      ${labels}
    </svg>`;
}

// ---------- Mediciones corporales ----------
// db.measures = [{ id, date: 'YYYY-MM-DD', weight, waist, thigh, biceps, chest }]
// Independiente de rutinas y sesiones. good: dirección que se considera mejora.
const MEASURE_FIELDS = [
  { key: 'weight', label: 'Peso', short: 'Peso', unit: 'kg', good: 'up' },
  { key: 'waist', label: 'Cintura', short: 'Cint', unit: 'cm', good: 'down' },
  { key: 'thigh', label: 'Muslo derecho', short: 'Muslo', unit: 'cm', good: 'up' },
  { key: 'biceps', label: 'Bíceps derecho', short: 'Bíc', unit: 'cm', good: 'up' },
  { key: 'chest', label: 'Pecho', short: 'Pecho', unit: 'cm', good: 'up' },
  { key: 'shoulders', label: 'Hombros', short: 'Homb', unit: 'cm', good: 'up' },
];
let measuresChartKey = 'weight';
let measuresChartRange = 20; // 20 últimas | 365 días | 'all'
let measuresShowAll = false;

function measuresSorted() {
  return (db.measures || []).slice().sort((a, b) => a.date.localeCompare(b.date));
}

function fmtMeasure(v) {
  if (v == null || v === '') return '·';
  return String(Math.round(v * 10) / 10).replace('.', ',');
}

function parseMeasure(txt) {
  const t = String(txt || '').trim().replace(',', '.');
  if (!t) return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// Diferencia con signo y color según si la dirección es la buena.
function measureDeltaHtml(field, cur, prev) {
  if (cur == null || prev == null) return '<span class="m-delta">·</span>';
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return '<span class="m-delta">=</span>';
  const cls = !field.good ? '' : (d > 0) === (field.good === 'up') ? ' m-good' : ' m-bad';
  return `<span class="m-delta${cls}">${d > 0 ? '+' : '−'}${fmtMeasure(Math.abs(d))}</span>`;
}

function measureChartSvg(field) {
  let data = measuresSorted().filter(m => m[field.key] != null);
  if (measuresChartRange === 365) {
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const fromIso = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
    data = data.filter(m => m.date >= fromIso);
  } else if (measuresChartRange !== 'all') {
    data = data.slice(-measuresChartRange);
  }
  if (data.length < 2) return '<div class="progress-intro">Hacen falta al menos dos mediciones para la gráfica.</div>';
  const W = 320, H = 116, padL = 40, padR = 14, padT = 22, padB = 18;
  const vals = data.map(m => m[field.key]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 0.5) { max += 0.5; min -= 0.5; }
  const x = (i) => padL + (i * (W - padL - padR)) / (data.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - (v - min) / (max - min));
  const path = data.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(m[field.key]).toFixed(1)}`).join(' ');
  const r = data.length > 30 ? 1.5 : 3;
  const dots = data.map((m, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(m[field.key]).toFixed(1)}" r="${r}" />`).join('');
  const fmtLbl = data.length > 20 ? fmtDate : fmtDateShort;
  const labels = data.map((m, i) => (i === 0 || i === data.length - 1 || data.length <= 6)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}">${fmtLbl(m.date)}</text>` : '').join('');
  const lastV = data[data.length - 1][field.key];
  return `
    <svg class="progress-chart measure-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <text x="2" y="${(padT + 4).toFixed(1)}">${fmtMeasure(max)}</text>
      <text x="2" y="${(H - padB).toFixed(1)}">${fmtMeasure(min)}</text>
      <path d="${path}" fill="none" />
      ${dots}
      <text x="${(x(data.length - 1) - 2).toFixed(1)}" y="${(y(lastV) - 8).toFixed(1)}" text-anchor="end" class="last">${fmtMeasure(lastV)}</text>
      ${labels}
    </svg>`;
}

function renderMeasures() {
  const all = measuresSorted();
  const last = all[all.length - 1];
  const prev = all[all.length - 2];
  const first = all[0];

  const summary = last ? `
    <div class="card measure-card">
      <div class="weekly-head">Última medición · ${fmtDate(last.date)}</div>
      <div class="history-table-wrap"><table class="history-table measure-summary">
        <thead><tr><th></th><th>Último</th><th>vs anterior</th><th>vs inicio</th></tr></thead>
        <tbody>${MEASURE_FIELDS.map(f => {
          const withData = all.filter(m => m[f.key] != null);
          const cur = withData[withData.length - 1], before = withData[withData.length - 2], start = withData[0];
          if (!cur) return `<tr><td class="date-cell">${f.label}</td><td>·</td><td>·</td><td>·</td></tr>`;
          const stale = cur.date !== last.date ? `<br><small>${fmtDate(cur.date)}</small>` : '';
          return `
          <tr>
            <td class="date-cell">${f.label}</td>
            <td><b>${fmtMeasure(cur[f.key])}</b> <small>${f.unit}</small>${stale}</td>
            <td>${before ? measureDeltaHtml(f, cur[f.key], before[f.key]) + `<br><small>${fmtDate(before.date)}</small>` : '·'}</td>
            <td>${start !== cur ? measureDeltaHtml(f, cur[f.key], start[f.key]) + `<br><small>${fmtDate(start.date)}</small>` : '·'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>` : '';

  const field = MEASURE_FIELDS.find(f => f.key === measuresChartKey) || MEASURE_FIELDS[0];
  const chart = all.length ? `
    <div class="card measure-card">
      <div class="tabs measure-tabs">
        ${MEASURE_FIELDS.map(f => `<button class="tab${f.key === field.key ? ' active' : ''}" data-mkey="${f.key}">${f.short}</button>`).join('')}
      </div>
      <div class="weekly-head measure-chart-head">${field.label} (${field.unit})
        <span class="measure-range">${[[20, '20 últ.'], [365, '1 año'], ['all', 'Todo']].map(([v, t]) => `<span class="${String(v) === String(measuresChartRange) ? 'active' : ''}" data-mrange="${v}">${t}</span>`).join('')}</span>
      </div>
      ${measureChartSvg(field)}
    </div>` : '';

  const cols = MEASURE_FIELDS.filter(f => all.some(m => m[f.key] != null));
  const arrows = {}; // id -> { key: html }
  const lastVal = {};
  all.forEach(m => {
    arrows[m.id] = {};
    cols.forEach(f => {
      const v = m[f.key];
      if (v == null) return;
      const p = lastVal[f.key];
      if (p != null && Math.round((v - p) * 10) !== 0) {
        const up = v > p;
        const good = (f.good === 'up') === up;
        arrows[m.id][f.key] = `<span class="m-arrow ${good ? 'm-good' : 'm-bad'}">${up ? '▲' : '▼'}</span>`;
      }
      lastVal[f.key] = v;
    });
  });
  const LIMIT = 24;
  const shown = measuresShowAll ? all.slice().reverse() : all.slice(-LIMIT).reverse();
  const rows = shown.map(m => `
    <tr class="measure-row" data-medit="${m.id}">
      <td class="date-cell">${fmtDate(m.date)}</td>
      ${cols.map(f => `<td>${arrows[m.id][f.key] || ''}${fmtMeasure(m[f.key])}</td>`).join('')}
    </tr>`).join('');
  const table = all.length ? `
    <div class="card measure-card">
      <div class="weekly-head">Historial · toca una fila para editar</div>
      <div class="history-table-wrap"><table class="history-table measure-history">
        <thead><tr><th>Fecha</th>${cols.map(f => `<th>${f.short}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${all.length > LIMIT ? `<div class="summary-more" id="measures-more">${measuresShowAll ? '▴ ver menos' : `▾ ver todas (${all.length})`}</div>` : ''}
    </div>` : '';

  app.innerHTML = `
    <div class="topbar">
      <button class="btn btn-ghost" data-nav="">← Atrás</button>
      <h1>📏 Mediciones</h1>
      ${all.length ? '<button class="btn btn-icon" id="csv-measures" title="Exportar CSV">⬇</button>' : ''}
      <button class="btn btn-icon" id="measure-add" title="Nueva medición">＋</button>
    </div>
    <div class="container">
      ${all.length ? summary + chart + table : '<div class="empty-state">Todavía no hay mediciones.<br>Peso, cintura, muslo derecho, bíceps derecho y pecho.</div>'}
      <div class="fab-row">
        <button class="btn btn-primary btn-block" id="measure-add-2">+ Nueva medición</button>
      </div>
    </div>
  `;
  app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));
  ['measure-add', 'measure-add-2'].forEach(id => document.getElementById(id).addEventListener('click', () => openMeasureDialog(null)));
  const csvM = document.getElementById('csv-measures');
  if (csvM) csvM.addEventListener('click', () => downloadText(`mediciones_${todayStamp()}.csv`, measuresCsv()));
  app.querySelectorAll('[data-mkey]').forEach(el => el.addEventListener('click', () => { measuresChartKey = el.dataset.mkey; renderMeasures(); }));
  app.querySelectorAll('[data-mrange]').forEach(el => el.addEventListener('click', () => {
    measuresChartRange = el.dataset.mrange === 'all' ? 'all' : Number(el.dataset.mrange);
    renderMeasures();
  }));
  const more = document.getElementById('measures-more');
  if (more) more.addEventListener('click', () => {
    const y = window.scrollY;
    measuresShowAll = !measuresShowAll;
    renderMeasures();
    window.scrollTo(0, y);
  });
  app.querySelectorAll('[data-medit]').forEach(el => el.addEventListener('click', () => {
    const m = (db.measures || []).find(x => x.id === el.dataset.medit);
    if (m) openMeasureDialog(m);
  }));
}

// Alta/edición. Los campos vacíos se guardan como null (no todo se mide siempre).
function openMeasureDialog(existing) {
  const all = measuresSorted();
  const ref = existing ? all.filter(m => m.date < existing.date).pop() : all[all.length - 1];
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <h2>${existing ? 'Editar medición' : 'Nueva medición'}</h2>
      <div class="measure-grid">
        <div class="field">
          <label>Fecha</label>
          <input id="m-date" type="date" value="${existing ? existing.date : todayIso}" />
        </div>
        ${MEASURE_FIELDS.map(f => `
          <div class="field">
            <label>${f.label} (${f.unit})</label>
            <input id="m-${f.key}" type="text" inputmode="decimal" placeholder="${ref && ref[f.key] != null ? 'ant. ' + fmtMeasure(ref[f.key]) : ''}" value="${existing && existing[f.key] != null ? fmtMeasure(existing[f.key]) : ''}" />
          </div>`).join('')}
      </div>
      <button class="btn btn-primary btn-block" id="m-save">Guardar</button>
      <div style="height:8px;"></div>
      ${existing ? '<button class="btn btn-block btn-danger" id="m-delete">Eliminar</button><div style="height:8px;"></div>' : ''}
      <button class="btn btn-block" id="m-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => document.body.removeChild(backdrop);
  document.getElementById('m-save').addEventListener('click', () => {
    const date = document.getElementById('m-date').value;
    if (!date) { showToast('Falta la fecha'); return; }
    const rec = existing || { id: uid() };
    rec.date = date;
    let any = false;
    MEASURE_FIELDS.forEach(f => { rec[f.key] = parseMeasure(document.getElementById('m-' + f.key).value); if (rec[f.key] != null) any = true; });
    if (!any) { showToast('Pon al menos una medida'); return; }
    db.measures = db.measures || [];
    if (!existing) db.measures.push(rec);
    saveDB();
    close();
    showToast('Medición guardada');
    renderMeasures();
  });
  const del = document.getElementById('m-delete');
  if (del) del.addEventListener('click', () => {
    if (!confirm('¿Eliminar la medición del ' + fmtDate(existing.date) + '?')) return;
    db.measures = (db.measures || []).filter(m => m.id !== existing.id);
    saveDB();
    close();
    renderMeasures();
  });
  document.getElementById('m-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  setTimeout(() => { const el = document.getElementById('m-weight'); if (el && !existing) el.focus(); }, 50);
}

// Peso corporal en una fecha: la medición con peso más cercana (±45 días).
function bodyWeightNear(dateIso) {
  const t = new Date(dateIso).getTime();
  let best = null;
  (db.measures || []).forEach(m => {
    if (m.weight == null) return;
    const diff = Math.abs(new Date(m.date).getTime() - t);
    if (diff <= 45 * 24 * 60 * 60 * 1000 && (!best || diff < best.diff)) best = { weight: m.weight, date: m.date, diff };
  });
  return best;
}

function renderProgress(routineId) {
  const routine = getRoutine(routineId);
  if (!routine) { navigate(''); return; }
  const lastBw = measuresSorted().filter(m => m.weight != null).pop();
  const bwHtml = lastBw
    ? `<div class="progress-intro">⚖️ Peso corporal: <b>${fmtMeasure(lastBw.weight)} kg</b> (${fmtDate(lastBw.date)}). En los tres primeros ejercicios, el 1RM también en veces tu peso, con la medición más cercana a cada sesión.</div>`
    : '';

  const blocks = routine.slots.map((slot, idx) => {
    const ex = getExercise(slot.exerciseId);
    // Modo (uni/bi) de la última vez: solo se comparan sesiones de ese modo.
    const lastEntry = db.sessions.filter(ses => ses.routineId === routine.id && !ses.deload)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(ses => ses.entries.find(x => x.slotId === slot.id && x.exerciseId === slot.exerciseId)).find(Boolean);
    const uniMode = lastEntry ? entryIsUni(lastEntry) : null;
    const pts = slotProgressPoints(routine, slot, null, uniMode);
    const rec = recommendForSlot(routine, slot, pts);
    const last = pts[pts.length - 1];
    const main = idx < 3;
    const icon = { up: '⬆️', keep: '➡️', down: '⬇️', info: 'ℹ️' }[rec.level];
    const lastTxt = last ? `Última: ${fmtDateShort(last.date)} · ${last.sets.map(st => `${st.w}×${st.r}`).join(' · ')}${last.avgRir != null ? ` · RIR ${last.avgRir.toFixed(1)}` : ''}` : '';
    const best = bestSetForExercise(slot.exerciseId, uniMode);
    const bestTxt = best ? `🏆 Récord${uniMode ? ' (unilateral)' : ''}: ${best.w}×${best.r} → ${Math.round(best.e1rm)} kg est. (${fmtDate(best.date)})` : '';
    const body = `
      <div class="progress-rec progress-${rec.level}">${icon} ${escapeHtml(rec.text)}</div>
      ${lastTxt ? `<div class="progress-last">${escapeHtml(lastTxt)}</div>` : ''}
      ${bestTxt ? `<div class="progress-last progress-pr">${escapeHtml(bestTxt)}</div>` : ''}
      ${main ? progressChartSvg(pts) : ''}
      ${pts.length >= 2 ? `<div class="progress-stats">1RM est.: ${Math.round(pts[pts.length - 2].best)} → <b>${Math.round(last.best)} kg</b> · volumen: ${Math.round(pts[pts.length - 2].volume)} → <b>${Math.round(last.volume)} kg</b></div>` : ''}
      ${main && pts.length >= 2 && bodyWeightNear(pts[pts.length - 2].date) && bodyWeightNear(last.date) ? `<div class="progress-stats">⚖️ 1RM / peso corporal: ${(pts[pts.length - 2].best / bodyWeightNear(pts[pts.length - 2].date).weight).toFixed(2)} → <b>${(last.best / bodyWeightNear(last.date).weight).toFixed(2)}×</b></div>` : ''}`;
    return `
      <div class="card progress-card${main ? '' : ' progress-minor'}">
        <div class="progress-head">
          <div class="name">${idx + 1}. ${ex ? escapeHtml(ex.name) : '(ejercicio eliminado)'} <span class="rep-range-tag">${repRangeOf(routine, slot).lo}–${repRangeOf(routine, slot).hi}</span>${uniMode ? ' <span class="rep-range-tag">🔀 uni</span>' : ''}</div>
          ${ex && ex.muscle ? muscleBadgeHtml(ex.muscle).replace('muscle-badge', 'muscle-badge progress-badge') : ''}
        </div>
        ${main ? body : `<details><summary>${icon} ${escapeHtml(rec.text)}</summary>${body}</details>`}
      </div>`;
  }).join('');

  const fuerza = /fuerza/i.test(routine.name);
  app.innerHTML = `
    <div class="topbar">
      <button class="btn btn-ghost" data-nav="history/${routine.id}">← Atrás</button>
      <h1>📈 ${escapeHtml(routine.name)}</h1>
    </div>
    <div class="container">
      <div class="progress-intro">Rango por defecto: <b>${fuerza ? '4–6' : '8–12'} repes</b> (por el nombre de la rutina); cada ejercicio puede tener el suyo (🎯 en la sesión o en el editor). Los tres primeros llevan gráfica; el resto, plegados.</div>
      ${bwHtml}
      ${blocks}
    </div>
  `;
  app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));
}

function renderHistory(routineId) {
  const routine = routineId ? getRoutine(routineId) : null;
  if (routineId && !routine) { navigate(''); return; }
  const sessions = db.sessions
    .filter(s => !routine || s.routineId === routine.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const rows = sessions.map(s => sessionRowHtml(s, !routine)).join('');

  const exercisesHtml = routine ? `
      <div class="card">
        ${routine.slots.map((slot, idx) => {
          const ex = getExercise(slot.exerciseId);
          return `
          <div class="list-item">
            <div style="flex:1;">
              <div class="name">${idx + 1}. ${ex ? escapeHtml(ex.name) : '(ejercicio eliminado)'}${slot.supersetGroup ? ' <span class="ss-tag">SS</span>' : ''}</div>
              ${ex && ex.muscle ? `<div class="muscle">${escapeHtml(ex.muscle)}</div>` : ''}
            </div>
          </div>`;
        }).join('') || '<div class="empty-state">Rutina sin ejercicios.</div>'}
      </div>
      <div class="section-title">Sesiones (${sessions.length})</div>` : '';

  app.innerHTML = `
    <div class="topbar">
      <button class="btn btn-ghost" data-nav="">← Atrás</button>
      <h1>${routine ? escapeHtml(routine.name) : 'Historial'}</h1>
      ${sessions.length ? `<button class="btn btn-icon" id="csv-sessions" title="Exportar CSV">⬇</button>` : ''}
      ${routine ? `<button class="btn btn-icon" data-nav="progress/${routine.id}" title="Progreso">📈</button><button class="btn btn-icon" data-nav="routine-edit/${routine.id}" title="Editar rutina">✎</button>` : ''}
    </div>
    <div class="container">
      ${exercisesHtml}
      <div class="card">
        ${sessions.length ? rows : '<div class="empty-state">Todavía no hay sesiones guardadas.</div>'}
      </div>
    </div>
  `;

  app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));
  app.querySelectorAll('[data-open-session]').forEach(el => {
    el.addEventListener('click', () => navigate(`session-view/${el.dataset.openSession}`));
  });
  const csvBtn = document.getElementById('csv-sessions');
  if (csvBtn) csvBtn.addEventListener('click', () => {
    const name = routine ? routine.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-') : 'todas';
    downloadText(`sesiones_${name}_${todayStamp()}.csv`, sessionsCsv(routine ? routine.id : null));
  });
}

// Al editar una sesión guardada: los números se guardan como número, pero se
// respeta el texto tal cual en casos como los drop sets ("90/77.5").
function parseSavedValue(raw) {
  const v = normalizeDecimal(String(raw).trim());
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function renderSessionDetail(sessionId) {
  const session = db.sessions.find(s => s.id === sessionId);
  if (!session) { navigate('history'); return; }
  const routine = getRoutine(session.routineId);

  function paint() {
    const blocks = session.entries.map((e, eIdx) => {
      const ex = getExercise(e.exerciseId);
      // Compañeros de superserie dentro de ESTA sesión guardada.
      const ssPartners = !e.supersetGroup ? '' : session.entries
        .map((o, i) => ({ o, i }))
        .filter(({ o, i }) => i !== eIdx && o.supersetGroup === e.supersetGroup)
        .map(({ o, i }) => {
          const oEx = getExercise(o.exerciseId);
          return `${i + 1}. ${escapeHtml(oEx ? oEx.name : '?')}`;
        }).join(' · ');
      const setsHtml = e.sets.map((set, sIdx) => {
        const tags = [set.dropset ? 'DROP' : null, set.restPause ? 'RP' : null].filter(Boolean).join(' · ');
        const partialsHtml = set.partialReps != null
          ? `<div class="rest-tag partial-edit">PARC · <input type="text" inputmode="decimal" data-hp="${eIdx}:${sIdx}" value="${escapeHtml(set.partialReps)}" /> reps parciales <span class="technique-link" data-hp-rm="${eIdx}:${sIdx}">✕</span></div>`
          : `<div class="rest-tag"><span class="technique-link" data-hp-add="${eIdx}:${sIdx}">+ parciales</span></div>`;
        return `
        <div class="set-row${set.reps2 != null ? ' set-row-uni' : ''}">
          <div class="set-num">${sIdx + 1}</div>
          <input type="text" inputmode="decimal" placeholder="kg" data-hw="${eIdx}:${sIdx}" value="${escapeHtml(set.weight ?? '')}" />
          <input type="text" inputmode="decimal" placeholder="${set.reps2 != null ? 'der' : 'reps'}" data-hr="${eIdx}:${sIdx}" value="${escapeHtml(set.reps ?? '')}" />
          ${set.reps2 != null ? `<input type="text" inputmode="decimal" placeholder="izq" data-hr2="${eIdx}:${sIdx}" value="${escapeHtml(set.reps2)}" />` : ''}
          <input type="text" inputmode="decimal" placeholder="${set.reps2 != null ? 'RIR d' : 'RIR'}" data-hrir="${eIdx}:${sIdx}" value="${escapeHtml(set.rir ?? '')}" />
          ${set.reps2 != null ? `<input type="text" inputmode="decimal" placeholder="RIR i" data-hrir2="${eIdx}:${sIdx}" value="${escapeHtml(set.rir2 ?? '')}" />` : ''}
          <button class="rm" data-hrm="${eIdx}:${sIdx}">✕</button>
        </div>
        ${tags ? `<div class="rest-tag">${tags}</div>` : ''}${partialsHtml}`;
      }).join('');

      return `
        <div class="exercise-block" style="${muscleBackgroundStyle(ex && ex.muscle)}">
          ${ex && ex.muscle ? muscleBadgeHtml(ex.muscle) : ''}
          <div class="exercise-head">
            <div>
              <h3>${eIdx + 1}. ${escapeHtml(ex ? ex.name : '(ejercicio eliminado)')}</h3>
              ${e.doneOn ? `<div class="transfer-note">↗ Hecho el ${fmtDate(e.doneOn)}, en otro entreno</div>` : ''}
              ${e.doneOrder ? `<div class="order-tag order-changed">↕ Ese día lo hiciste el ${e.doneOrder}º</div>` : ''}
              ${ssPartners ? `<div class="superset-note">🔗 Superserie con ${ssPartners}</div>` : ''}
              ${e.restNote ? `<div class="rest-note">desc. obj: ${escapeHtml(e.restNote)}s</div>` : ''}
            </div>
          </div>
          <div class="log-area">
            <div class="set-labels"><span></span><span>Kg</span><span>Reps</span><span>RIR</span><span></span></div>
            ${setsHtml || '<div class="history-empty">Sin series.</div>'}
          </div>
        </div>`;
    }).join('');

    app.innerHTML = `
      <div class="topbar">
        <button class="btn btn-ghost" id="sd-back">← Atrás</button>
        <h1>${fmtDate(session.date)}</h1>
      </div>
      <div class="container">
        <div class="card">
          <div style="font-size:13px;color:var(--text-dim);margin-bottom:10px;">${escapeHtml(routine ? routine.name : 'Rutina eliminada')}</div>
          <div class="field">
            <label>Duración (minutos)</label>
            <input id="sd-duration" type="text" inputmode="numeric" value="${session.durationSec != null ? Math.round(session.durationSec / 60) : ''}" placeholder="Ej. 70" />
          </div>
          <div class="field">
            <label>Gimnasio</label>
            <input id="sd-gym" value="${escapeHtml(session.gym || '')}" placeholder="Ej. Hi-Fitness" />
          </div>
          <div class="field">
            <label>Notas de la sesión</label>
            <input id="sd-notes" value="${escapeHtml(session.notes || '')}" placeholder="Ej. hombro molestando" />
          </div>
        </div>
        ${blocks}
        <div class="fab-row">
          <button class="btn btn-danger btn-block" id="sd-delete">🗑 Eliminar esta sesión</button>
        </div>
      </div>
    `;

    app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));
    // Se llega aquí desde el historial global o desde el de una rutina: volver
    // a donde se estaba, no siempre al global.
    document.getElementById('sd-back').addEventListener('click', () => {
      if (history.length > 1) history.back(); else navigate('history');
    });

    document.getElementById('sd-duration').addEventListener('input', (e) => {
      const min = Number(normalizeDecimal(e.target.value));
      session.durationSec = min > 0 ? Math.round(min * 60) : null;
      saveDB();
      scheduleGhBackup();
    });
    document.getElementById('sd-gym').addEventListener('input', (e) => {
      session.gym = e.target.value;
      saveDB();
      scheduleGhBackup();
    });
    document.getElementById('sd-notes').addEventListener('input', (e) => {
      session.notes = e.target.value;
      saveDB();
      scheduleGhBackup();
    });

    const bindSet = (attr, field) => {
      app.querySelectorAll(`[data-${attr}]`).forEach(el => el.addEventListener('input', () => {
        const [eIdx, sIdx] = el.dataset[attr].split(':').map(Number);
        session.entries[eIdx].sets[sIdx][field] = parseSavedValue(el.value);
        saveDB();
        scheduleGhBackup();
      }));
    };
    bindSet('hw', 'weight');
    bindSet('hr', 'reps');
    bindSet('hr2', 'reps2');
    bindSet('hrir', 'rir');
    bindSet('hrir2', 'rir2');
    bindSet('hp', 'partialReps');
    app.querySelectorAll('[data-hp-add]').forEach(el => el.addEventListener('click', () => {
      const [eIdx, sIdx] = el.dataset.hpAdd.split(':').map(Number);
      session.entries[eIdx].sets[sIdx].partialReps = 0;
      saveDB(); scheduleGhBackup(); paint();
    }));
    app.querySelectorAll('[data-hp-rm]').forEach(el => el.addEventListener('click', () => {
      const [eIdx, sIdx] = el.dataset.hpRm.split(':').map(Number);
      delete session.entries[eIdx].sets[sIdx].partialReps;
      delete session.entries[eIdx].sets[sIdx].partialReps2;
      saveDB(); scheduleGhBackup(); paint();
    }));

    app.querySelectorAll('[data-hrm]').forEach(el => el.addEventListener('click', () => {
      const [eIdx, sIdx] = el.dataset.hrm.split(':').map(Number);
      session.entries[eIdx].sets.splice(sIdx, 1);
      if (!session.entries[eIdx].sets.length) session.entries.splice(eIdx, 1);
      saveDB();
      scheduleGhBackup();
      if (!session.entries.length) {
        showToast('La sesión se ha quedado sin series');
      }
      paint();
    }));

    document.getElementById('sd-delete').addEventListener('click', () => {
      if (!confirm('¿Eliminar esta sesión del histórico? No se puede deshacer.')) return;
      db.sessions = db.sessions.filter(s => s.id !== sessionId);
      saveDB();
      scheduleGhBackup();
      showToast('Sesión eliminada');
      navigate('history');
    });
  }

  paint();
}

// ---------- Sesión de entrenamiento ----------
function renderSession(routineId) {
  const routine = getRoutine(routineId);
  if (!routine) { navigate(''); return; }

  requestWakeLock();
  const restIntervals = {};

  // La barra del cronómetro va en position:fixed. Con zoom (pellizco) los
  // elementos fijos se escalan con la página; aquí se contrarresta con el
  // visualViewport para que siga arriba y a su tamaño original.
  function refreshRestMuscles() {
    const el = document.getElementById('rest-bar-muscles');
    if (!el) return;
    const hasData = st => (st.weight !== '' && st.weight != null) || (st.reps !== '' && st.reps != null);
    const per = {};
    Object.values(draft.entries).forEach(e => {
      const n = e.sets.filter(hasData).length;
      if (!n) return;
      const ex = getExercise(e.exerciseId);
      muscleNames(ex && ex.muscle).forEach(m => { per[m] = (per[m] || 0) + n; });
    });
    const items = Object.keys(MUSCLE_COLORS).filter(m => per[m]).concat(Object.keys(per).filter(m => !(m in MUSCLE_COLORS)));
    const total = Object.values(draft.entries).reduce((n, e) => n + e.sets.filter(hasData).length, 0);
    el.innerHTML = items.length
      ? `<span class="rest-total">${total} serie${total === 1 ? '' : 's'}</span>` + items.map(m => `<span style="color:${MUSCLE_COLORS[m] || 'var(--text-dim)'};">${escapeHtml(muscleAbbr(m))} ${per[m]}</span>`).join('')
      : '<span class="rest-total">sin series todavía</span>';
  }

  function pinRestBarToViewport() {
    const bar = document.getElementById('rest-bar');
    const vv = window.visualViewport;
    if (!bar) return;
    if (!vv) { bar.style.transform = ''; bar.style.width = ''; return; }
    bar.style.width = (vv.width * vv.scale) + 'px';
    bar.style.transform = `translate(${vv.offsetLeft}px, ${vv.offsetTop}px) scale(${1 / vv.scale})`;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', pinRestBarToViewport);
    window.visualViewport.addEventListener('scroll', pinRestBarToViewport);
  }

  // Al bloquear/desbloquear el móvil la pantalla a veces se recoloca; se
  // guarda dónde estabas y se vuelve ahí.
  const SCROLL_KEY = 'hipertrofia_scroll_' + routineId;
  let scrollSaveTimer = null;
  const onScroll = () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => { try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch (e) {} }, 150);
  };
  const restoreScroll = () => {
    let y = null;
    try { y = Number(sessionStorage.getItem(SCROLL_KEY)); } catch (e) {}
    if (y != null && !Number.isNaN(y)) window.scrollTo(0, y);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') setTimeout(restoreScroll, 60); };
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', restoreScroll);

  currentCleanup = () => {
    Object.values(restIntervals).forEach(clearInterval);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', pinRestBarToViewport);
      window.visualViewport.removeEventListener('scroll', pinRestBarToViewport);
    }
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', restoreScroll);
    const bar = document.getElementById('rest-bar');
    if (bar) bar.remove();
    document.getElementById('app').classList.remove('with-rest-bar');
  };

  // Histórico de un hueco: lo hecho en este hueco de esta rutina y, además, el
  // mismo ejercicio hecho en cualquier otra rutina (marcado como "foreign"),
  // para que un ejercicio recién añadido no aparezca vacío.
  // Hay rutinas que comparten ids de hueco (Pierna se dividió en dos copiando
  // la original), por eso se mira siempre primero la rutina de hoy.
  function resolveSlot(slotId) {
    const own = routine.slots.find(sl => sl.id === slotId);
    if (own) return { routine, slot: own };
    const moved = transferItems.find(it => it.slot.id === slotId);
    if (moved) return { routine: moved.fromRoutine, slot: moved.slot };
    return findSlotAnywhere(slotId);
  }

  function pastSessionsForSlot(slotId, limit) {
    const found = resolveSlot(slotId);
    const slot = found ? found.slot : null;
    const ownRoutineId = found ? found.routine.id : routineId;
    const entryNow = draft.entries[slotId];
    const exId = entryNow ? entryNow.exerciseId : (slot ? slot.exerciseId : null);
    const rows = [];
    db.sessions.forEach(s => {
      let e = s.routineId === ownRoutineId ? s.entries.find(x => x.slotId === slotId) : null;
      let foreign = false;
      if (!e && exId) { e = s.entries.find(x => x.exerciseId === exId); foreign = true; }
      if (e) rows.push({ session: s, entry: e, foreign });
    });
    return rows.sort((a, b) => b.session.date.localeCompare(a.session.date)).slice(0, limit);
  }

  const lastRoutineSession = db.sessions
    .filter(s => s.routineId === routineId)
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  // draft.entries[slotId] = { exerciseId, sets: [{weight, reps, rir, reps2, restSec}], uni }
  // El descanso se mide solo: "+ Serie" arranca el cronómetro (restStart) y la
  // siguiente serie, sea del ejercicio que sea, guarda el tiempo transcurrido.
  // restSlotId dice de qué ejercicio sale el objetivo (slot.restSec).
  // La sesión en curso se autoguarda (ver saveDraft) para que sobreviva a
  // salir de esta pantalla (p. ej. para editar la rutina) sin perder datos.
  const transferItems = pendingTransfersFor(routineId);
  const restoredDraft = loadSessionDraft(routineId);
  const draft = restoredDraft || {
    gym: (lastRoutineSession && lastRoutineSession.gym) || '',
    entries: {},
    restStart: null,
    restSlotId: null,
    sessionStartedAt: Date.now(),
  };
  const sessionStartedAt = draft.sessionStartedAt;
  routine.slots.forEach(slot => {
    if (draft.entries[slot.id]) return; // ya existía (sesión restaurada) o se acaba de añadir a la rutina
    const lastHistory = pastSessionsForSlot(slot.id, 1)[0];
    const defaultUni = !!(lastHistory && lastHistory.entry.sets.some(s => s.reps2 != null && s.reps2 !== ''));
    draft.entries[slot.id] = { exerciseId: slot.exerciseId, sets: [], uni: defaultUni, _historyLimit: 5 };
  });

  // Huecos de otra rutina que hoy se hacen aquí (traslados pendientes).
  transferItems.forEach(({ slot }) => {
    if (draft.entries[slot.id]) return;
    const lastHistory = pastSessionsForSlot(slot.id, 1)[0];
    const defaultUni = !!(lastHistory && lastHistory.entry.sets.some(s2 => s2.reps2 != null && s2.reps2 !== ''));
    draft.entries[slot.id] = { exerciseId: slot.exerciseId, sets: [], uni: defaultUni, _historyLimit: 5 };
  });

  // draft.supersets[slotId] = idGrupo | null. La rutina guarda el plan habitual;
  // esto guarda lo que haces HOY, para que improvisar (o saltarte) una
  // superserie no reescriba la rutina. null = hoy suelto a propósito, por eso se
  // guarda la clave en vez de borrarla: si no, al repintar volvería el plan.
  if (!draft.supersets) draft.supersets = {};
  routine.slots.forEach(slot => {
    if (!(slot.id in draft.supersets)) draft.supersets[slot.id] = slot.supersetGroup || null;
  });
  transferItems.forEach(({ slot }) => { if (!(slot.id in draft.supersets)) draft.supersets[slot.id] = null; });

  function saveDraft() {
    saveSessionDraft(routineId, draft);
  }

  // La duración se mide entre la primera y la última serie registrada, no desde
  // que se abre la pantalla: abrir la rutina para mirar el histórico y entrenar
  // horas después no debe inflar el tiempo de la sesión.
  function markActivity() {
    const now = Date.now();
    if (!draft.firstSetAt) draft.firstSetAt = now;
    draft.lastActivityAt = now;
  }

  function suggestedDurationSec() {
    if (draft.firstSetAt && draft.lastActivityAt && draft.lastActivityAt > draft.firstSetAt) {
      return Math.round((draft.lastActivityAt - draft.firstSetAt) / 1000);
    }
    return Math.round((Date.now() - sessionStartedAt) / 1000);
  }

  // missingCount: ejercicios del plan sin series hoy. Si hay, se pregunta si la
  // sesión queda parcial (el resto otro día) o completa (saltados a propósito).
  function openDurationPrompt(missingCount, onDone) {
    const suggestedMin = Math.max(1, Math.round(suggestedDurationSec() / 60));
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>⏱ Duración del entreno</h2>
        <p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">Calculado entre tu primera y última serie. Corrígelo si no cuadra.</p>
        <div class="field">
          <input id="duration-input" type="text" inputmode="numeric" value="${suggestedMin}" />
        </div>
        <div class="field">
          <label>Notas de la sesión (opcional)</label>
          <input id="duration-notes" placeholder="Ej. hombro molestando" value="${escapeHtml(draft.notes || '')}" />
        </div>
        <div class="field">
          <label>📨 Mensaje para el próximo entreno (opcional)</label>
          <input id="duration-msg" placeholder="Ej. hacer gemelos, cuidado con el hombro" />
          <select id="duration-msg-routine" style="margin-top:6px;">
            ${db.routines.map(r => `<option value="${r.id}"${r.id === routineId ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn btn-block deload-btn${isDeloadActive() ? ' active' : ''}" id="deload-session-btn">🪫 Sesión de descarga${isDeloadActive() ? ' (semana activa)' : ''}</button>
        <div style="height:10px;"></div>
        ${missingCount ? `
        <p style="color:var(--text-dim);font-size:13px;margin:4px 0 6px;">Quedan ${missingCount} ejercicio${missingCount === 1 ? '' : 's'} sin series. ¿La sesión es…?</p>
        <div class="scope-toggle">
          <button type="button" class="scope-btn${missingCount > 2 ? ' active' : ''}" data-scope="partial">⏸<br>Parcial<br><small>el resto otro día</small></button>
          <button type="button" class="scope-btn${missingCount > 2 ? '' : ' active'}" data-scope="full">✅<br>Completa<br><small>los salté a propósito</small></button>
        </div>
        ` : ''}
        <button class="btn btn-primary btn-block" id="duration-ok">Guardar sesión</button>
        <div style="height:8px;"></div>
        <button class="btn btn-block" id="duration-cancel">Cancelar</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    const input = document.getElementById('duration-input');
    input.focus();
    input.select();
    const confirmDuration = () => {
      const min = Number(normalizeDecimal(input.value));
      if (!min || min <= 0) { showToast('Pon una duración válida en minutos'); return; }
      const scope = backdrop.querySelector('.scope-btn.active');
      draft.notes = document.getElementById('duration-notes').value.trim();
      const msgText = document.getElementById('duration-msg').value.trim();
      if (msgText) {
        db.messages = db.messages || [];
        db.messages.push({
          id: uid(),
          routineId: document.getElementById('duration-msg-routine').value,
          fromRoutineId: routineId,
          text: msgText,
          createdAt: new Date().toISOString(),
        });
      }
      const deload = document.getElementById('deload-session-btn').classList.contains('active');
      document.body.removeChild(backdrop);
      onDone(Math.round(min * 60), !!scope && scope.dataset.scope === 'partial', deload);
    };
    document.getElementById('duration-ok').addEventListener('click', confirmDuration);
    // Dos botones grandes en vez de radios: con 2 ejercicios o menos sin hacer
    // se preselecciona "Completa"; con más, "Parcial".
    backdrop.querySelectorAll('.scope-btn').forEach(b => b.addEventListener('click', () => {
      backdrop.querySelectorAll('.scope-btn').forEach(x => x.classList.toggle('active', x === b));
    }));
    document.getElementById('deload-session-btn').addEventListener('click', (e) => e.currentTarget.classList.toggle('active'));
    document.getElementById('duration-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmDuration(); });
  }

  function openGymPrompt(subtitle) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>📍 ¿En qué gimnasio entrenas hoy?</h2>
        ${subtitle ? `<p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">${escapeHtml(subtitle)}</p>` : ''}
        <div class="field">
          <select id="gym-prompt-select">${gymOptionsHtml(draft.gym || '')}</select>
        </div>
        <button class="btn btn-primary btn-block" id="gym-prompt-ok">Continuar</button>
        <div style="height:8px;"></div>
        <button class="btn btn-block" id="gym-prompt-cancel">Cancelar, no voy a entrenar</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    const select = document.getElementById('gym-prompt-select');
    bindGymSelect(select, (g) => { draft.gym = g; });
    document.getElementById('gym-prompt-ok').addEventListener('click', () => {
      if (select.value !== '__new__') draft.gym = select.value;
      document.body.removeChild(backdrop);
      paint();
    });
    // Arrepentirse aquí no debe dejar una sesión abierta a medias.
    document.getElementById('gym-prompt-cancel').addEventListener('click', () => {
      document.body.removeChild(backdrop);
      clearSessionDraft(routineId);
      navigate('');
    });
  }

  // Objetivo de descanso del ejercicio: vive en la rutina y se cambia sin
  // bloquear nada. Vacío = sin objetivo (no pita).
  function openRestTargetEditor(slotId) {
    // El hueco puede venir de otra rutina (ejercicio trasladado).
    const found = resolveSlot(slotId);
    const slot = found ? found.slot : null;
    if (!slot) return;
    const slotRoutine = found.routine;
    const ex = getExercise(draft.entries[slotId].exerciseId);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>🎯 Objetivos del ejercicio</h2>
        <p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">${escapeHtml(ex ? ex.name : '')} — se guardan en la rutina.</p>
        <div class="field">
          <label>Descanso objetivo (segundos)</label>
          <input id="rest-target-input" type="text" inputmode="numeric" placeholder="Ej. 90 · 1:30 · 2 min" value="${slot.restSec ?? ''}" />
        </div>
        <div class="field">
          <label>Repes objetivo (de – a)</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="rep-lo-input" type="text" inputmode="numeric" placeholder="${repRangeOf(slotRoutine, slot).lo}" value="${slot.repLo ?? ''}" />
            <span style="color:var(--text-dim);">–</span>
            <input id="rep-hi-input" type="text" inputmode="numeric" placeholder="${repRangeOf(slotRoutine, slot).hi}" value="${slot.repHi ?? ''}" />
          </div>
          <div class="rest-note" style="margin-top:4px;">Vacío = el de la rutina (${repRangeOf(slotRoutine, slot).own ? 'ahora propio' : `${repRangeOf(slotRoutine, slot).lo}–${repRangeOf(slotRoutine, slot).hi}`}).</div>
        </div>
        <button class="btn btn-primary btn-block" id="rest-target-ok">Guardar</button>
        <div style="height:8px;"></div>
        <button class="btn btn-block" id="rest-target-cancel">Cancelar</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    const input = document.getElementById('rest-target-input');
    input.focus();
    input.select();
    const finish = () => {
      const n = parseSeconds(input.value);
      if (n === undefined) { showToast('Pon los segundos: 90, 1:30 o 2 min'); return; }
      slot.restSec = n;
      const lo = firstNum(document.getElementById('rep-lo-input').value);
      const hi = firstNum(document.getElementById('rep-hi-input').value);
      if (lo > 0 && hi >= lo) { slot.repLo = Math.round(lo); slot.repHi = Math.round(hi); }
      else { delete slot.repLo; delete slot.repHi; }
      saveDB();
      // Si el crono sigue en marcha y el objetivo se aleja, vuelve a armar el pitido.
      if (draft.restStart != null && n) {
        const elapsed = Math.floor((Date.now() - draft.restStart) / 1000);
        if (elapsed < Math.max(n - 10, 0)) { draft.restAlerted = false; saveDraft(); }
      }
      document.body.removeChild(backdrop);
      paint();
    };
    document.getElementById('rest-target-ok').addEventListener('click', finish);
    document.getElementById('rest-target-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
  }

  function restTargetOf(slotId) {
    const found = resolveSlot(slotId);
    const slot = found ? found.slot : null;
    return slot && slot.restSec > 0 ? slot.restSec : null;
  }

  function historyThresholds(total) {
    const steps = [3, 5, 10, 15, 20, 25, 30, 40, 50];
    const result = steps.filter(s => s < total);
    result.push(total);
    return result;
  }

  // ---------- Superseries ----------
  // Los ejercicios que comparten grupo se hacen enlazados. Lo que se pinta y se
  // guarda en la sesión es draft.supersets (hoy), no slot.supersetGroup (plan).
  function slotExerciseName(slot) {
    const entryForSlot = draft.entries[slot.id];
    const ex = getExercise(entryForSlot ? entryForSlot.exerciseId : slot.exerciseId);
    return ex ? ex.name : '?';
  }

  function supersetGroupOf(slot) {
    return draft.supersets[slot.id] || null;
  }

  function supersetPartners(slot) {
    const group = supersetGroupOf(slot);
    if (!group) return [];
    return routine.slots
      .map((s, i) => ({ slot: s, idx: i }))
      .filter(({ slot: s }) => s.id !== slot.id && supersetGroupOf(s) === group);
  }

  // Compara por compañeros, no por id de grupo: enlazar hoy genera un id nuevo
  // aunque el emparejamiento sea el mismo que el de la rutina.
  function supersetDiffersFromPlan(slot) {
    const plan = slot.supersetGroup || null;
    const today = supersetPartners(slot).map(p => p.slot.id).sort().join(',');
    const planned = !plan ? '' : routine.slots
      .filter(s => s.id !== slot.id && s.supersetGroup === plan)
      .map(s => s.id).sort().join(',');
    return today !== planned;
  }

  function supersetNoteHtml(slot) {
    const partners = supersetPartners(slot);
    const todayOnly = supersetDiffersFromPlan(slot);
    if (!partners.length) {
      const label = todayOnly ? '🔗 Hoy sin superserie' : '🔗 Enlazar superserie';
      return `<div class="superset-link" data-superset="${slot.id}">${label}</div>`;
    }
    const names = partners
      .map(({ slot: s, idx: i }) => `${i + 1}. ${escapeHtml(slotExerciseName(s))}`)
      .join(' · ');
    return `<div class="superset-note" data-superset="${slot.id}">🔗 Superserie con ${names}${todayOnly ? ' <span class="ss-today">solo hoy</span>' : ''}</div>`;
  }

  // Un grupo con un solo ejercicio ya no es una superserie.
  function cleanupSupersetGroups() {
    const counts = {};
    routine.slots.forEach(s => {
      const g = draft.supersets[s.id];
      if (g) counts[g] = (counts[g] || 0) + 1;
    });
    routine.slots.forEach(s => {
      const g = draft.supersets[s.id];
      if (g && counts[g] < 2) draft.supersets[s.id] = null;
    });
  }

  function openSupersetPicker(slotId) {
    const slot = routine.slots.find(s => s.id === slotId);
    if (!slot) return;
    const partners = supersetPartners(slot);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const rows = routine.slots
      .map((s, i) => ({ slot: s, idx: i }))
      .filter(({ slot: s }) => s.id !== slotId)
      .map(({ slot: s, idx: i }) => {
        const linked = supersetGroupOf(slot) && supersetGroupOf(s) === supersetGroupOf(slot);
        return `<div class="pick-row" data-pick-slot="${s.id}">${linked ? '🔗 ' : ''}${i + 1}. ${escapeHtml(slotExerciseName(s))}</div>`;
      }).join('') || '<div class="empty-state">No hay otros ejercicios en la rutina.</div>';
    const differs = routine.slots.some(s => supersetDiffersFromPlan(s));
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>🔗 Superserie</h2>
        <p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">Vale <b>solo para el entreno de hoy</b>. Elige con qué ejercicio la haces enlazada; toca uno ya enlazado (🔗) para quitarlo.</p>
        <div>${rows}</div>
        ${partners.length ? '<button class="btn btn-danger btn-block" id="superset-clear" style="margin-top:10px;">Hoy sin superserie</button><div style="height:8px;"></div>' : '<div style="height:10px;"></div>'}
        ${differs ? '<button class="btn btn-block" id="superset-pin">📌 Fijar también en la rutina</button><div style="height:8px;"></div>' : ''}
        <button class="btn btn-block" id="superset-cancel">Cancelar</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelectorAll('[data-pick-slot]').forEach(el => el.addEventListener('click', () => {
      const otherId = el.dataset.pickSlot;
      const group = supersetGroupOf(slot);
      if (group && draft.supersets[otherId] === group) {
        draft.supersets[otherId] = null;
      } else {
        const g = group || draft.supersets[otherId] || uid();
        draft.supersets[slot.id] = g;
        draft.supersets[otherId] = g;
      }
      cleanupSupersetGroups();
      saveDraft();
      document.body.removeChild(backdrop);
      paint();
    }));
    const clearBtn = document.getElementById('superset-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      const group = supersetGroupOf(slot);
      routine.slots.forEach(s => { if (draft.supersets[s.id] === group) draft.supersets[s.id] = null; });
      saveDraft();
      document.body.removeChild(backdrop);
      paint();
    });
    const pinBtn = document.getElementById('superset-pin');
    if (pinBtn) pinBtn.addEventListener('click', () => {
      routine.slots.forEach(s => {
        const g = draft.supersets[s.id];
        if (g) s.supersetGroup = g; else delete s.supersetGroup;
      });
      saveDB();
      document.body.removeChild(backdrop);
      showToast('Superseries fijadas en la rutina');
      paint();
    });
    document.getElementById('superset-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
  }

  // Posición en la que se ha hecho hoy cada ejercicio (1, 2, 3…).
  function todayOrderMap() {
    const map = {};
    (draft.doneSeq || []).forEach((id, i) => { map[id] = i + 1; });
    return map;
  }

  // Corregir a mano el orden de hoy: se mueve dentro de la lista, sin huecos.
  function setDonePos(slotId, pos) {
    const seq = (draft.doneSeq || []).filter(id => id !== slotId);
    const target = Math.max(1, Math.min(seq.length + 1, pos)) - 1;
    seq.splice(target, 0, slotId);
    draft.doneSeq = seq;
    saveDraft();
    paint();
  }

  function openOrderEditor(slotId) {
    const order = todayOrderMap();
    const total = (draft.doneSeq || []).length;
    const ex = getExercise(draft.entries[slotId].exerciseId);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>↕ Orden de hoy</h2>
        <p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">${escapeHtml(ex ? ex.name : '')} — solo para esta sesión; la rutina mantiene su orden.</p>
        <div class="order-list">
          ${(draft.doneSeq || []).map((id, i) => {
            const e2 = draft.entries[id];
            const x = e2 && getExercise(e2.exerciseId);
            return `<div class="order-row${id === slotId ? ' order-current' : ''}">${i + 1}. ${escapeHtml(x ? x.name : '?')}</div>`;
          }).join('')}
        </div>
        <div class="field" style="margin-top:12px;">
          <label>Hoy lo hice el número</label>
          <input id="order-input" type="text" inputmode="numeric" value="${order[slotId] || total}" />
        </div>
        <button class="btn btn-primary btn-block" id="order-ok">Guardar</button>
        <div style="height:8px;"></div>
        <button class="btn btn-block" id="order-cancel">Cancelar</button>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => { if (backdrop.parentNode) document.body.removeChild(backdrop); };
    document.getElementById('order-ok').addEventListener('click', () => {
      const n = firstNum(document.getElementById('order-input').value);
      if (!n || n < 1) { showToast('Pon un número de 1 en adelante'); return; }
      close();
      setDonePos(slotId, Math.round(n));
    });
    document.getElementById('order-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  }

  function paint() {
    saveDraft();
    const doneSlotIds = draft.doneFrom ? draft.doneFrom.slotIds : [];
    const orderToday = todayOrderMap();
    const renderBlock = (slot, idx, slotRoutine, transfer) => {
      const plannedEx = getExercise(slot.exerciseId);
      const entry = draft.entries[slot.id];
      const currentEx = getExercise(entry.exerciseId);
      const isSub = entry.exerciseId !== slot.exerciseId;
      // Última sustitución de este hueco en esta rutina, para repetirla de un toque.
      const lastSubSession = db.sessions
        .filter(ses => ses.routineId === slotRoutine.id && ses.entries.some(x => x.slotId === slot.id && x.exerciseId !== slot.exerciseId))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const lastSubEntry = lastSubSession && lastSubSession.entries.find(x => x.slotId === slot.id);
      const lastSubEx = lastSubEntry ? getExercise(lastSubEntry.exerciseId) : null;
      const lastSubDate = lastSubSession ? lastSubSession.date : null;

      // Continuación de una sesión parcial: lo hecho el otro día se muestra
      // plegado y sin registro, para ir directo a lo que falta.
      if (doneSlotIds.includes(slot.id)) {
        const prev = db.sessions.find(x => x.id === draft.doneFrom.sessionId);
        const prevEntry = prev && prev.entries.find(e => e.slotId === slot.id);
        const doneEx = getExercise(prevEntry ? prevEntry.exerciseId : slot.exerciseId);
        const setsTxt = prevEntry ? prevEntry.sets.map(st => escapeHtml(`${st.weight}×${st.reps}`)).join(' · ') : '';
        return `
        <div class="exercise-block exercise-done" style="${muscleBackgroundStyle(doneEx && doneEx.muscle)}">
          ${doneEx && doneEx.muscle ? muscleBadgeHtml(doneEx.muscle) : ''}
          <div class="exercise-head">
            <div>
              <h3>${idx + 1}. ${escapeHtml(doneEx ? doneEx.name : '(ejercicio eliminado)')}</h3>
              <div class="done-note">✓ Hecho el ${fmtDateShort(draft.doneFrom.date)}${setsTxt ? ' · ' + setsTxt : ''}</div>
              <span class="technique-link" data-redo="${slot.id}">Repetir hoy</span>
            </div>
          </div>
        </div>`;
      }

      const totalHistoryCount = pastSessionsForSlot(slot.id, Infinity).length;
      const history = pastSessionsForSlot(slot.id, entry._historyLimit);
      const maxSets = history.reduce((m, h) => Math.max(m, h.entry.sets.length), 0);
      const historyMoreHtml = totalHistoryCount > 3 ? `
        <div class="history-more">
          <label>Mostrar últimas:</label>
          <select data-history-limit="${slot.id}">
            ${historyThresholds(totalHistoryCount).map(n => `<option value="${n}" ${n === entry._historyLimit || (entry._historyLimit >= totalHistoryCount && n === totalHistoryCount) ? 'selected' : ''}>${n === totalHistoryCount ? `Todas (${n})` : n}</option>`).join('')}
          </select>
        </div>
      ` : '';
      const historyHtml = history.length ? `
        <div class="history-table-wrap">
          <table class="history-table">
            <thead><tr>
              <th>Fecha</th>
              ${Array.from({ length: maxSets }, (_, i) => `<th>S${i + 1}</th>`).join('')}
            </tr></thead>
            <tbody>
              ${history.map(({ session, entry: e, foreign }) => {
                const exUsed = getExercise(e.exerciseId);
                const wasSub = !foreign && e.exerciseId !== slot.exerciseId;
                const fromRoutine = foreign ? getRoutine(session.routineId) : null;
                const cells = Array.from({ length: maxSets }, (_, i) => e.sets[i] ? `<td>${formatSetCell(e.sets[i])}</td>` : '<td>—</td>').join('');
                return `<tr>
                  <td class="date-cell">${fmtDate(e.doneOn || session.date)}${e.doneOn ? '<div class="transfer-tag-sm">↗ trasladado</div>' : ''}${foreign ? `<div class="from-routine">↗ ${escapeHtml(fromRoutine ? fromRoutine.name : 'otra rutina')}</div>` : ''}${session.gym ? `<div class="gym-tag-sm">📍 ${escapeHtml(session.gym)}</div>` : ''}${entryIsUni(e) ? '<div class="uni-tag-sm">🔀 unilateral</div>' : ''}${!foreign && e.doneOrder ? `<div class="order-tag-sm">↕ ese día, el ${e.doneOrder}º</div>` : ''}${wasSub ? `<div class="sub-note-sm" title="Sustituye a ${escapeHtml(exUsed ? exUsed.name : '?')}">🔄 ${escapeHtml(exUsed ? exUsed.name : '?')}</div>` : ''}${e.restNote ? `<div class="rest-note">desc. obj: ${escapeHtml(e.restNote)}s</div>` : ''}</td>
                  ${cells}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="history-empty">Sin sesiones anteriores para este ejercicio.</div>';

      const target = restTargetOf(slot.id);
      const range = repRangeOf(slotRoutine, slot);
      const targetTag = `<button class="btn-ghost rest-target-tag" data-edit-rest="${slot.id}">🎯 ${target ? `${target}s` : 'sin desc.'} · ${range.lo}–${range.hi} reps</button>`;
      // Recomendación de Progreso, aquí mismo, que es donde se decide el peso.
      const ptsToday = slotProgressPoints(slotRoutine, slot, entry.exerciseId, !!entry.uni);
      const rec = recommendForSlot(slotRoutine, slot, ptsToday);
      const warmOpen = idx === 0 || !!(draft.warmup && draft.warmup[slot.id]);
      const warmup = warmOpen
        ? warmupHtml(ptsToday, true)
        : (warmupHtml(ptsToday, false) ? `<span class="warmup-link" data-warmup="${slot.id}">🔥 calentamiento</span>` : '');
      const recHtml = isDeloadActive()
        ? `<div class="rec-inline rec-deload">🪫 Descarga: 60–70 % del peso habitual y RIR 3–4. Esta sesión no cuenta para las recomendaciones.</div>`
        : rec.level !== 'info'
          ? `<div class="rec-inline rec-${rec.level}">${{ up: '⬆️', keep: '➡️', down: '⬇️' }[rec.level]} ${entry.uni ? '🔀 ' : ''}${escapeHtml(rec.text)}</div>`
          : '';

      const setsHtml = entry.sets.map((set, sIdx) => {
        const showGap = !(idx === 0 && sIdx === 0);
        return `
        ${showGap ? `
          <div class="rest-gap">
            ⏱ <input type="text" inputmode="numeric" class="rest-gap-input" data-restsec="${slot.id}:${sIdx}" value="${set.restSec ?? ''}" placeholder="—" /> s descanso
          </div>
        ` : ''}
        <div class="set-row${entry.uni ? ' set-row-uni' : ''}">
          <div class="set-num">${sIdx + 1}</div>
          <input type="text" inputmode="decimal" placeholder="kg" data-weight="${slot.id}:${sIdx}" value="${set.weight ?? ''}" />
          <input type="text" inputmode="decimal" placeholder="${entry.uni ? 'der' : 'reps'}" data-reps="${slot.id}:${sIdx}" value="${set.reps ?? ''}" />
          ${entry.uni ? `<input type="text" inputmode="decimal" placeholder="izq" data-reps2="${slot.id}:${sIdx}" value="${set.reps2 ?? ''}" />` : ''}
          <input type="text" inputmode="decimal" placeholder="${entry.uni ? 'RIR d' : 'RIR'}" data-rir="${slot.id}:${sIdx}" value="${set.rir ?? ''}" />
          ${entry.uni ? `<input type="text" inputmode="decimal" placeholder="RIR i" data-rir2="${slot.id}:${sIdx}" value="${set.rir2 ?? ''}" />` : ''}
          <button class="rm" data-rm-set="${slot.id}:${sIdx}">✕</button>
        </div>
        <div class="pr-line" data-pr="${slot.id}:${sIdx}" hidden></div>
        ${(set.stages || []).map((st, stIdx) => `
          <div class="set-row set-row-sub${entry.uni ? ' set-row-uni' : ''}">
            <div class="set-num">${set.technique === 'dropset' ? 'D' + (stIdx + 1) : 'P' + (stIdx + 1)}</div>
            ${set.technique === 'dropset'
              ? `<input type="text" inputmode="decimal" placeholder="kg" data-stage-weight="${slot.id}:${sIdx}:${stIdx}" value="${st.weight ?? ''}" />`
              : `<input type="number" inputmode="numeric" placeholder="⏱ s" title="Segundos de pausa" data-stage-pause="${slot.id}:${sIdx}:${stIdx}" value="${st.pauseSec ?? ''}" />`}
            <input type="text" inputmode="decimal" placeholder="${entry.uni ? 'der' : 'reps'}" data-stage-reps="${slot.id}:${sIdx}:${stIdx}" value="${st.reps ?? ''}" />
            ${entry.uni ? `<input type="text" inputmode="decimal" placeholder="izq" data-stage-reps2="${slot.id}:${sIdx}:${stIdx}" value="${st.reps2 ?? ''}" />` : ''}
            <div></div>
            ${entry.uni ? '<div></div>' : ''}
            <button class="rm" data-rm-stage="${slot.id}:${sIdx}:${stIdx}">✕</button>
          </div>
        `).join('')}
        ${set.partials ? `
          <div class="set-row set-row-sub${entry.uni ? ' set-row-uni' : ''}">
            <div class="set-num">Pa</div>
            <div class="partial-label">parciales</div>
            <input type="text" inputmode="decimal" placeholder="${entry.uni ? 'der' : 'reps'}" data-partial-reps="${slot.id}:${sIdx}" value="${set.partialReps ?? ''}" />
            ${entry.uni ? `<input type="text" inputmode="decimal" placeholder="izq" data-partial-reps2="${slot.id}:${sIdx}" value="${set.partialReps2 ?? ''}" />` : ''}
            <div></div>
            ${entry.uni ? '<div></div>' : ''}
            <button class="rm" data-rm-partials="${slot.id}:${sIdx}">✕</button>
          </div>` : ''}
        <div class="technique-actions">
          ${!set.technique
            ? `<span class="technique-link" data-add-technique="${slot.id}:${sIdx}:dropset">+ Drop set</span><span class="technique-link" data-add-technique="${slot.id}:${sIdx}:restpause">+ Rest-pause</span>`
            : `<span class="technique-link" data-add-stage="${slot.id}:${sIdx}">+ ${set.technique === 'dropset' ? 'Otra caída' : 'Otra pausa'}</span>`}
          ${!set.partials ? `<span class="technique-link" data-add-partials="${slot.id}:${sIdx}">+ Parciales</span>` : ''}
        </div>
      `;
      }).join('');
      const labelsHtml = entry.sets.length ? `
        <div class="set-labels${entry.uni ? ' set-row-uni' : ''}"><span></span><span>Kg</span><span>${entry.uni ? 'Der' : 'Reps'}</span>${entry.uni ? '<span>Izq</span>' : ''}<span>${entry.uni ? 'RIR d' : 'RIR'}</span>${entry.uni ? '<span>RIR i</span>' : ''}<span></span></div>
      ` : '';
      const uniToggle = `<button class="btn-ghost uni-toggle" data-toggle-uni="${slot.id}">${entry.uni ? '🔀 Unilateral' : '↔ Bilateral'}</button>`;

      return `
        <div class="exercise-block${transfer ? ' exercise-transfer' : ''}" style="${muscleBackgroundStyle(currentEx && currentEx.muscle)}">
          ${currentEx && currentEx.muscle ? muscleBadgeHtml(currentEx.muscle) : ''}
          <div class="exercise-head">
            <div>
              <h3>${transfer ? '↗' : idx + 1 + '.'} ${escapeHtml(currentEx ? currentEx.name : '(ejercicio eliminado)')}</h3>
              ${transfer ? `<div class="transfer-note">Pendiente de ${escapeHtml(transfer.fromRoutine.name)} · se guarda en la sesión del ${fmtDateShort(transfer.fromSession.date)}</div>` : ''}
              ${!transfer && orderToday[slot.id] ? `<div class="order-tag${orderToday[slot.id] !== idx + 1 ? ' order-changed' : ''}" data-edit-order="${slot.id}">↕ hoy lo hice el ${orderToday[slot.id]}º${orderToday[slot.id] !== idx + 1 ? ' (en la rutina es el ' + (idx + 1) + 'º)' : ''}</div>` : ''}
              ${currentEx && currentEx.notes ? `<div class="notes-line" data-edit-ex-notes="${currentEx.id}">✎ ${escapeHtml(currentEx.notes)}</div>` : currentEx ? `<div class="notes-line notes-line-empty" data-edit-ex-notes="${currentEx.id}">+ añadir observación</div>` : ''}
              ${isSub ? `<div class="sub-note">🔄 Sustituye a: ${escapeHtml(plannedEx ? plannedEx.name : '?')}</div>` : ''}
              ${!isSub && lastSubEx ? `<div class="sub-quick" data-quick-sub="${slot.id}:${lastSubEx.id}">🔄 Hoy con ${escapeHtml(lastSubEx.name)} (como el ${fmtDateShort(lastSubDate)})</div>` : ''}
              ${transfer ? '' : supersetNoteHtml(slot)}
            </div>
            <button class="btn btn-ghost" data-swap="${slot.id}" style="font-size:13px;white-space:nowrap;">Sustituir</button>
          </div>
          <div class="history">${historyHtml}${historyMoreHtml}${recHtml}${warmup}</div>
          <div class="rest-widget">${targetTag}${uniToggle}</div>
          <div class="log-area">
            ${labelsHtml}
            ${setsHtml}
            <div class="log-actions">
              <button class="btn" data-add-set="${slot.id}">+ Serie (inicia crono)</button>
              ${entry.sets.length ? `<button class="btn" data-add-same="${slot.id}" title="Misma serie: copia peso y repes">+ Igual</button>` : ''}
              ${isSub ? `<button class="btn" data-revert="${slot.id}">Deshacer sustitución</button>` : ''}
            </div>
          </div>
        </div>
      `;
    };
    const blocks = routine.slots.map((slot, idx) => renderBlock(slot, idx, routine, null)).join('')
      + transferItems.map((it, i) => renderBlock(it.slot, routine.slots.length + i, it.fromRoutine, it)).join('');

    app.innerHTML = `
      <div class="topbar">
        <button class="btn btn-ghost" data-nav="">← Atrás</button>
        <h1>${escapeHtml(routine.name)}</h1>
        <button class="btn btn-icon" id="discard-session-btn" title="Descartar esta sesión">🗑</button>
        <button class="btn btn-icon" data-nav="routine-edit/${routine.id}" title="Editar rutina">✎</button>
      </div>
      <div class="gym-field">
        📍 <select id="session-gym">${gymOptionsHtml(draft.gym || '')}</select>
      </div>
      <div class="gym-field gym-field-notes">
        📝 <input id="session-notes" placeholder="Notas de hoy (ej. hombro molestando)" value="${escapeHtml(draft.notes || '')}" />
      </div>
      ${pendingMessagesHtml(routineId) ? `<div class="msg-wrap">${pendingMessagesHtml(routineId)}</div>` : ''}
      <div class="container">
        ${blocks}
      </div>
      <div class="save-bar">
        <button class="btn btn-primary btn-block" id="finish-session-btn">Guardar sesión</button>
      </div>
    `;
    // Barra del cronómetro: fija arriba, fuera de #app para que el repintado
    // de la pantalla no la recree, e inmune al zoom (ver pinRestBarToViewport).
    let restBar = document.getElementById('rest-bar');
    if (!restBar) {
      restBar = document.createElement('div');
      restBar.id = 'rest-bar';
      restBar.className = 'rest-bar';
      document.body.appendChild(restBar);
    }
    const restState = draft.restStart != null ? 'running' : draft.restPendingSec != null ? 'stopped' : 'idle';
    restBar.dataset.state = restState;
    // Mitad izquierda: cronómetro; mitad derecha: botón. Debajo, series por músculo de hoy.
    restBar.innerHTML = `
      <div class="rest-bar-main">
        <div class="rest-bar-left">
          ${restState === 'running' ? `<span class="rest-live" id="rest-live">⏱ 0:00</span><span class="rest-bar-info" id="rest-bar-info"></span>`
            : restState === 'stopped' ? `<span class="rest-live rest-done">✔ ${mmss(draft.restPendingSec)}</span><span class="rest-bar-info">se guarda en la próxima serie</span>`
            : `<span class="rest-live rest-idle">⏱ —</span><span class="rest-bar-info">pulsa «+ Serie» al acabar</span>`}
        </div>
        <div class="rest-bar-right">
          ${restState === 'running' ? `<button class="btn rest-bar-btn" id="rest-stop">⏹ Parar</button>`
            : restState === 'stopped' ? `<button class="btn rest-bar-btn rest-bar-btn-ghost" id="rest-cancel">✕ Descartar</button>`
            : ''}
        </div>
      </div>
      <div class="rest-bar-muscles" id="rest-bar-muscles"></div>`;
    refreshRestMuscles();
    document.getElementById('app').classList.add('with-rest-bar');
    pinRestBarToViewport();

    app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));

    document.getElementById('discard-session-btn').addEventListener('click', () => {
      if (!confirm('¿Descartar esta sesión en curso? Se perderán todas las series registradas todavía sin guardar.')) return;
      clearSessionDraft(routineId);
      navigate('');
    });

    bindGymSelect(document.getElementById('session-gym'), (g) => { draft.gym = g; saveDraft(); });
    bindMessageDismiss(app, paint);
    document.getElementById('session-notes').addEventListener('input', (e) => { draft.notes = e.target.value; saveDraft(); });

    app.querySelectorAll('[data-history-limit]').forEach(el => el.addEventListener('change', () => {
      draft.entries[el.dataset.historyLimit]._historyLimit = Number(el.value);
      paint();
    }));

    app.querySelectorAll('[data-edit-ex-notes]').forEach(el => el.addEventListener('click', () => {
      const ex = getExercise(el.dataset.editExNotes);
      if (ex) openExerciseEditor(ex, paint);
    }));

    app.querySelectorAll('[data-superset]').forEach(el => el.addEventListener('click', () => {
      openSupersetPicker(el.dataset.superset);
    }));
    app.querySelectorAll('[data-redo]').forEach(el => el.addEventListener('click', () => {
      draft.doneFrom.slotIds = draft.doneFrom.slotIds.filter(id => id !== el.dataset.redo);
      paint();
    }));

    // "+ Serie" se pulsa al acabar la serie: cierra el descanso que venía
    // corriendo (o usa el ya parado con ⏹) y arranca el de la siguiente.
    // copySame: "+ Igual" copia también las repes (y las de la izquierda en
    // unilateral); el RIR nunca, que se decide serie a serie. El cronómetro
    // funciona igual en ambos.
    const addSet = (slotId, copySame) => {
      const entry = draft.entries[slotId];
      const now = Date.now();
      const restSec = draft.restPendingSec != null
        ? draft.restPendingSec
        : draft.restStart != null ? Math.round((now - draft.restStart) / 1000) : null;
      draft.restPendingSec = null;
      const lastSet = entry.sets[entry.sets.length - 1];
      const val = (v) => (v !== '' && v != null ? v : '');
      const defaultWeight = lastSet ? val(lastSet.weight) : '';
      const set = { weight: defaultWeight, reps: copySame && lastSet ? val(lastSet.reps) : '', rir: '', restSec };
      if (copySame && lastSet && entry.uni) set.reps2 = val(lastSet.reps2);
      entry.sets.push(set);
      // El orden de hoy se apunta solo: el ejercicio entra en la lista la
      // primera vez que se le añade una serie. La rutina no se toca.
      draft.doneSeq = draft.doneSeq || [];
      if (!draft.doneSeq.includes(slotId)) { draft.doneSeq.push(slotId); }
      unlockAudio();
      draft.restStart = now;
      draft.restSlotId = slotId;
      draft.restAlerted = false;
      markActivity();
      paint();
    };
    app.querySelectorAll('[data-add-set]').forEach(el => el.addEventListener('click', () => addSet(el.dataset.addSet, false)));
    app.querySelectorAll('[data-add-same]').forEach(el => el.addEventListener('click', () => addSet(el.dataset.addSame, true)));

    app.querySelectorAll('[data-edit-rest]').forEach(el => el.addEventListener('click', () => {
      openRestTargetEditor(el.dataset.editRest);
    }));

    app.querySelectorAll('[data-edit-order]').forEach(el => el.addEventListener('click', () => {
      openOrderEditor(el.dataset.editOrder);
    }));

    const restStopBtn = document.getElementById('rest-stop');
    if (restStopBtn) restStopBtn.addEventListener('click', () => {
      // Se para al empezar la serie: lo que corre desde aquí es ejecución, no descanso.
      draft.restPendingSec = Math.round((Date.now() - draft.restStart) / 1000);
      draft.restStart = null;
      draft.restSlotId = null;
      paint();
    });
    const restCancelBtn = document.getElementById('rest-cancel');
    if (restCancelBtn) restCancelBtn.addEventListener('click', () => {
      draft.restPendingSec = null;
      paint();
    });

    Object.keys(restIntervals).forEach(k => clearInterval(restIntervals[k]));
    if (draft.restStart != null) {
      const since = draft.restStart;
      const targetSec = draft.restSlotId ? restTargetOf(draft.restSlotId) : null;
      const restEx = draft.restSlotId && draft.entries[draft.restSlotId] ? getExercise(draft.entries[draft.restSlotId].exerciseId) : null;
      const info = document.getElementById('rest-bar-info');
      if (info) info.textContent = (targetSec ? `/ ${mmss(targetSec)}` : '') + (restEx ? ` · ${restEx.name}` : '');
      const tick = () => {
        const elapsed = Math.floor((Date.now() - since) / 1000);
        const live = document.getElementById('rest-live');
        if (live) {
          live.textContent = '⏱ ' + mmss(elapsed);
          live.classList.toggle('rest-over', !!targetSec && elapsed >= targetSec);
        }
        // El "ya he avisado" vive en el draft, no en esta función: si viviera aquí
        // se reiniciaría en cada repintado y volvería a pitar en cada toque.
        if (targetSec && !draft.restAlerted && elapsed >= Math.max(targetSec - 10, 0)) {
          draft.restAlerted = true;
          saveDraft();
          playRestBeep();
        }
      };
      tick();
      restIntervals.global = setInterval(tick, 1000);
    }

    app.querySelectorAll('[data-rm-set]').forEach(el => el.addEventListener('click', () => {
      const [slotId, sIdx] = el.dataset.rmSet.split(':');
      draft.entries[slotId].sets.splice(Number(sIdx), 1);
      paint();
    }));

    app.querySelectorAll('[data-add-technique]').forEach(el => el.addEventListener('click', () => {
      const [slotId, sIdx, type] = el.dataset.addTechnique.split(':');
      const set = draft.entries[slotId].sets[Number(sIdx)];
      set.technique = type;
      set.stages = [type === 'dropset' ? { weight: '', reps: '' } : { reps: '' }];
      paint();
    }));

    app.querySelectorAll('[data-add-partials]').forEach(el => el.addEventListener('click', () => {
      const [slotId, sIdx] = el.dataset.addPartials.split(':');
      const set = draft.entries[slotId].sets[Number(sIdx)];
      set.partials = true;
      set.partialReps = '';
      paint();
      const inp = app.querySelector(`[data-partial-reps="${slotId}:${sIdx}"]`);
      if (inp) inp.focus();
    }));
    app.querySelectorAll('[data-rm-partials]').forEach(el => el.addEventListener('click', () => {
      const [slotId, sIdx] = el.dataset.rmPartials.split(':');
      const set = draft.entries[slotId].sets[Number(sIdx)];
      delete set.partials; delete set.partialReps; delete set.partialReps2;
      paint();
    }));
    app.querySelectorAll('[data-partial-reps]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.partialReps.split(':');
      draft.entries[slotId].sets[Number(sIdx)].partialReps = normalizeDecimal(el.value);
      saveDraft();
    }));
    app.querySelectorAll('[data-partial-reps2]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.partialReps2.split(':');
      draft.entries[slotId].sets[Number(sIdx)].partialReps2 = normalizeDecimal(el.value);
      saveDraft();
    }));

    app.querySelectorAll('[data-add-stage]').forEach(el => el.addEventListener('click', () => {
      const [slotId, sIdx] = el.dataset.addStage.split(':');
      const set = draft.entries[slotId].sets[Number(sIdx)];
      set.stages.push(set.technique === 'dropset' ? { weight: '', reps: '' } : { reps: '' });
      paint();
    }));

    app.querySelectorAll('[data-rm-stage]').forEach(el => el.addEventListener('click', () => {
      const [slotId, sIdx, stIdx] = el.dataset.rmStage.split(':');
      const set = draft.entries[slotId].sets[Number(sIdx)];
      set.stages.splice(Number(stIdx), 1);
      if (!set.stages.length) { set.technique = null; delete set.stages; }
      paint();
    }));

    app.querySelectorAll('[data-stage-weight]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx, stIdx] = el.dataset.stageWeight.split(':');
      draft.entries[slotId].sets[Number(sIdx)].stages[Number(stIdx)].weight = normalizeDecimal(el.value);
      saveDraft();
    }));

    app.querySelectorAll('[data-stage-reps]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx, stIdx] = el.dataset.stageReps.split(':');
      draft.entries[slotId].sets[Number(sIdx)].stages[Number(stIdx)].reps = normalizeDecimal(el.value);
      saveDraft();
    }));

    app.querySelectorAll('[data-stage-pause]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx, stIdx] = el.dataset.stagePause.split(':');
      const n = Number(el.value);
      draft.entries[slotId].sets[Number(sIdx)].stages[Number(stIdx)].pauseSec = n > 0 ? n : null;
      saveDraft();
    }));

    app.querySelectorAll('[data-stage-reps2]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx, stIdx] = el.dataset.stageReps2.split(':');
      draft.entries[slotId].sets[Number(sIdx)].stages[Number(stIdx)].reps2 = normalizeDecimal(el.value);
      saveDraft();
    }));

    // 🏆 si la serie supera el mejor 1RM estimado guardado de ese ejercicio.
    const prCache = {};
    function refreshPr(slotId, sIdx) {
      const line = app.querySelector(`[data-pr="${slotId}:${sIdx}"]`);
      if (!line) return;
      const entry = draft.entries[slotId];
      const set = entry.sets[Number(sIdx)];
      const w = firstNum(set.weight), r = firstNum(set.reps);
      if (w == null || r == null || w <= 0 || r <= 0 || r > 100) { line.hidden = true; return; }
      const cacheKey = entry.exerciseId + (entry.uni ? ':u' : ':b');
      if (!(cacheKey in prCache)) prCache[cacheKey] = bestSetForExercise(entry.exerciseId, !!entry.uni);
      const best = prCache[cacheKey];
      const v = e1rm(w, r);
      if (best && v > best.e1rm + 0.05) {
        line.textContent = `🏆 Récord: ${Math.round(v)} kg est. (antes ${best.w}×${best.r} el ${fmtDateShort(best.date)})`;
        line.hidden = false;
      } else line.hidden = true;
    }
    app.querySelectorAll('[data-pr]').forEach(el => { const [a, b] = el.dataset.pr.split(':'); refreshPr(a, b); });

    app.querySelectorAll('[data-weight]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.weight.split(':');
      draft.entries[slotId].sets[Number(sIdx)].weight = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
      refreshPr(slotId, sIdx);
      refreshRestMuscles();
    }));
    app.querySelectorAll('[data-reps]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.reps.split(':');
      draft.entries[slotId].sets[Number(sIdx)].reps = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
      refreshPr(slotId, sIdx);
      refreshRestMuscles();
    }));
    app.querySelectorAll('[data-rir]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.rir.split(':');
      draft.entries[slotId].sets[Number(sIdx)].rir = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
    }));
    app.querySelectorAll('[data-rir2]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.rir2.split(':');
      draft.entries[slotId].sets[Number(sIdx)].rir2 = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
    }));
    app.querySelectorAll('[data-reps2]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.reps2.split(':');
      draft.entries[slotId].sets[Number(sIdx)].reps2 = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
    }));
    app.querySelectorAll('[data-restsec]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.restsec.split(':');
      const v = parseSeconds(el.value);
      if (v === undefined) return; // texto a medias: no se toca lo que había
      draft.entries[slotId].sets[Number(sIdx)].restSec = v;
      saveDraft();
    }));
    app.querySelectorAll('[data-toggle-uni]').forEach(el => el.addEventListener('click', () => {
      const entry = draft.entries[el.dataset.toggleUni];
      entry.uni = !entry.uni;
      paint();
    }));

    app.querySelectorAll('[data-swap]').forEach(el => el.addEventListener('click', () => {
      const slotId = el.dataset.swap;
      openExercisePicker('Sustituir ejercicio (solo esta sesión)', (exerciseId) => {
        draft.entries[slotId].exerciseId = exerciseId;
        paint();
      }, {
        onDelete: () => {
          const ex = getExercise(draft.entries[slotId].exerciseId);
          if (!confirm(`¿Eliminar "${ex ? ex.name : 'este ejercicio'}" de la rutina "${routine.name}"? El histórico ya guardado no se borra, pero dejará de aparecer aquí.`)) return;
          routine.slots = routine.slots.filter(s => s.id !== slotId);
          delete draft.entries[slotId];
          saveDB();
          showToast('Ejercicio eliminado de la rutina');
          paint();
        }
      });
    }));

    app.querySelectorAll('[data-warmup]').forEach(el => el.addEventListener('click', () => {
      draft.warmup = draft.warmup || {};
      draft.warmup[el.dataset.warmup] = true;
      paint();
    }));

    app.querySelectorAll('[data-quick-sub]').forEach(el => el.addEventListener('click', () => {
      const [slotId, exerciseId] = el.dataset.quickSub.split(':');
      draft.entries[slotId].exerciseId = exerciseId;
      paint();
    }));

    app.querySelectorAll('[data-revert]').forEach(el => el.addEventListener('click', () => {
      const slotId = el.dataset.revert;
      draft.entries[slotId].exerciseId = routine.slots.find(s => s.id === slotId).exerciseId;
      paint();
    }));

    document.getElementById('finish-session-btn').addEventListener('click', () => {
      const hasData = s => (s.weight !== '' && s.weight != null) || (s.reps !== '' && s.reps != null);
      const entries = Object.entries(draft.entries)
        .filter(([, e]) => e.sets.some(hasData))
        .map(([slotId, e]) => {
          const entryOut = {
            slotId,
            exerciseId: e.exerciseId,
            sets: e.sets
              .filter(hasData)
              .map(s => {
                const out = {
                  weight: Number(s.weight) || 0,
                  reps: Number(s.reps) || 0,
                  rir: s.rir !== '' && s.rir != null ? Number(s.rir) : null,
                  rir2: s.rir2 !== '' && s.rir2 != null ? Number(s.rir2) : null,
                  reps2: s.reps2 !== '' && s.reps2 != null ? Number(s.reps2) : null,
                  restSec: s.restSec ?? null
                };
                const stages = (s.stages || []).filter(st => (st.reps !== '' && st.reps != null) || (st.weight !== '' && st.weight != null));
                const joinReps = (first, key, sep) => [first, ...stages.map(st => st[key])].filter(r => r !== '' && r != null).join(sep);
                if (s.technique === 'dropset' && stages.length) {
                  out.weight = [s.weight, ...stages.map(st => st.weight)].filter(w => w !== '' && w != null).join('/');
                  out.reps = joinReps(s.reps, 'reps', '/');
                  if (out.reps2 != null) out.reps2 = joinReps(s.reps2, 'reps2', '/');
                  out.dropset = true;
                } else if (s.technique === 'restpause' && stages.length) {
                  out.reps = joinReps(s.reps, 'reps', '+');
                  if (out.reps2 != null) out.reps2 = joinReps(s.reps2, 'reps2', '+');
                  out.restPause = true;
                  // Pausas entre tramos, en segundos y en orden ("15+20").
                  const pauses = stages.map(st => st.pauseSec).filter(p => p != null && p !== '');
                  if (pauses.length) out.pauseSec = pauses.join('+');
                }
                if (s.partials) {
                  const p = firstNum(s.partialReps);
                  if (p != null && p > 0) {
                    out.partialReps = p;
                    const p2 = firstNum(s.partialReps2);
                    if (out.reps2 != null && p2 != null) out.partialReps2 = p2;
                  }
                }
                return out;
              })
          };
          const restTarget = restTargetOf(slotId);
          if (restTarget) entryOut.restNote = String(restTarget);
          // Orden real de hoy, solo si no coincide con el de la rutina.
          const seq = (draft.doneSeq || []).filter(id => draft.entries[id] && draft.entries[id].sets.some(hasData));
          const donePos = seq.indexOf(slotId) + 1;
          const planPos = routine.slots.findIndex(sl => sl.id === slotId) + 1;
          if (donePos > 0 && planPos > 0 && donePos !== planPos) entryOut.doneOrder = donePos;
          // Lo de hoy, no el plan de la rutina: así una sesión guardada conserva
          // si ese día concreto la hiciste enlazada o suelta.
          if (draft.supersets[slotId]) entryOut.supersetGroup = draft.supersets[slotId];
          return entryOut;
        });

      if (!entries.length) {
        showToast('Registra al menos una serie antes de guardar');
        return;
      }

      // Lo trasladado se escribe en la sesión de origen, con la fecha de hoy.
      const transferBySlot = new Map(transferItems.map(it => [it.slot.id, it]));
      const ownEntries = entries.filter(e => !transferBySlot.has(e.slotId));
      const movedEntries = entries.filter(e => transferBySlot.has(e.slotId));
      const applyMoved = () => {
        if (!movedEntries.length) return [];
        const now = new Date().toISOString();
        const touched = [];
        movedEntries.forEach(e => {
          const it = transferBySlot.get(e.slotId);
          const origin = db.sessions.find(x => x.id === it.transfer.fromSessionId);
          if (!origin) return;
          e.doneOn = now;
          origin.entries.push(e);
          it.transfer.slotIds = it.transfer.slotIds.filter(id => id !== e.slotId);
          const fromRoutine = getRoutine(origin.routineId);
          const done = new Set();
          db.sessions.forEach(s2 => { if (s2.id === origin.id || s2.continuesSessionId === origin.id) s2.entries.forEach(x => done.add(x.slotId)); });
          if (fromRoutine && fromRoutine.slots.every(sl => done.has(sl.id))) delete origin.partial;
          touched.push(it.fromRoutine.name);
        });
        db.transfers = allTransfers().filter(t => t.slotIds.length);
        return [...new Set(touched)];
      };

      if (!ownEntries.length) {
        // Solo se hicieron los trasladados: no hay sesión nueva que crear.
        const names = applyMoved();
        saveDB();
        clearSessionDraft(routineId);
        showToast(names.length ? `Guardado en ${names.join(' y ')}` : 'Sesión guardada');
        navigate('');
        if (getGhToken()) setTimeout(() => pushBackupToGitHub(true), 2000);
        return;
      }

      const doneIds = draft.doneFrom ? draft.doneFrom.slotIds : [];
      const savedIds = new Set(ownEntries.map(e => e.slotId));
      const missingCount = routine.slots.filter(sl => !doneIds.includes(sl.id) && !savedIds.has(sl.id)).length;
      openDurationPrompt(missingCount, (durationSec, partial, deload) => {
        const session = {
          id: uid(),
          routineId,
          date: new Date().toISOString(),
          durationSec,
          gym: canonicalGym(draft.gym || ''),
          entries: ownEntries
        };
        applyMoved();
        if (partial) session.partial = true;
        if (deload) session.deload = true;
        if (draft.notes) session.notes = draft.notes;
        if (draft.continuesSessionId) session.continuesSessionId = draft.continuesSessionId;
        db.sessions.push(session);
        saveDB();
        clearSessionDraft(routineId);
        showToast('Sesión guardada');
        navigate('');
        if (getGhToken()) setTimeout(() => pushBackupToGitHub(true), 2000);
        // Lo que falta: ¿se traslada a otra rutina o se deja para continuar?
        if (partial && missingSlotsOf(session).length && db.routines.length > 1) {
          setTimeout(() => openTransferDialog(session, renderHome), 400);
        }
      });
    });
  }

  paint();
  pinRestBarToViewport();
  if (restoredDraft) setTimeout(restoreScroll, 0);
  // Sesión nueva, o continuación de una parcial (puede ser en otro gimnasio).
  if (!restoredDraft || draft.askGym) {
    delete draft.askGym;
    openGymPrompt(restoredDraft ? `Sigues en ${draft.gym || 'el mismo gimnasio'}, ¿o cambias?` : '');
  }
}
