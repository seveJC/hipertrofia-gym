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

  if (changed) saveDB();
}

function gymOptionsHtml(selected) {
  const gyms = db.gyms || [];
  return [
    `<option value="">— Sin gimnasio —</option>`,
    ...gyms.map(g => `<option value="${escapeHtml(g)}"${g === selected ? ' selected' : ''}>${escapeHtml(g)}</option>`),
    `<option value="__new__">➕ Añadir gimnasio…</option>`,
  ].join('');
}

// Un <select> de gimnasios con la opción de dar de alta uno nuevo. onChange
// recibe el nombre elegido (ya guardado en db.gyms si es nuevo).
function bindGymSelect(select, onChange) {
  select.addEventListener('change', () => {
    if (select.value !== '__new__') { onChange(select.value); return; }
    const name = (prompt('Nombre del gimnasio') || '').trim();
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
  let totalExercises = 0;
  parts.forEach(s => {
    const totalSets = s.entries.reduce((sum, e) => sum + e.sets.length, 0) || 1;
    totalExercises += s.entries.length;
    s.entries.forEach(e => {
      // Una superserie = un grupo con al menos 2 ejercicios enlazados ese día.
      if (e.supersetGroup) {
        const k = s.id + ':' + e.supersetGroup;
        groupSizes[k] = (groupSizes[k] || 0) + 1;
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
  const plannedMuscles = [...new Set(routine.slots.flatMap(sl => {
    const ex = getExercise(sl.exerciseId);
    return muscleNames(ex && ex.muscle);
  }))];
  const missingMuscles = partial ? plannedMuscles.filter(m => !muscleStats[m]) : [];
  return {
    date: last.date,
    dates: parts.map(p => p.date),
    gym: last.gym,
    totalExercises,
    durations: parts.map(p => p.durationSec),
    durationSec: hasDuration ? parts.reduce((n, p) => n + p.durationSec, 0) : null,
    hasDuration,
    supersets: Object.values(groupSizes).filter(n => n >= 2).length,
    partial,
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
  document.getElementById('choice-view').addEventListener('click', () => { close(); navigate(`history/${routineId}`); });
  document.getElementById('choice-progress').addEventListener('click', () => { close(); navigate(`progress/${routineId}`); });
  document.getElementById('choice-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

// ---------- Home: lista de rutinas ----------
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
        day.dates.map(fmtDateShort).join(' + '),
        `${day.totalExercises} ej`,
        day.hasDuration ? day.durations.map(fmtMinutesShort).join('+') : null,
        day.supersets ? `🔗${day.supersets}` : null,
        day.partial ? '⏸ parcial' : null,
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
      <button class="btn btn-icon" data-nav="history" title="Historial de sesiones">📅</button>
      <button class="btn btn-icon" data-nav="exercises" title="Ejercicios">🏋️</button>
    </div>
    <div class="backup-banner" id="backup-banner"${getGhToken() && isBackupPending() ? '' : ' hidden'}>
      ☁️ Hay cambios sin copiar a GitHub · <span class="backup-retry" id="backup-retry-btn">subir ahora</span>
    </div>
    <div class="container">
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
          <label class="slot-rest" title="Descanso objetivo">⏱ <input type="number" inputmode="numeric" data-slot-rest="${idx}" value="${slot.restSec ?? ''}" placeholder="s" />s</label>
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
      const n = Number(el.value);
      draft.slots[Number(el.dataset.slotRest)].restSec = n > 0 ? n : null;
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
  let main = s.reps2 != null && s.reps2 !== ''
    ? `${w}×${s.reps}+${s.reps2}`
    : `${w}×${s.reps ?? '?'}`;
  const sub = [];
  if (s.dropset) sub.push('DROP');
  if (s.restPause) sub.push('RP');
  if (s.rir !== null && s.rir !== undefined && s.rir !== '') sub.push(`RIR${s.rir}`);
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

// Por sesión: peso de trabajo (el más repetido), repes mínimas a ese peso,
// RIR medio y mejor 1RM estimado.
function slotProgressPoints(routine, slot) {
  return db.sessions
    .filter(ses => ses.routineId === routine.id)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(ses => {
      const e = ses.entries.find(x => x.slotId === slot.id);
      if (!e) return null;
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

// Doble progresión: se sube peso cuando se llega al tope del rango de repes
// (o sobran repes según el RIR); se baja si las repes caen dos veces.
function recommendForSlot(routine, slot, pts) {
  const ex = getExercise(slot.exerciseId);
  const lower = muscleNames(ex && ex.muscle).some(m => LOWER_BODY.includes(m));
  const step = lower ? 5 : 2.5;
  const fuerza = /fuerza/i.test(routine.name);
  const [lo, hi] = fuerza ? [4, 6] : [8, 12];
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

function renderProgress(routineId) {
  const routine = getRoutine(routineId);
  if (!routine) { navigate(''); return; }

  const blocks = routine.slots.map((slot, idx) => {
    const ex = getExercise(slot.exerciseId);
    const pts = slotProgressPoints(routine, slot);
    const rec = recommendForSlot(routine, slot, pts);
    const last = pts[pts.length - 1];
    const main = idx < 3;
    const icon = { up: '⬆️', keep: '➡️', down: '⬇️', info: 'ℹ️' }[rec.level];
    const lastTxt = last ? `Última: ${fmtDateShort(last.date)} · ${last.sets.map(st => `${st.w}×${st.r}`).join(' · ')}${last.avgRir != null ? ` · RIR ${last.avgRir.toFixed(1)}` : ''}` : '';
    const body = `
      <div class="progress-rec progress-${rec.level}">${icon} ${escapeHtml(rec.text)}</div>
      ${lastTxt ? `<div class="progress-last">${escapeHtml(lastTxt)}</div>` : ''}
      ${main ? progressChartSvg(pts) : ''}
      ${pts.length >= 2 ? `<div class="progress-stats">1RM est.: ${Math.round(pts[pts.length - 2].best)} → <b>${Math.round(last.best)} kg</b> · volumen: ${Math.round(pts[pts.length - 2].volume)} → <b>${Math.round(last.volume)} kg</b></div>` : ''}`;
    return `
      <div class="card progress-card${main ? '' : ' progress-minor'}">
        <div class="progress-head">
          <div class="name">${idx + 1}. ${ex ? escapeHtml(ex.name) : '(ejercicio eliminado)'}</div>
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
      <div class="progress-intro">Rango objetivo: <b>${fuerza ? '4–6' : '8–12'} repes</b> (por el nombre de la rutina). Los tres primeros ejercicios llevan gráfica; el resto, plegados.</div>
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
        return `
        <div class="set-row">
          <div class="set-num">${sIdx + 1}</div>
          <input type="text" inputmode="decimal" placeholder="kg" data-hw="${eIdx}:${sIdx}" value="${escapeHtml(set.weight ?? '')}" />
          <input type="text" inputmode="decimal" placeholder="${set.reps2 != null ? 'der' : 'reps'}" data-hr="${eIdx}:${sIdx}" value="${escapeHtml(set.reps ?? '')}" />
          ${set.reps2 != null
            ? `<input type="text" inputmode="decimal" placeholder="izq" data-hr2="${eIdx}:${sIdx}" value="${escapeHtml(set.reps2)}" />`
            : `<input type="text" inputmode="decimal" placeholder="RIR" data-hrir="${eIdx}:${sIdx}" value="${escapeHtml(set.rir ?? '')}" />`}
          <button class="rm" data-hrm="${eIdx}:${sIdx}">✕</button>
        </div>
        ${tags ? `<div class="rest-tag">${tags}</div>` : ''}`;
      }).join('');

      return `
        <div class="exercise-block" style="${muscleBackgroundStyle(ex && ex.muscle)}">
          ${ex && ex.muscle ? muscleBadgeHtml(ex.muscle) : ''}
          <div class="exercise-head">
            <div>
              <h3>${eIdx + 1}. ${escapeHtml(ex ? ex.name : '(ejercicio eliminado)')}</h3>
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

  function pastSessionsForSlot(slotId, limit) {
    return db.sessions
      .filter(s => s.routineId === routineId && s.entries.some(e => e.slotId === slotId))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map(s => ({ session: s, entry: s.entries.find(e => e.slotId === slotId) }));
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
    draft.entries[slot.id] = { exerciseId: slot.exerciseId, sets: [], uni: defaultUni, _historyLimit: 3 };
  });

  // draft.supersets[slotId] = idGrupo | null. La rutina guarda el plan habitual;
  // esto guarda lo que haces HOY, para que improvisar (o saltarte) una
  // superserie no reescriba la rutina. null = hoy suelto a propósito, por eso se
  // guarda la clave en vez de borrarla: si no, al repintar volvería el plan.
  if (!draft.supersets) draft.supersets = {};
  routine.slots.forEach(slot => {
    if (!(slot.id in draft.supersets)) draft.supersets[slot.id] = slot.supersetGroup || null;
  });

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
        ${missingCount ? `
        <p style="color:var(--text-dim);font-size:13px;margin:4px 0 2px;">Quedan ${missingCount} ejercicio${missingCount === 1 ? '' : 's'} sin series. ¿La sesión es…?</p>
        <label class="choice-row"><input type="radio" name="session-scope" value="partial" checked /> ⏸ Parcial — el resto otro día</label>
        <label class="choice-row"><input type="radio" name="session-scope" value="full" /> ✅ Completa — los salté a propósito</label>
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
      const scope = backdrop.querySelector('input[name="session-scope"]:checked');
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
      document.body.removeChild(backdrop);
      onDone(Math.round(min * 60), !!scope && scope.value === 'partial');
    };
    document.getElementById('duration-ok').addEventListener('click', confirmDuration);
    document.getElementById('duration-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmDuration(); });
  }

  function openGymPrompt() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>📍 ¿En qué gimnasio entrenas hoy?</h2>
        <div class="field">
          <select id="gym-prompt-select">${gymOptionsHtml(draft.gym || '')}</select>
        </div>
        <button class="btn btn-primary btn-block" id="gym-prompt-ok">Continuar</button>
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
  }

  // Objetivo de descanso del ejercicio: vive en la rutina y se cambia sin
  // bloquear nada. Vacío = sin objetivo (no pita).
  function openRestTargetEditor(slotId) {
    const slot = routine.slots.find(sl => sl.id === slotId);
    if (!slot) return;
    const ex = getExercise(draft.entries[slotId].exerciseId);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <h2>🎯 Descanso objetivo</h2>
        <p style="color:var(--text-dim);font-size:13px;margin-top:-8px;">${escapeHtml(ex ? ex.name : '')} — en segundos. Se guarda en la rutina.</p>
        <div class="field">
          <input id="rest-target-input" type="number" inputmode="numeric" placeholder="Ej. 90" value="${slot.restSec ?? ''}" />
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
      const n = Number(input.value);
      slot.restSec = n > 0 ? n : null;
      saveDB();
      document.body.removeChild(backdrop);
      paint();
    };
    document.getElementById('rest-target-ok').addEventListener('click', finish);
    document.getElementById('rest-target-cancel').addEventListener('click', () => document.body.removeChild(backdrop));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
  }

  function restTargetOf(slotId) {
    const slot = routine.slots.find(sl => sl.id === slotId);
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

  function paint() {
    saveDraft();
    const doneSlotIds = draft.doneFrom ? draft.doneFrom.slotIds : [];
    const blocks = routine.slots.map((slot, idx) => {
      const plannedEx = getExercise(slot.exerciseId);
      const entry = draft.entries[slot.id];
      const currentEx = getExercise(entry.exerciseId);
      const isSub = entry.exerciseId !== slot.exerciseId;

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
            ${historyThresholds(totalHistoryCount).map(n => `<option value="${n}" ${entry._historyLimit === n ? 'selected' : ''}>${n === totalHistoryCount ? `Todas (${n})` : n}</option>`).join('')}
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
              ${history.map(({ session, entry: e }) => {
                const exUsed = getExercise(e.exerciseId);
                const wasSub = e.exerciseId !== slot.exerciseId;
                const cells = Array.from({ length: maxSets }, (_, i) => e.sets[i] ? `<td>${formatSetCell(e.sets[i])}</td>` : '<td>—</td>').join('');
                return `<tr>
                  <td class="date-cell">${fmtDate(session.date)}${session.gym ? `<div class="gym-tag-sm">📍 ${escapeHtml(session.gym)}</div>` : ''}${wasSub ? `<div class="sub-note-sm" title="Sustituye a ${escapeHtml(exUsed ? exUsed.name : '?')}">🔄 ${escapeHtml(exUsed ? exUsed.name : '?')}</div>` : ''}${e.restNote ? `<div class="rest-note">desc. obj: ${escapeHtml(e.restNote)}s</div>` : ''}</td>
                  ${cells}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="history-empty">Sin sesiones anteriores para este ejercicio.</div>';

      const target = restTargetOf(slot.id);
      const targetTag = `<button class="btn-ghost rest-target-tag" data-edit-rest="${slot.id}">🎯 ${target ? `${target}s` : 'sin objetivo'}</button>`;

      const setsHtml = entry.sets.map((set, sIdx) => {
        const showGap = !(idx === 0 && sIdx === 0);
        return `
        ${showGap ? `
          <div class="rest-gap">
            ⏱ <input type="number" inputmode="numeric" class="rest-gap-input" data-restsec="${slot.id}:${sIdx}" value="${set.restSec ?? ''}" placeholder="—" /> s descanso
          </div>
        ` : ''}
        <div class="set-row">
          <div class="set-num">${sIdx + 1}</div>
          <input type="text" inputmode="decimal" placeholder="kg" data-weight="${slot.id}:${sIdx}" value="${set.weight ?? ''}" />
          <input type="text" inputmode="decimal" placeholder="${entry.uni ? 'der' : 'reps'}" data-reps="${slot.id}:${sIdx}" value="${set.reps ?? ''}" />
          ${entry.uni
            ? `<input type="text" inputmode="decimal" placeholder="izq" data-reps2="${slot.id}:${sIdx}" value="${set.reps2 ?? ''}" />`
            : `<input type="text" inputmode="decimal" placeholder="RIR" data-rir="${slot.id}:${sIdx}" value="${set.rir ?? ''}" />`}
          <button class="rm" data-rm-set="${slot.id}:${sIdx}">✕</button>
        </div>
        ${(set.stages || []).map((st, stIdx) => `
          <div class="set-row set-row-sub">
            <div class="set-num">${set.technique === 'dropset' ? 'D' + (stIdx + 1) : 'P' + (stIdx + 1)}</div>
            ${set.technique === 'dropset'
              ? `<input type="text" inputmode="decimal" placeholder="kg" data-stage-weight="${slot.id}:${sIdx}:${stIdx}" value="${st.weight ?? ''}" />`
              : `<div></div>`}
            <input type="text" inputmode="decimal" placeholder="reps" data-stage-reps="${slot.id}:${sIdx}:${stIdx}" value="${st.reps ?? ''}" />
            <div></div>
            <button class="rm" data-rm-stage="${slot.id}:${sIdx}:${stIdx}">✕</button>
          </div>
        `).join('')}
        <div class="technique-actions">
          ${!set.technique
            ? `<span class="technique-link" data-add-technique="${slot.id}:${sIdx}:dropset">+ Drop set</span><span class="technique-link" data-add-technique="${slot.id}:${sIdx}:restpause">+ Rest-pause</span>`
            : `<span class="technique-link" data-add-stage="${slot.id}:${sIdx}">+ ${set.technique === 'dropset' ? 'Otra caída' : 'Otra pausa'}</span>`}
        </div>
      `;
      }).join('');
      const labelsHtml = entry.sets.length ? `
        <div class="set-labels"><span></span><span>Kg</span><span>${entry.uni ? 'Der' : 'Reps'}</span><span>${entry.uni ? 'Izq' : 'RIR'}</span><span></span></div>
      ` : '';
      const uniToggle = `<button class="btn-ghost uni-toggle" data-toggle-uni="${slot.id}">${entry.uni ? '🔀 Unilateral' : '↔ Bilateral'}</button>`;

      return `
        <div class="exercise-block" style="${muscleBackgroundStyle(currentEx && currentEx.muscle)}">
          ${currentEx && currentEx.muscle ? muscleBadgeHtml(currentEx.muscle) : ''}
          <div class="exercise-head">
            <div>
              <h3>${idx + 1}. ${escapeHtml(currentEx ? currentEx.name : '(ejercicio eliminado)')}</h3>
              ${currentEx && currentEx.notes ? `<div class="notes-line" data-edit-ex-notes="${currentEx.id}">✎ ${escapeHtml(currentEx.notes)}</div>` : currentEx ? `<div class="notes-line notes-line-empty" data-edit-ex-notes="${currentEx.id}">+ añadir observación</div>` : ''}
              ${isSub ? `<div class="sub-note">🔄 Sustituye a: ${escapeHtml(plannedEx ? plannedEx.name : '?')}</div>` : ''}
              ${supersetNoteHtml(slot)}
            </div>
            <button class="btn btn-ghost" data-swap="${slot.id}" style="font-size:13px;white-space:nowrap;">Sustituir</button>
          </div>
          <div class="history">${historyHtml}${historyMoreHtml}</div>
          <div class="rest-widget">${targetTag}${uniToggle}</div>
          <div class="log-area">
            ${labelsHtml}
            ${setsHtml}
            <div class="log-actions">
              <button class="btn" data-add-set="${slot.id}">+ Serie (inicia crono)</button>
              ${isSub ? `<button class="btn" data-revert="${slot.id}">Deshacer sustitución</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

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
    restBar.innerHTML = restState === 'running' ? `
        <span class="rest-live" id="rest-live">⏱ 0:00</span>
        <span class="rest-bar-info" id="rest-bar-info"></span>
        <button class="btn rest-bar-btn" id="rest-stop">⏹ Parar</button>` :
      restState === 'stopped' ? `
        <span class="rest-live rest-done">✔ ${mmss(draft.restPendingSec)}</span>
        <span class="rest-bar-info">descanso hecho · se guarda en la próxima serie</span>
        <button class="btn-ghost rest-bar-cancel" id="rest-cancel" title="Descartar">✕</button>` : `
        <span class="rest-live rest-idle">⏱ —</span>
        <span class="rest-bar-info">pulsa «+ Serie» al acabar la serie</span>`;
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
    app.querySelectorAll('[data-add-set]').forEach(el => el.addEventListener('click', () => {
      const slotId = el.dataset.addSet;
      const entry = draft.entries[slotId];
      const now = Date.now();
      const restSec = draft.restPendingSec != null
        ? draft.restPendingSec
        : draft.restStart != null ? Math.round((now - draft.restStart) / 1000) : null;
      draft.restPendingSec = null;
      const lastSet = entry.sets[entry.sets.length - 1];
      const defaultWeight = lastSet && lastSet.weight !== '' && lastSet.weight != null ? lastSet.weight : '';
      entry.sets.push({ weight: defaultWeight, reps: '', rir: '', restSec });
      unlockAudio();
      draft.restStart = now;
      draft.restSlotId = slotId;
      draft.restAlerted = false;
      markActivity();
      paint();
    }));

    app.querySelectorAll('[data-edit-rest]').forEach(el => el.addEventListener('click', () => {
      openRestTargetEditor(el.dataset.editRest);
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

    app.querySelectorAll('[data-weight]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.weight.split(':');
      draft.entries[slotId].sets[Number(sIdx)].weight = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
    }));
    app.querySelectorAll('[data-reps]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.reps.split(':');
      draft.entries[slotId].sets[Number(sIdx)].reps = normalizeDecimal(el.value);
      markActivity();
      saveDraft();
    }));
    app.querySelectorAll('[data-rir]').forEach(el => el.addEventListener('input', () => {
      const [slotId, sIdx] = el.dataset.rir.split(':');
      draft.entries[slotId].sets[Number(sIdx)].rir = normalizeDecimal(el.value);
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
      const v = normalizeDecimal(el.value);
      draft.entries[slotId].sets[Number(sIdx)].restSec = v === '' ? null : Number(v);
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
                  reps2: s.reps2 !== '' && s.reps2 != null ? Number(s.reps2) : null,
                  restSec: s.restSec ?? null
                };
                const stages = (s.stages || []).filter(st => (st.reps !== '' && st.reps != null) || (st.weight !== '' && st.weight != null));
                if (s.technique === 'dropset' && stages.length) {
                  out.weight = [s.weight, ...stages.map(st => st.weight)].filter(w => w !== '' && w != null).join('/');
                  out.reps = [s.reps, ...stages.map(st => st.reps)].filter(r => r !== '' && r != null).join('/');
                  out.dropset = true;
                } else if (s.technique === 'restpause' && stages.length) {
                  out.reps = [s.reps, ...stages.map(st => st.reps)].filter(r => r !== '' && r != null).join('+');
                  out.restPause = true;
                }
                return out;
              })
          };
          const restTarget = restTargetOf(slotId);
          if (restTarget) entryOut.restNote = String(restTarget);
          // Lo de hoy, no el plan de la rutina: así una sesión guardada conserva
          // si ese día concreto la hiciste enlazada o suelta.
          if (draft.supersets[slotId]) entryOut.supersetGroup = draft.supersets[slotId];
          return entryOut;
        });

      if (!entries.length) {
        showToast('Registra al menos una serie antes de guardar');
        return;
      }

      const doneIds = draft.doneFrom ? draft.doneFrom.slotIds : [];
      const savedIds = new Set(entries.map(e => e.slotId));
      const missingCount = routine.slots.filter(sl => !doneIds.includes(sl.id) && !savedIds.has(sl.id)).length;
      openDurationPrompt(missingCount, (durationSec, partial) => {
        const session = {
          id: uid(),
          routineId,
          date: new Date().toISOString(),
          durationSec,
          gym: draft.gym || '',
          entries
        };
        if (partial) session.partial = true;
        if (draft.notes) session.notes = draft.notes;
        if (draft.continuesSessionId) session.continuesSessionId = draft.continuesSessionId;
        db.sessions.push(session);
        saveDB();
        clearSessionDraft(routineId);
        showToast('Sesión guardada');
        navigate('');
        if (getGhToken()) setTimeout(() => pushBackupToGitHub(true), 2000);
      });
    });
  }

  paint();
  pinRestBarToViewport();
  if (restoredDraft) setTimeout(restoreScroll, 0);
  if (!restoredDraft) openGymPrompt();
}
