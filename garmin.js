/*
 * Garmin Connect Personal API → panel estilo Whoop.
 * La clave personal (GARMIN_API_KEY) vive solo en el servidor: se cambia por un
 * token de acceso de 24 h y nunca llega al navegador.
 * Docs: https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
 */
"use strict";
const https = require("https");

const HOST = "personal.connectapi.garmin.com";
const HIST_DAYS = 56;          // historial (8 semanas): tendencias, rachas, correlaciones
const CHUNK = 28;              // Garmin podría limitar los rangos: se piden en tramos
const CACHE_MS = 5 * 60 * 1000;

const apiKey = () => (process.env.GARMIN_API_KEY || "").trim();
const enabled = () => !!apiKey();

/* ---------- HTTP + token ---------- */
function request(method, path, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: HOST, path, method, headers }, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => resolve({ status: resp.statusCode, body: d }));
    });
    r.on("error", reject);
    r.setTimeout(20000, () => r.destroy(new Error("Garmin tardó demasiado")));
    r.end();
  });
}

let token = null, tokenExp = 0;
async function getToken(force) {
  if (!force && token && Date.now() < tokenExp) return token;
  const r = await request("POST", "/personalapitoken-service/personal-api/personal-api-key/token",
    { Authorization: "ApiKey " + apiKey() });
  if (r.status === 401 || r.status === 403) throw new Error("La clave de Garmin es inválida o expiró. Genera una nueva en Garmin Connect → Configuración → Clave API personal.");
  if (r.status !== 200) throw new Error("Garmin respondió " + r.status + " al pedir el token.");
  token = r.body.trim();
  tokenExp = Date.now() + 23 * 3600e3;
  try { // si el JWT trae su propia expiración, respetarla
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).exp;
    if (exp) tokenExp = Math.min(tokenExp, exp * 1000 - 5 * 60e3);
  } catch (e) {}
  return token;
}

