/*
 * NuTracker — servidor
 * Sin dependencias: solo Node >= 18.
 *  - Sirve la app web (public/) para PC y celular
 *  - Guarda perfiles y registros → sincronización entre dispositivos
 *  - Proxy a la IA (Anthropic u OpenAI según la key; nunca llega al navegador)
 *
 * Variables de entorno (todas opcionales; pensadas para hosting tipo Render):
 *  PORT                      puerto (default 3210)
 *  DATA_DIR                  carpeta de data.json (default: junto a este archivo)
 *  NT_PIN                    si está definido, /api/* exige este PIN (header x-nt-pin)
 *  UPSTASH_REDIS_REST_URL    si están ambas, los datos van a Upstash en vez del
 *  UPSTASH_REDIS_REST_TOKEN  disco (obligatorio en Render: su disco se borra)
 *  ANTHROPIC_API_KEY / OPENAI_API_KEY   key de IA si no se configura desde la app
 *  GARMIN_API_KEY            clave API personal de Garmin Connect (panel Garmin de Nico)
 */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const garmin = require("./garmin");
const coach = require("./coach");
const weather = require("./weather");

const PORT = process.env.PORT || 3210;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_FILE = path.join(process.env.DATA_DIR || ROOT, "data.json");
const PIN = (process.env.NT_PIN || "").trim();
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_UPSTASH = !!(UP_URL && UP_TOKEN);

/* ================= estado persistente ================= */
function freshProfile(name) {
  return { name, log: {}, settings: { goal: 2000, gprot: null, gcarb: null } };
}
let state = { v: 2, key: "", coach: {}, profiles: { p1: freshProfile("Nico"), p2: freshProfile("Chris"), p3: freshProfile("Mamá") } };

async function loadState() {
  if (USE_UPSTASH) {
    const r = await fetch(UP_URL + "/get/nutracker", { headers: { Authorization: "Bearer " + UP_TOKEN } });
    if (!r.ok) throw new Error("Upstash respondió " + r.status);
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return null; }
}

/* quita miniaturas de fotos de hace >30 días: mantiene liviano el estado
 * (límite de 1 MB por request en Upstash gratis) */
function pruneOldImages() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  Object.values(state.profiles).forEach(pr =>
    Object.keys(pr.log).forEach(d => { if (d < cutoff) pr.log[d].forEach(e => delete e.img); })
  );
}

/* revisión del estado: cambia con cada modificación. Los sync periódicos que
 * no traen operaciones y ya tienen esta revisión reciben un "sin cambios"
 * diminuto en vez de todo el estado (que incluye las miniaturas de las fotos). */
const BOOT = Date.now().toString(36);
let revN = 0;
const rev = () => BOOT + "-" + revN;

let saveTimer = null;
function persist() {
  revN++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    pruneOldImages();
    const body = JSON.stringify(state);
    if (USE_UPSTASH) {
      fetch(UP_URL + "/set/nutracker", {
        method: "POST", headers: { Authorization: "Bearer " + UP_TOKEN }, body
      }).then(r => { if (!r.ok) console.error("⚠️ Upstash error " + r.status); })
        .catch(e => console.error("⚠️ Upstash error: " + e.message));
    } else {
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, DATA_FILE);
    }
  }, 150);
}

