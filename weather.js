/*
 * Clima de hoy (Open-Meteo, gratis y sin clave) para el panel de Nico.
 * Ubicación por defecto: Lo Barnechea, Santiago (como el briefing del coach).
 * Se puede cambiar con WEATHER_LAT / WEATHER_LON / WEATHER_PLACE.
 */
"use strict";
const https = require("https");

const LAT = process.env.WEATHER_LAT || "-33.35";
const LON = process.env.WEATHER_LON || "-70.52";
const PLACE = process.env.WEATHER_PLACE || "Lo Barnechea";
const TZ = "America/Santiago";
const TTL = 20 * 60 * 1000;

let cache = null;

/* https nativo (no depende de la versión de Node, a diferencia de fetch) */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "NuTracker/1.0", accept: "application/json" } }, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => {
        if (resp.statusCode !== 200) return reject(new Error("Open-Meteo respondió " + resp.statusCode));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("Respuesta inválida de Open-Meteo")); }
      });
    });
    req.on("error", e => reject(new Error("No se pudo contactar a Open-Meteo: " + e.message)));
    req.setTimeout(12000, () => req.destroy(new Error("Open-Meteo tardó demasiado")));
  });
}

/* código WMO → [emoji, descripción] */
function describe(code, isDay) {
  if (code === 0) return [isDay ? "☀️" : "🌙", "Despejado"];
  if (code === 1) return [isDay ? "🌤️" : "🌙", "Mayormente despejado"];
  if (code === 2) return ["⛅", "Parcialmente nublado"];
  if (code === 3) return ["☁️", "Nublado"];
  if (code === 45 || code === 48) return ["🌫️", "Niebla"];
  if (code >= 51 && code <= 57) return ["🌦️", "Llovizna"];
  if (code >= 61 && code <= 67) return ["🌧️", "Lluvia"];
  if (code >= 71 && code <= 77) return ["🌨️", "Nieve"];
  if (code >= 80 && code <= 82) return ["🌧️", "Chubascos"];
  if (code >= 95) return ["⛈️", "Tormenta"];
  return ["🌡️", "—"];
}
const aqiLabel = a => a == null ? null : a <= 50 ? "Buena" : a <= 100 ? "Moderada" : a <= 150 ? "Dañina para sensibles" : "Mala";

/* mejor ventana de 2 h para entrenar al aire libre, desde ahora hasta las 21:00 */
function bestWindow(hours, nowHour) {
  let best = null;
  for (let i = 0; i < hours.length - 1; i++) {
    const a = hours[i], b = hours[i + 1];
    if (a.h < Math.max(6, nowHour) || b.h > 21) continue;
    let pen = 0;
    [a, b].forEach(x => {
      pen += x.rain > 30 ? 40 + x.rain / 2 : x.rain / 5;
      if (x.temp < 8) pen += (8 - x.temp) * 3;
      if (x.temp > 24) pen += (x.temp - 24) * 4;
      if (x.uv > 7) pen += (x.uv - 7) * 6;
    });
    if (!best || pen < best.pen) best = { pen, from: a.h, to: b.h + 1, temp: Math.round((a.temp + b.temp) / 2), rain: Math.max(a.rain, b.rain), uv: Math.max(a.uv, b.uv) };
  }
  return best;
}

async function load() {
  const base = "https://api.open-meteo.com/v1/forecast?latitude=" + LAT + "&longitude=" + LON +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day" +
    "&hourly=temperature_2m,precipitation_probability,weather_code,uv_index" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset,weather_code" +
    "&timezone=" + encodeURIComponent(TZ) + "&forecast_days=1";
  const air = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + LAT + "&longitude=" + LON +
    "&current=us_aqi,pm2_5&timezone=" + encodeURIComponent(TZ);
  const [w, a] = await Promise.all([getJson(base), getJson(air).catch(() => null)]);
  const c = w.current, d = w.daily;
  const [icon, text] = describe(c.weather_code, c.is_day);
  const hours = w.hourly.time.map((t, i) => ({
    h: Number(t.slice(11, 13)), temp: w.hourly.temperature_2m[i], rain: w.hourly.precipitation_probability[i] || 0,
    code: w.hourly.weather_code[i], uv: w.hourly.uv_index[i] || 0
  }));
  const nowHour = Number(c.time.slice(11, 13));
  const aqi = a && a.current ? a.current.us_aqi : null;
  return {
    place: PLACE, updated: c.time,
    now: { temp: c.temperature_2m, feels: c.apparent_temperature, icon, text, wind: c.wind_speed_10m, humidity: c.relative_humidity_2m, isDay: !!c.is_day },
    today: {
      max: d.temperature_2m_max[0], min: d.temperature_2m_min[0], rain: d.precipitation_probability_max[0], uv: d.uv_index_max[0],
      sunrise: d.sunrise[0].slice(11, 16), sunset: d.sunset[0].slice(11, 16), icon: describe(d.weather_code[0], 1)[0], text: describe(d.weather_code[0], 1)[1]
    },
    hours: hours.filter(x => x.h >= 5 && x.h <= 23).map(x => ({ h: x.h, temp: x.temp, rain: x.rain, uv: x.uv, icon: describe(x.code, x.h >= 7 && x.h <= 19)[0] })),
    nowHour,
    aqi, aqiLabel: aqiLabel(aqi),
    best: bestWindow(hours, nowHour)
  };
}

async function getWeather() {
  if (cache && Date.now() - cache.t < TTL) return cache.data;
  const data = await load();
  cache = { t: Date.now(), data };
  return data;
}

/* una línea para el contexto de la IA */
async function summaryText() {
  try {
    const w = await getWeather();
    return "Clima hoy en " + w.place + ": " + w.now.text + ", ahora " + Math.round(w.now.temp) + "° (sensación " + Math.round(w.now.feels) + "°), máx " + Math.round(w.today.max) + "° / mín " + Math.round(w.today.min) +
      "°, lluvia " + w.today.rain + "%, UV " + w.today.uv + (w.aqi != null ? ", aire " + w.aqiLabel + " (AQI " + w.aqi + ")" : "") +
      (w.best ? ". Mejor ventana para entrenar afuera: " + w.best.from + ":00–" + w.best.to + ":00 (" + w.best.temp + "°)" : "");
  } catch (e) { return null; }
}

module.exports = { getWeather, summaryText };