const cache = new Map();
async function get(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
  let r = await request("GET", path, { Authorization: "Bearer " + await getToken() });
  if (r.status === 401) r = await request("GET", path, { Authorization: "Bearer " + await getToken(true) });
  let data = null;
  if (r.status === 200) { try { data = JSON.parse(r.body); } catch (e) {} }
  cache.set(path, { t: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}
const safe = p => get(p).catch(() => null);

/* ---------- fechas ---------- */
const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => { a = a.filter(v => v != null && !isNaN(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };

/* pide un endpoint por rango [from,to] en tramos; si un tramo falla, lo parte a la mitad una vez */
async function ranged(pathFn, from, to, merge, size) {
  size = size || CHUNK;
  const spans = [];
  for (let a = from; a <= to; a = addDays(a, size)) spans.push([a, addDays(a, size - 1) > to ? to : addDays(a, size - 1)]);
  const parts = await Promise.all(spans.map(async ([a, b]) => {
    let r = await safe(pathFn(a, b));
    if (r == null && size > 7) {
      const mid = addDays(a, Math.floor(size / 2) - 1);
      if (mid >= a && mid < b) {
        const [x, y] = await Promise.all([safe(pathFn(a, mid)), safe(pathFn(addDays(mid, 1), b))]);
        return merge(x, y);
      }
    }
    return r;
  }));
  return parts.reduce((acc, r) => merge(acc, r), null);
}
const mergeArr = (a, b) => (Array.isArray(a) || Array.isArray(b)) ? [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : []) : null;
const mergeDs = (a, b) => (a || b) ? { data: [].concat((a && a.data) || [], (b && b.data) || []) } : null;
const mergeHrv = (a, b) => (a || b) ? { hrvSummaries: [].concat((a && a.hrvSummaries) || [], (b && b.hrvSummaries) || []) } : null;

/* ---------- puntajes (aproximaciones; Garmin no da recuperación/esfuerzo tipo Whoop) ---------- */
function hrvScore(v, base) {
  if (v == null || !base) return null;
  const lo = base.balancedLow, hi = base.balancedUpper;
  if (v >= lo) return clamp(70 + 30 * (v - lo) / Math.max(1, hi - lo), 70, 100);
  return clamp(70 * Math.pow(v / lo, 2), 0, 70);
}
function rhrScore(rhr, ref) {
  if (rhr == null || ref == null) return null;
  return clamp(85 - 9 * (rhr - ref), 0, 100);
}
/* Recuperación 0-100: HRV 40 %, sueño 30 %, FC en reposo 15 %, Body Battery 15 % */
function recovery(parts) {
  const W = { hrv: .4, sleep: .3, rhr: .15, bb: .15 };
  let sum = 0, w = 0;
  Object.keys(W).forEach(k => { if (parts[k] != null) { sum += parts[k] * W[k]; w += W[k]; } });
  return w ? Math.round(sum / w) : null;
}
/* Esfuerzo 0-21 (escala Whoop) estimado desde minutos de intensidad */
function strain(mod, vig) {
  const x = (mod || 0) + 2 * (vig || 0);
  return Math.round(21 * (1 - Math.exp(-x / 90)) * 10) / 10;
}

/* ---------- armado del día ---------- */
async function getDay(date) {
  const from = addDays(date, -(HIST_DAYS - 1));
  const [summary, sleep, hrv, hrvRange, bb, hr, ds, sleepSum, acts, zones] = await Promise.all([
    safe(`/usersummary-service/usersummary/daily?calendarDate=${date}`),
    safe(`/sleep-service/sleep/dailySleep?date=${date}`),
    safe(`/hrv-service/hrv/${date}`),
    ranged((a, b) => `/hrv-service/hrv/daily/${a}/${b}`, from, date, mergeHrv),
    ranged((a, b) => `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${a}&endDate=${b}`, from, date, mergeArr),
    safe(`/wellness-service/wellness/dailyHeartRate?date=${date}`),
    ranged((a, b) => `/usersummary-service/v2/dailysummaries?startDate=${a}&endDate=${b}`, from, date, mergeDs),
    ranged((a, b) => `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${a}&endDate=${b}`, from, date, mergeArr),
    safe(`/activitylist-service/activities/search/activities?start=0&limit=40`),
    safe(`/biometric-service/heartRateZones/v2`)
  ]);
  if (!summary && !sleep && !ds) throw new Error("Garmin no devolvió datos para esa fecha.");

  const dsDays = ((ds && ds.data) || []).filter(x => x.calendarDate);
  const dsBy = {}; dsDays.forEach(x => dsBy[x.calendarDate] = x);
  const hrvBy = {}; ((hrvRange && hrvRange.hrvSummaries) || []).forEach(x => hrvBy[x.calendarDate] = x);
  const sleepBy = {}; (Array.isArray(sleepSum) ? sleepSum : []).filter(x => x.calendarDate).forEach(x => sleepBy[x.calendarDate] = x);
  const bbBy = {}; (Array.isArray(bb) ? bb : []).forEach(x => bbBy[x.date] = x);

  const rhrAll = dsDays.map(x => x.heartRate && x.heartRate.restingValue);
  const rhrRef = avg(rhrAll);

  /* serie de tendencia: un punto por día */
  const days = [];
  for (let i = HIST_DAYS - 1; i >= 0; i--) {
    const d = addDays(date, -i);
    const s = dsBy[d] || {}, hv = hrvBy[d] || {}, sl = sleepBy[d] || {}, b = bbBy[d] || {};
    const slScore = sl.sleepScores && sl.sleepScores.overall ? sl.sleepScores.overall.value : null;
    const rhr = s.heartRate ? s.heartRate.restingValue : null;
    const im = s.intensityMinutes || {};
    const parts = {
      hrv: hrvScore(hv.lastNightAvg, hv.baseline),
      sleep: slScore,
      rhr: rhrScore(rhr, rhrRef),
      bb: b.charged != null ? clamp(b.charged * 1.3, 0, 100) : null
    };
    days.push({
      date: d,
      // sin HRV ni sueño medidos el puntaje sería engañoso: se deja vacío
      recovery: parts.hrv == null && parts.sleep == null ? null : recovery(parts),
      sleepScore: slScore,
      sleepHours: sl.sleepTimeSeconds ? Math.round(sl.sleepTimeSeconds / 360) / 10 : null,
      hrv: hv.lastNightAvg != null ? hv.lastNightAvg : null,
      hrvWeekly: hv.weeklyAvg != null ? hv.weeklyAvg : null,
      hrvLow: hv.baseline ? hv.baseline.balancedLow : null,
      hrvHigh: hv.baseline ? hv.baseline.balancedUpper : null,
      kcalActive: s.calories ? s.calories.burnedActive : null,
      kcalTotal: s.calories ? s.calories.burnedTotal : null,
      rhr,
      steps: s.movement && s.movement.steps ? s.movement.steps.value : null,
      stepGoal: s.movement && s.movement.steps ? s.movement.steps.goal : null,
      stress: s.stress ? s.stress.avgLevel : null,
      strain: s.intensityMinutes ? strain(im.moderate, im.vigorous) : null
    });
  }
  const today = days[days.length - 1];

  /* HRV de la noche, con su baseline */
  const hs = (hrv && hrv.hrvSummary) || {};
  const sleepDTO = sleep || {};
  const sc = sleepDTO.sleepScores || {};
  const sm = summary || dsBy[date] || {};
  const bbToday = bbBy[date];
  const wake = sm.bodyBatteryAtWakeTime != null ? sm.bodyBatteryAtWakeTime : (sm.bodyBattery && sm.bodyBattery.maxValue);

  const rec = {
    score: today.recovery,
    parts: {
      hrv: hs.lastNightAvg != null ? { value: hs.lastNightAvg, weekly: hs.weeklyAvg, status: hs.status, low: hs.baseline && hs.baseline.balancedLow, high: hs.baseline && hs.baseline.balancedUpper, score: Math.round(hrvScore(hs.lastNightAvg, hs.baseline) || 0) } : null,
      rhr: today.rhr != null ? { value: today.rhr, ref: rhrRef != null ? Math.round(rhrRef * 10) / 10 : null, score: Math.round(rhrScore(today.rhr, rhrRef) || 0) } : null,
      sleep: today.sleepScore != null ? { value: today.sleepScore } : null,
      bodyBattery: wake != null ? { value: wake } : null
    }
  };

  const hasSleep = !!sleepDTO.sleepTimeSeconds;
  const sleepOut = hasSleep ? {
    score: sc.overall ? sc.overall.value : null,
    qualifier: sc.overall ? sc.overall.qualifierKey : null,
    seconds: sleepDTO.sleepTimeSeconds,
    napSeconds: sleepDTO.napTimeSeconds || 0,
    deep: sleepDTO.deepSleepSeconds, light: sleepDTO.lightSleepSeconds, rem: sleepDTO.remSleepSeconds, awake: sleepDTO.awakeSleepSeconds,
    start: sleepDTO.sleepStartTimestampGMT, end: sleepDTO.sleepEndTimestampGMT,
    awakeCount: sleepDTO.awakeCount, avgHr: sleepDTO.avgHeartRate, resp: sleepDTO.averageRespirationValue,
    stress: sleepDTO.avgSleepStress,
    needMinutes: sleepDTO.sleepNeed ? sleepDTO.sleepNeed.actual : null,
    feedback: sleepDTO.sleepScoreFeedback || null,
    parts: ["totalDuration", "stress", "awakeCount", "restlessness", "remPercentage", "lightPercentage", "deepPercentage"].map(k =>
      sc[k] ? { key: k, value: sc[k].value != null ? sc[k].value : null, q: sc[k].qualifierKey } : null).filter(Boolean)
  } : null;

  const hrSeries = hr && Array.isArray(hr.heartRateValues) ? hr.heartRateValues.filter(p => p[1] != null && p[1] > 0) : [];
  const bbSeries = bbToday && Array.isArray(bbToday.bodyBatteryValuesArray) ? bbToday.bodyBatteryValuesArray.filter(p => p[1] != null) : [];
  const hrvReadings = hrv && Array.isArray(hrv.hrvReadings) ? hrv.hrvReadings.map(r => [Date.parse(r.readingTimeGMT + "Z"), r.hrvValue]) : [];

  /* actividades recientes */
  const z = Array.isArray(zones) && zones[0] ? zones[0] : null;
  const activities = (Array.isArray(acts) ? acts : []).slice(0, 40).map(a => ({
    id: a.activityId,
    name: a.activityName,
    type: a.activityType && a.activityType.typeKey,
    start: a.startTimeLocal,           // "YYYY-MM-DD HH:MM:SS" hora local
    duration: a.duration,
    distance: a.distance,
    calories: a.calories,
    avgHr: a.averageHR, maxHr: a.maxHR,
    aerobicTE: a.aerobicTrainingEffect, anaerobicTE: a.anaerobicTrainingEffect,
    teLabel: a.trainingEffectLabel,
    load: a.activityTrainingLoad != null ? Math.round(a.activityTrainingLoad * 10) / 10 : null,
    steps: a.steps,
    sets: a.activeSets, reps: a.totalReps,
    elevation: a.elevationGain,
    zones: [1, 2, 3, 4, 5].map(i => a["hrTimeInZone_" + i] || 0),
    bbImpact: a.differenceBodyBattery
  }));

  return {
    date,
    recovery: rec,
    strain: today.strain,
    sleep: sleepOut,
    hrv: { last: hs.lastNightAvg, weekly: hs.weeklyAvg, status: hs.status, low: hs.baseline && hs.baseline.balancedLow, high: hs.baseline && hs.baseline.balancedUpper, readings: hrvReadings },
    heartRate: {
      resting: sm.restingHeartRate != null ? sm.restingHeartRate : today.rhr,
      min: sm.minHeartRate, max: sm.maxHeartRate,
      series: hrSeries
    },
    bodyBattery: {
      wake, high: sm.bodyBatteryHighestValue, low: sm.bodyBatteryLowestValue, now: sm.bodyBatteryMostRecentValue,
      charged: sm.bodyBatteryChargedValue, drained: sm.bodyBatteryDrainedValue, series: bbSeries
    },
    day: {
      steps: sm.totalSteps, stepGoal: sm.dailyStepGoal, distance: sm.totalDistanceMeters,
      floors: sm.floorsAscended != null ? Math.round(sm.floorsAscended) : null,
      kcalTotal: sm.totalKilocalories, kcalActive: sm.activeKilocalories, kcalRest: sm.bmrKilocalories,
      moderate: sm.moderateIntensityMinutes, vigorous: sm.vigorousIntensityMinutes, intensityGoal: sm.intensityMinutesGoal,
      stressAvg: sm.averageStressLevel, stressMax: sm.maxStressLevel, stressQualifier: sm.stressQualifier,
      stressPct: { rest: sm.restStressPercentage, low: sm.lowStressPercentage, medium: sm.mediumStressPercentage, high: sm.highStressPercentage, activity: sm.activityStressPercentage },
      respiration: sm.avgWakingRespirationValue,
      sedentarySeconds: sm.sedentarySeconds, activeSeconds: sm.activeSeconds
    },
    trend: days,
    hrZones: z ? [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor, z.maxHeartRateUsed] : null,
    activities
  };
}

/* gasto de energía liviano (app principal): kcal activas de hoy vs. tu promedio de 14 días */
async function getEnergy(date) {
  const from = addDays(date, -14);
  const [summary, ds] = await Promise.all([
    safe(`/usersummary-service/usersummary/daily?calendarDate=${date}`),
    ranged((a, b) => `/usersummary-service/v2/dailysummaries?startDate=${a}&endDate=${b}`, from, addDays(date, -1), mergeDs)
  ]);
  const prev = ((ds && ds.data) || []).filter(x => x.calories && x.calories.burnedActive != null).map(x => x.calories.burnedActive);
  const a = avg(prev);
  return {
    date,
    kcalActive: summary && summary.activeKilocalories != null ? Math.round(summary.activeKilocalories) : null,
    avgActive: a != null ? Math.round(a) : null,
    days: prev.length
  };
}

module.exports = { enabled, getDay, getEnergy };