/* ================= operaciones de sync ================= */
function applyOp(op) {
  if (!op || typeof op !== "object") return;
  const prof = state.profiles[op.pid];

  if (op.t === "add" && prof && op.date && op.entry && op.entry.id != null) {
    const arr = (prof.log[op.date] = prof.log[op.date] || []);
    if (!arr.some(e => e.id === op.entry.id)) arr.push(op.entry);
  } else if (op.t === "del" && prof && op.date && op.id != null) {
    if (prof.log[op.date]) {
      prof.log[op.date] = prof.log[op.date].filter(e => e.id !== op.id);
      if (!prof.log[op.date].length) delete prof.log[op.date];
    }
  } else if (op.t === "set" && prof && op.settings && typeof op.settings === "object") {
    const s = op.settings;
    if (s.goal != null) prof.settings.goal = Number(s.goal) || 2000;
    if ("gprot" in s) prof.settings.gprot = s.gprot === null ? null : Number(s.gprot) || null;
    if ("gcarb" in s) prof.settings.gcarb = s.gcarb === null ? null : Number(s.gcarb) || null;
    if ("gadj" in s) prof.settings.gadj = !!s.gadj;
  } else if (op.t === "journal" && prof && /^\d{4}-\d{2}-\d{2}$/.test(op.date || "") && coach.TAGS.some(t => t.key === op.key)) {
    // diario de hábitos (café, alcohol…): se cruza con la recuperación del día siguiente
    const j = (prof.journal = prof.journal || {});
    const day = (j[op.date] = j[op.date] || {});
    if (op.on) day[op.key] = true; else delete day[op.key];
    Object.keys(j).sort().slice(0, -120).forEach(d => delete j[d]);
  } else if (op.t === "prefs" && prof && op.prefs && typeof op.prefs === "object") {
    prof.prefs = cleanPrefs(op.prefs);
  } else if (op.t === "rpe" && prof && op.id != null && String(op.id).length <= 24) {
    // qué tan dura fue una sesión de pesas (1-10): ajusta su carga muscular estimada
    const r = (prof.rpe = prof.rpe || {}), v = Math.round(Number(op.v));
    if (v >= 1 && v <= 10) r[op.id] = v; else delete r[op.id];
    Object.keys(r).slice(0, -200).forEach(k => delete r[k]);
  } else if (op.t === "rename" && prof && typeof op.name === "string" && op.name.trim()) {
    prof.name = op.name.trim().slice(0, 20);
  } else if (op.t === "key" && typeof op.key === "string" && op.key.trim()) {
    state.key = op.key.trim();
  } else if (op.t === "check" && op.date && op.key && state.coach[op.date]) {
    // marcas interactivas del briefing (ejercicio hecho, horario cumplido, comida del plan)
    const ch = (state.coach[op.date].checks = state.coach[op.date].checks || {});
    if (op.done) ch[op.key] = true; else delete ch[op.key];
  }
}

/* gustos de comida por perfil: favoritos por momento del día + notas libres + enfoque a seguir */
const MOMENTOS = ["desayuno", "almuerzo", "once", "cena", "snack"];
function cleanPrefs(p) {
  const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
  const fav = {};
  MOMENTOS.forEach(m => {
    const arr = Array.isArray(p.fav && p.fav[m]) ? p.fav[m] : [];
    const seen = new Set();
    fav[m] = arr.map(x => str(x, 60)).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 15);
  });
  return { fav, notes: str(p.notes, 600), approach: str(p.approach, 1500) };
}
/* qué suele comer en cada momento del día según su propio registro (últimos 45 días) */
const momentoDe = h => h == null ? null : h < 11 ? "desayuno" : h < 16 ? "almuerzo" : h < 20 ? "once" : "cena";
function habitual(prof) {
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10), by = {};
  Object.keys(prof.log || {}).filter(d => d >= cutoff).forEach(d => (prof.log[d] || []).forEach(e => {
    const m = momentoDe(coach.parseTime(e.time)), k = String(e.name || "").trim();
    if (!m || !k) return;
    const b = (by[m] = by[m] || {}), key = k.toLowerCase();
    b[key] = b[key] || { name: k.slice(0, 50), n: 0 };
    b[key].n++;
  }));
  const out = {};
  Object.keys(by).forEach(m => {
    out[m] = Object.values(by[m]).filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 5).map(x => x.name + " ×" + x.n);
  });
  return out;
}

