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
 */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

let saveTimer = null;
function persist() {
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

function aiKey() {
  return (state.key || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

function publicState() {
  return {
    profiles: state.profiles,
    coach: state.coach,
    hasKey: !!aiKey()
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
      // el modelo no acepta thinkingConfig: reintentar igual sin él
      if (gc.thinkingConfig && /thinking/i.test(err.error || "")) return callGemini(key, r, cb, model, true);
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

/* conversación: el usuario cuenta en texto libre lo que comió */
const CHAT_PROMPT = `Eres el asistente de un tracker de calorías. El usuario te cuenta en lenguaje natural lo que comió o bebió; tú estimas calorías y macros y él las confirma para guardarlas.

Responde SOLO con JSON válido, sin markdown, con esta estructura:
{
  "respuesta": "mensaje breve y amable en español (1-2 frases)",
  "comidas": [
    {"nombre": "alimento o plato", "porcion": "cantidad estimada", "kcal": 0, "prot": 0, "carb": 0, "grasa": 0}
  ]
}

Reglas:
- "comidas" incluye SOLO lo nuevo mencionado en el ÚLTIMO mensaje del usuario (no repitas lo ya registrado hoy ni lo ya propuesto antes). Un elemento por comida/plato.
- Si el usuario corrige algo ("eran 2, no 3"), devuelve la versión corregida en "comidas".
- Si solo pregunta o conversa, deja "comidas" vacío y contesta en "respuesta".
- Si no da cantidades usa porciones típicas chilenas y dilo en la respuesta. Macros en gramos.`;

function chat(body, cb) {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12);
  if (!msgs.length) return cb({ status: 400, error: "Falta el mensaje." });
  const transcript = msgs.map(m => (m.role === "user" ? "Usuario: " : "Asistente: ") + String(m.text || "").slice(0, 800)).join("\n");
  const today = Array.isArray(body.today)
    ? body.today.slice(0, 40).map(e => "- " + String(e.name || "").slice(0, 60) + " (" + Math.round(Number(e.kcal) || 0) + " kcal)").join("\n") : "";
  const prompt = CHAT_PROMPT + "\n\nYa registrado hoy:\n" + (today || "(nada todavía)") + "\n\nConversación:\n" + transcript + "\nAsistente:";
  askAI({ prompt, maxTokens: 1500, fast: true }, cb);
}

/* ================= HTTP ================= */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json"
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
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

  if (p.startsWith("/api/")) {
    if (PIN && (req.headers["x-nt-pin"] || "") !== PIN) {
      return sendJSON(res, 401, { error: "PIN requerido", pin: true });
    }
    if (p === "/api/sync" && req.method === "POST") {
      return readBody(req, res, 2 * 1024 * 1024, body => {
        (Array.isArray(body.ops) ? body.ops : []).forEach(applyOp);
        persist();
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
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("No encontrado"); }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
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