function aiKey() {
  return (state.key || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

function publicState() {
  return {
    profiles: state.profiles,
    coach: state.coach,
    hasKey: !!aiKey(),
    hasGarmin: garmin.enabled(),
    rev: rev()
  };
}

/* lo que Nico lleva comido en una fecha + sus metas (tarjeta "Comida" del panel Garmin) */
function dayFood(date) {
  const pr = state.profiles.p1 || freshProfile("Nico");
  const n = coach.dayNutrition(pr.log[date]);
  const c = state.coach[date] && state.coach[date].nutricion;
  const r = v => Math.round(v || 0);
  return {
    kcal: n ? r(n.kcal) : 0, prot: n ? r(n.prot) : 0, carb: n ? r(n.carb) : 0, fat: n ? r(n.fat) : 0, n: n ? n.n : 0,
    goal: (c && c.objetivo) || Number(pr.settings.goal) || 2000,
    gprot: (c && c.proteina_g) || pr.settings.gprot || null
  };
}

/* Briefing diario del Garmin Coach: guarda el briefing completo (menos
 * `estado`, que es interno del script) para el perfil p1. La tarjeta usa el
 * resumen; el modal "briefing completo" muestra todo. */
function saveCoach(b) {
  if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha || "")) return false;
  const n = b.nutricion || {};
  state.coach[b.fecha] = {
    nivel: b.nivel || null,
    score: b.score != null ? Number(b.score) : null,
    frase: b.score_frase || null,
    nota_hrv: b.nota_hrv || null,
    alerta: b.alerta || null,
    fecha_legible: b.fecha_legible || null,
    metricas: Array.isArray(b.metricas) ? b.metricas : null,
    sueno: b.sueno || null,
    clima: b.clima || null,
    workout: b.workout || null,
    horarios: b.horarios || null,
    tenis: b.tenis ? { veredicto: b.tenis.veredicto, color: b.tenis.color } : null,
    insights: Array.isArray(b.insights) ? b.insights : null,
    ultima_actividad: b.ultima_actividad || null,
    nutricion: {
      objetivo: n.objetivo != null ? Number(n.objetivo) : null,
      proteina_g: n.proteina_g != null ? Number(n.proteina_g) : null,
      carbos_g: n.carbos_g != null ? Number(n.carbos_g) : null,
      grasas_g: n.grasas_g != null ? Number(n.grasas_g) : null,
      comidas: Array.isArray(n.comidas) ? n.comidas : [],
      cafeina: n.cafeina || null,
      hidratacion: n.hidratacion || null
    }
  };
  // conservar solo los últimos 14 días
  Object.keys(state.coach).sort().slice(0, -14).forEach(d => delete state.coach[d]);
  persist();
  return true;
}

/* ================= proxy IA (Anthropic u OpenAI según la key) ================= */
const PROMPT = `Eres un nutricionista experto. Analiza la foto de este plato de comida y estima calorías y macronutrientes.

Responde SOLO con JSON válido, sin texto adicional ni markdown, con esta estructura exacta:
{
  "plato": "nombre corto del plato",
  "items": [
    {"nombre": "alimento", "porcion": "estimación en g o unidades", "kcal": 0, "prot": 0, "carb": 0, "grasa": 0}
  ],
  "total": {"kcal": 0, "prot": 0, "carb": 0, "grasa": 0},
  "confianza": "alta|media|baja",
  "nota": "observación breve sobre la estimación"
}

Reglas: estima porciones por el tamaño visual del plato y objetos de referencia. Los macros en gramos. Si la imagen no muestra comida, responde {"error": "descripción breve"}.`;

/* req = { prompt, image?, mediaType?, maxTokens? } — image es base64 (opcional) */
function askAI(req, cb) {
  const key = aiKey();
  if (!key) return cb({ status: 400, error: "Falta la API key de IA. Configúrala en ⚙️ Ajustes (sirve para todos los dispositivos)." });
  const isGoogle = key.startsWith("AIza") || key.startsWith("AQ.");
  if (req.audio && !isGoogle) return cb({ status: 400, error: "La transcripción de voz necesita una API key de Google Gemini (gratis)." });
  if (key.startsWith("sk-ant-")) return callAnthropic(key, req, cb);
  // Google: formato clásico "AIza…" o el nuevo "AQ.…"
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return callGemini(key, req, cb);
  return callOpenAI(key, req, cb);
}

function apiRequest(opts, body, extractText, cb, timeoutMs) {
  const req = https.request(opts, resp => {
    let data = "";
    resp.on("data", c => data += c);
    resp.on("end", () => {
      if (resp.statusCode !== 200) {
        let msg = "Error " + resp.statusCode;
        try { const j = JSON.parse(data); msg += ": " + ((j.error && j.error.message) || ""); } catch (e) {}
        if (resp.statusCode === 401) msg = "API key inválida. Revísala en ⚙️ Ajustes.";
        return cb({ status: 502, error: msg });
      }
      try { cb(null, { text: extractText(JSON.parse(data)) }); }
      catch (e) { cb({ status: 502, error: "Respuesta inesperada de la IA." }); }
    });
  });
  req.on("error", e => cb({ status: 502, error: "No se pudo contactar a la API: " + e.message }));
  req.setTimeout(timeoutMs || 60000, () => { req.destroy(); cb({ status: 504, error: "La IA tardó demasiado. Intenta de nuevo." }); });
  req.write(body);
  req.end();
}

function callAnthropic(key, r, cb) {
  const content = [];
  if (r.image) content.push({ type: "image", source: { type: "base64", media_type: r.mediaType || "image/jpeg", data: r.image } });
  content.push({ type: "text", text: r.prompt });
  const body = JSON.stringify({ model: "claude-sonnet-5", max_tokens: r.maxTokens || 1200, messages: [{ role: "user", content }] });
  apiRequest({
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
      "x-api-key": key, "anthropic-version": "2023-06-01"
    }
  }, body, j => (j.content || []).filter(b => b.type === "text").map(b => b.text).join(""), cb);
}

function callGemini(key, r, cb, model, noThink) {
  // texto/audio sin foto ("fast"): modelo lite sin "thinking" y con timeout corto; si se
  // cuelga o está congestionado, prueba con el otro modelo (el plan gratis se satura a ratos)
  const LITE = "gemini-flash-lite-latest", FLASH = "gemini-flash-latest";
  model = model || (r.fast ? LITE : FLASH);
  const parts = [];
  if (r.image) parts.push({ inline_data: { mime_type: r.mediaType || "image/jpeg", data: r.image } });
  parts.push({ text: r.prompt });
  const gc = { maxOutputTokens: 4000 };
  if (r.fast && !noThink) gc.thinkingConfig = { thinkingBudget: 0 };
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: gc });
  r._tried = (r._tried || []).concat(model);
  apiRequest({
    hostname: "generativelanguage.googleapis.com",
    path: "/v1beta/models/" + model + ":generateContent",
    method: "POST",
    headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
      "x-goog-api-key": key
    }
  }, body, j => ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
    .map(p => p.text || "").join(""), (err, ok) => {
    if (err) {
      // algunos modelos rechazan thinkingConfig con un 400 genérico ("invalid argument"):
      // reintentar el mismo modelo sin esa opción
      if (gc.thinkingConfig && /Error 400/.test(err.error || "") && !/API key/i.test(err.error || "")) return callGemini(key, r, cb, model, true);
      // congestionado / lento / cuota: probar el otro modelo una vez
      const other = model === LITE ? FLASH : LITE;
      if ((err.status === 504 || /50[03]|429/.test(err.error || "")) && !r._tried.includes(other)) {
        return callGemini(key, r, cb, other);
      }
    }
    cb(err, ok);
  }, r.fast ? 25000 : 60000);
}

function callOpenAI(key, r, cb) {
  const content = [];
  if (r.image) content.push({ type: "image_url", image_url: { url: "data:" + (r.mediaType || "image/jpeg") + ";base64," + r.image } });
  content.push({ type: "text", text: r.prompt });
  const body = JSON.stringify({ model: "gpt-4o-mini", max_tokens: r.maxTokens || 1200, messages: [{ role: "user", content }] });
  apiRequest({
    hostname: "api.openai.com", path: "/v1/chat/completions", method: "POST",
    headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
      "authorization": "Bearer " + key
    }
  }, body, j => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "", cb);
}

/* foto (+ corrección opcional del usuario sobre un análisis previo) */
function analyze(body, cb) {
  let prompt = PROMPT;
  const hint = typeof body.hint === "string" ? body.hint.trim().slice(0, 600) : "";
  if (hint) {
    prompt += "\n\nEl usuario corrige tu análisis anterior";
    if (body.previous) prompt += " (que fue: " + JSON.stringify(body.previous).slice(0, 2500) + ")";
    prompt += ". Su corrección, que tiene prioridad sobre lo que ves en la foto: \"" + hint + "\". Devuelve el JSON completo actualizado.";
  }
  askAI({ prompt, image: body.image, mediaType: body.mediaType }, cb);
}

/* conversación: el usuario cuenta en texto libre lo que comió o le pide ideas al nutricionista */
const CHAT_PROMPT = `Eres el nutricionista personal del usuario dentro de su tracker de calorías. Haces dos cosas:
1) Registrar: el usuario te cuenta lo que comió o bebió; estimas calorías y macros y él las confirma.
2) Aconsejar: le dices qué comer ahora o qué añadir, según lo que ya comió hoy, lo que le falta, la hora y sus gustos.
Hablas en español de Chile, cercano y práctico, como un nutricionista deportivo que también cocina.

Responde SOLO con JSON válido, sin markdown, con esta estructura:
{
  "respuesta": "mensaje breve y amable (1-3 frases)",
  "comidas": [
    {"nombre": "alimento o plato", "porcion": "cantidad estimada", "kcal": 0, "prot": 0, "carb": 0, "grasa": 0}
  ],
  "sugerencias": [
    {"nombre": "idea", "porcion": "cantidad", "kcal": 0, "prot": 0, "carb": 0, "grasa": 0, "receta": "ingredientes con cantidades y 1-2 pasos (solo si se cocina)"}
  ],
  "preferencias": [
    {"momento": "desayuno|almuerzo|once|cena|snack|general", "texto": "gusto o restricción en pocas palabras"}
  ]
}

Reglas:
- "comidas" incluye SOLO lo nuevo mencionado en el ÚLTIMO mensaje del usuario (no repitas lo ya registrado hoy ni lo ya propuesto antes). Un elemento por comida/plato.
- Si el usuario corrige algo ("eran 2, no 3"), devuelve la versión corregida en "comidas".
- Si solo pregunta o conversa, deja "comidas" vacío y contesta en "respuesta".
- Si pide recomendaciones de qué comer, usa el bloque "Metas y consumo de hoy": propón 2 o 3 ideas concretas y realistas (comida chilena cotidiana, acorde a la hora del día) que calcen con las calorías restantes y prioricen el macro que más falta (sobre todo proteína). Ponlas en "sugerencias" (mismo formato que "comidas", con porción y macros) — NO en "comidas", porque aún no las ha comido — y explica en "respuesta" en 1-2 frases por qué. Si ya superó su meta, dilo con tacto y sugiere algo liviano.
- Al recomendar: parte por los FAVORITOS del momento del día actual y por lo que suele comer (bloque "Gustos"); ajusta la porción para que calce con lo que le queda y, si conviene, propón una variante (p. ej. avocado toast con huevo para sumar proteína). Completa con 1 idea nueva parecida a sus gustos. Varía: no repitas lo que ya comió hoy.
- Criterios: reparte la proteína en el día (25-40 g por comida principal), prioriza comida real, fibra y verduras; carbohidratos alrededor del entrenamiento; cerca de dormir, algo liviano.
- Si el bloque "Gustos" trae un "Enfoque que sigue", respétalo por sobre estos criterios generales.
- Si la idea se cocina (panqueques, carrot cake proteico, avocado toast…), pon en "receta" los ingredientes con cantidades y 1-2 pasos cortos. Si es algo que se compra o arma sin cocinar, deja "receta" vacío.
- Si el usuario cuenta un gusto, costumbre o restricción ("en las mañanas me gusta…", "no como cerdo", "me encanta el carrot cake"), agrégalo en "preferencias" para que él decida si guardarlo. No repitas lo que ya está en sus gustos.
- Si no da cantidades usa porciones típicas chilenas y dilo en la respuesta. Macros en gramos.
- No eres médico: ante síntomas, embarazo o enfermedades, sugiere ver a un profesional.`;

/* ---------- coach y resumen semanal (solo perfil p1 = Nico) ---------- */
const COACH_PROMPT = `Eres el coach personal de entrenamiento, sueño y nutrición de Nico. Respondes en español, de forma cercana y concreta (máximo 130 palabras, sin relleno).
Usa SOLO los datos de abajo; si falta un dato, dilo en vez de inventarlo. Cuando hables de comida da cantidades (kcal y macros en g). No eres médico: ante dolor o síntomas raros, sugiere consultar a un profesional.`;

function todayCL() { return new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10); }
function validDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : todayCL(); }

function coachAsk(body, cb) {
  if (!garmin.enabled()) return cb({ status: 400, error: "Falta GARMIN_API_KEY en el servidor." });
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-8);
  if (!msgs.length) return cb({ status: 400, error: "Falta la pregunta." });
  const date = validDate(body.date), prof = state.profiles.p1;
  Promise.all([garmin.getDay(date), weather.summaryText()]).then(([g, wx]) => {
    const ex = coach.analyze(g, prof);
    const transcript = msgs.map(m => (m.role === "user" ? "Nico: " : "Coach: ") + String(m.text || "").slice(0, 600)).join("\n");
    const prompt = COACH_PROMPT + "\n\n" + coach.contextText(g, prof, ex) + (wx && date === todayCL() ? "\n- " + wx : "") + "\n\nConversación:\n" + transcript + "\nCoach:";
    askAI({ prompt, maxTokens: 900, fast: true }, (err, ok) => err ? cb(err) : cb(null, { text: (ok.text || "").trim() }));
  }).catch(e => cb({ status: 502, error: e.message || "No se pudo consultar Garmin." }));
}

const weeklyCache = new Map();
function weekly(date, refresh, cb) {
  if (!garmin.enabled()) return cb({ status: 400, error: "Falta GARMIN_API_KEY en el servidor." });
  date = validDate(date);
  const key = date + ":" + Math.floor(Date.now() / (6 * 3600e3));
  if (!refresh && weeklyCache.has(key)) return cb(null, weeklyCache.get(key));
  const prof = state.profiles.p1;
  garmin.getDay(date).then(g => {
    const stats = coach.weekStats(g, prof);
    const prompt = COACH_PROMPT + `

Escribe el RESUMEN SEMANAL de Nico comparando "semana" con "semana_anterior". Formato (texto plano, sin markdown, usa estos tres encabezados con su emoji):
🏆 Lo mejor de la semana
⚠️ A cuidar
🎯 Plan para la próxima semana
Cada sección con 2-3 viñetas cortas que empiecen con "• " y citen números concretos (recuperación, sueño, HRV, entrenamientos, calorías/proteína). Máximo 220 palabras en total.

Datos (JSON):
` + JSON.stringify(stats);
    askAI({ prompt, maxTokens: 1200, fast: true }, (err, ok) => {
      if (err) return cb(err);
      const out = { text: (ok.text || "").trim(), desde: stats.semana.desde, hasta: stats.semana.hasta, generado: Date.now() };
      weeklyCache.set(key, out);
      cb(null, out);
    });
  }).catch(e => cb({ status: 502, error: e.message || "No se pudo consultar Garmin." }));
}

function chat(body, cb) {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12);
  if (!msgs.length) return cb({ status: 400, error: "Falta el mensaje." });
  const transcript = msgs.map(m => (m.role === "user" ? "Usuario: " : "Asistente: ") + String(m.text || "").slice(0, 800)).join("\n");
  const today = Array.isArray(body.today)
    ? body.today.slice(0, 40).map(e => "- " + String(e.name || "").slice(0, 60) + " (" + Math.round(Number(e.kcal) || 0) + " kcal)").join("\n") : "";
  const st = body.stats && typeof body.stats === "object" ? body.stats : null;
  const n = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  let goals = "";
  if (st && n(st.goal)) {
    const left = n(st.goal) - (n(st.kcal) || 0);
    goals = "\n\nMetas y consumo de hoy (" + String(st.name || "usuario").slice(0, 20) + ", son las " + String(st.hora || "").slice(0, 8) + "):\n" +
      "- Calorías: " + (n(st.kcal) || 0) + " de " + n(st.goal) + " (" + (left >= 0 ? "quedan " + left : "se pasó por " + (-left)) + ")\n" +
      "- Proteína: " + (n(st.prot) || 0) + " g" + (n(st.gprot) ? " de " + n(st.gprot) + " g" : "") + "\n" +
      "- Carbos: " + (n(st.carb) || 0) + " g" + (n(st.gcarb) ? " de " + n(st.gcarb) + " g" : "") + "\n" +
      "- Grasas: " + (n(st.fat) || 0) + " g" + (n(st.gfat) ? " de " + n(st.gfat) + " g" : "");
  }
  const pr = state.profiles[body.pid];
  let gustos = "";
  if (pr) {
    const pf = pr.prefs || {}, fav = pf.fav || {}, hab = habitual(pr), L = [];
    const mom = MOMENTOS.includes(st && st.momento) ? st.momento : null;
    if (mom) L.push("- Momento del día ahora: " + mom);
    MOMENTOS.forEach(m => {
      const f = (fav[m] || []).join(", "), h = (hab[m] || []).join(", ");
      if (f || h) L.push("- " + m + (m === mom ? " (AHORA)" : "") + ": " + (f ? "favoritos: " + f : "") + (f && h ? " | " : "") + (h ? "suele registrar: " + h : ""));
    });
    if (pf.notes) L.push("- Notas: " + pf.notes);
    if (pf.approach) L.push("- Enfoque que sigue (respétalo): " + pf.approach);
    if (L.length) gustos = "\n\nGustos de " + String(pr.name || "el usuario").slice(0, 20) + ":\n" + L.join("\n");
  }
  const build = garminCtx => CHAT_PROMPT + goals + gustos + garminCtx + "\n\nYa registrado hoy:\n" + (today || "(nada todavía)") + "\n\nConversación:\n" + transcript + "\nAsistente:";
  const send = garminCtx => askAI({ prompt: build(garminCtx), maxTokens: 2200, fast: true }, cb);
  // Nico: la IA también ve su recuperación, sueño y entrenos para recomendar comida con criterio
  if (body.pid === "p1" && garmin.enabled()) {
    const date = validDate(body.date);
    return garmin.getDay(date)
      .then(g => send("\n\n" + coach.contextText(g, state.profiles.p1, coach.analyze(g, state.profiles.p1)) +
        "\nSi recomiendas comida, ajústala a este estado (entrenó, recuperación, gasto calórico)."))
      .catch(() => send(""));
  }
  send("");
}

/* ================= HTTP ================= */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json"
};

function sendJSON(res, code, obj) {
  const head = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const body = Buffer.from(JSON.stringify(obj));
  if (res._gz && body.length > 1024) {
    head["content-encoding"] = "gzip"; head.vary = "accept-encoding";
    return zlib.gzip(body, (err, gz) => { if (err) { delete head["content-encoding"]; gz = body; } res.writeHead(code, head); res.end(gz); });
  }
  res.writeHead(code, head);
  res.end(body);
}

/* archivos estáticos: en memoria, comprimidos y con ETag (si no cambió → 304 sin cuerpo) */
const staticCache = new Map();
const COMPRESSIBLE = /\.(html|js|json|svg|css|webmanifest)$/;
function sendStatic(req, res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("No encontrado"); }
    const etag = '"' + st.size.toString(36) + "-" + Math.round(st.mtimeMs).toString(36) + '"';
    const head = { "content-type": MIME[path.extname(full)] || "application/octet-stream", "cache-control": "no-cache", etag, vary: "accept-encoding" };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, head); return res.end(); }
    const serve = hit => {
      const gz = res._gz && hit.gz;
      if (gz) head["content-encoding"] = "gzip";
      res.writeHead(200, head);
      res.end(gz ? hit.gz : hit.raw);
    };
    const hit = staticCache.get(full);
    if (hit && hit.etag === etag) return serve(hit);
    fs.readFile(full, (e2, raw) => {
      if (e2) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("No encontrado"); }
      const entry = { etag, raw, gz: null };
      if (!COMPRESSIBLE.test(full)) { staticCache.set(full, entry); return serve(entry); }
      zlib.gzip(raw, { level: 9 }, (e3, gz) => { if (!e3) entry.gz = gz; staticCache.set(full, entry); serve(entry); });
    });
  });
}

function readBody(req, res, limit, cb) {
  let size = 0; const chunks = [];
  req.on("data", c => {
    size += c.length;
    if (size > limit) { req.destroy(); sendJSON(res, 413, { error: "Imagen demasiado grande." }); cb = null; return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (!cb) return;
    try { cb(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch (e) { sendJSON(res, 400, { error: "JSON inválido." }); }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  res._gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");

  if (p.startsWith("/api/")) {
    if (PIN && (req.headers["x-nt-pin"] || "") !== PIN) {
      return sendJSON(res, 401, { error: "PIN requerido", pin: true });
    }
    if (p === "/api/sync" && req.method === "POST") {
      return readBody(req, res, 2 * 1024 * 1024, body => {
        const ops = Array.isArray(body.ops) ? body.ops : [];
        // sin operaciones no se reescribe nada (antes cada sync periódico guardaba todo en Upstash)
        if (ops.length) { ops.forEach(applyOp); persist(); }
        else if (body.rev && body.rev === rev()) return sendJSON(res, 200, { same: true, rev: rev() });
        sendJSON(res, 200, publicState());
      });
    }
    if (p === "/api/coach" && req.method === "POST") {
      return readBody(req, res, 2 * 1024 * 1024, body => {
        if (!saveCoach(body)) return sendJSON(res, 400, { error: "Briefing inválido: falta 'fecha' YYYY-MM-DD." });
        sendJSON(res, 200, { ok: true, fecha: body.fecha });
      });
    }
    if (p === "/api/analyze" && req.method === "POST") {
      return readBody(req, res, 15 * 1024 * 1024, body => {
        if (!body.image) return sendJSON(res, 400, { error: "Falta la imagen." });
        analyze(body, (err, ok) => {
          if (err) return sendJSON(res, err.status, { error: err.error });
          sendJSON(res, 200, ok);
        });
      });
    }
    if (p === "/api/garmin" && req.method === "GET") {
      if (!garmin.enabled()) return sendJSON(res, 400, { error: "Falta la variable GARMIN_API_KEY en el servidor." });
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { error: "Fecha inválida." });
      const job = url.searchParams.get("view") === "energy"
        ? garmin.getEnergy(date)
        : garmin.getDay(date).then(g => Object.assign(g, coach.analyze(g, state.profiles.p1), { nutrition: dayFood(date) }));
      return job.then(d => sendJSON(res, 200, d))
        .catch(e => sendJSON(res, 502, { error: e.message || "No se pudo consultar Garmin." }));
    }
    if (p === "/api/weather" && req.method === "GET") {
      return weather.getWeather()
        .then(w => sendJSON(res, 200, w))
        .catch(e => sendJSON(res, 502, { error: "No se pudo obtener el clima: " + (e.message || e) }));
    }
    if (p === "/api/coach-ask" && req.method === "POST") {
      return readBody(req, res, 64 * 1024, body => coachAsk(body, (err, ok) => {
        if (err) return sendJSON(res, err.status, { error: err.error });
        sendJSON(res, 200, ok);
      }));
    }
    if (p === "/api/weekly" && req.method === "GET") {
      return weekly(url.searchParams.get("date") || "", url.searchParams.get("refresh") === "1", (err, ok) => {
        if (err) return sendJSON(res, err.status, { error: err.error });
        sendJSON(res, 200, ok);
      });
    }
    if (p === "/api/transcribe" && req.method === "POST") {
      return readBody(req, res, 8 * 1024 * 1024, body => {
        if (!body.audio) return sendJSON(res, 400, { error: "Falta el audio." });
        const prompt = "Transcribe este audio en español, tal cual se dice, sin comentarios ni comillas. Si no se entiende nada, responde con texto vacío.";
        askAI({ prompt, image: body.audio, mediaType: String(body.mediaType || "audio/webm").split(";")[0], audio: true, fast: true, maxTokens: 800 }, (err, ok) => {
          if (err) return sendJSON(res, err.status, { error: err.error });
          sendJSON(res, 200, { text: (ok.text || "").trim() });
        });
      });
    }
    if (p === "/api/chat" && req.method === "POST") {
      return readBody(req, res, 256 * 1024, body => {
        chat(body, (err, ok) => {
          if (err) return sendJSON(res, err.status, { error: err.error });
          sendJSON(res, 200, ok);
        });
      });
    }
    return sendJSON(res, 404, { error: "No existe" });
  }

  // estático
  let file = p === "/" ? "/index.html" : p;
  file = path.normalize(file).replace(/^(\.\.[\\/])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  sendStatic(req, res, full);
});

(async function main() {
  try {
    const raw = await loadState();
    if (raw && raw.profiles) {
      state = raw;
      state.coach = state.coach || {};
      if (!state.profiles.p3) state.profiles.p3 = freshProfile("Mamá");
      // renombrar los nombres por defecto antiguos
      if (state.profiles.p1 && state.profiles.p1.name === "Yo") state.profiles.p1.name = "Nico";
      if (state.profiles.p2 && state.profiles.p2.name === "Hermano") state.profiles.p2.name = "Chris";
    } else if (raw) {
      // migración desde el formato v1 (un solo usuario)
      const s = raw.settings || {};
      state.key = s.key || "";
      state.profiles.p1 = {
        name: "Nico",
        log: raw.log || {},
        settings: { goal: s.goal || 2000, gprot: s.gprot || null, gcarb: s.gcarb || null }
      };
    }
  } catch (e) {
    console.error("⚠️ No se pudo cargar el estado (" + e.message + "). Arrancando vacío.");
  }

  server.listen(PORT, "0.0.0.0", () => {
    const ips = [];
    Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(n => {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }));
    console.log("");
    console.log("  🥗 NuTracker corriendo");
    console.log("  ─────────────────────────────────────────");
    console.log("  En este PC:      http://localhost:" + PORT);
    ips.forEach(ip => console.log("  En tu celular:   http://" + ip + ":" + PORT + "   (misma red Wi-Fi)"));
    if (PIN) console.log("  🔒 PIN de acceso activado");
    console.log("  Datos en: " + (USE_UPSTASH ? "Upstash Redis" : DATA_FILE));
    console.log("  ─────────────────────────────────────────");
    console.log("");
  });
})();
