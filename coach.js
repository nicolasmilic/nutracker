/*
 * Análisis del panel Garmin de Nico: cruza Garmin (garmin.js) con su registro de
 * comidas y su diario. Todo es determinista (sin IA): correlaciones, hábitos,
 * alertas de sobreentrenamiento y plan del día. La IA solo redacta el resumen
 * semanal y responde preguntas, a partir del texto de contextText().
 */
"use strict";

const TAGS = [
  { key: "cafe", label: "☕ Café" },
  { key: "alcohol", label: "🍷 Alcohol" },
  { key: "cena_pesada", label: "🍕 Cena pesada" },
  { key: "estres", label: "😰 Día estresante" },
  { key: "tarde", label: "🌙 Me acosté tarde" },
  { key: "meditacion", label: "🧘 Meditación" },
  { key: "proteina", label: "🥤 Proteína en polvo" },
  { key: "sol", label: "☀️ Sol en la mañana" }
];
const TAG_LABEL = Object.fromEntries(TAGS.map(t => [t.key, t.label]));

/* ---------- utilidades ---------- */
const nums = a => a.filter(v => v != null && !isNaN(v));
const avg = a => { a = nums(a); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r0 = v => v == null ? null : Math.round(v);
function median(a) { a = nums(a).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return 0;
  const mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* "10:46 a. m." | "7:05 p. m." | "19:05" → hora decimal (0-24); madrugada cuenta como noche anterior */
function parseTime(t) {
  const m = /(\d{1,2})[:.](\d{2})/.exec(String(t || ""));
  if (!m) return null;
  let h = +m[1];
  if (/p\.?\s?m/i.test(t) && h < 12) h += 12;
  if (/a\.?\s?m/i.test(t) && h === 12) h = 0;
  return h + (+m[2]) / 60;
}
const fmtHour = h => { h = ((h % 24) + 24) % 24; const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return String(mm === 60 ? hh + 1 : hh).padStart(2, "0") + ":" + String(mm === 60 ? 0 : mm).padStart(2, "0"); };

function dayNutrition(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const t = { kcal: 0, prot: 0, carb: 0, fat: 0, n: entries.length, last: null };
  entries.forEach(e => {
    t.kcal += Number(e.kcal) || 0; t.prot += Number(e.prot) || 0; t.carb += Number(e.carb) || 0; t.fat += Number(e.fat) || 0;
    let h = parseTime(e.time);
    if (h != null) { if (h < 4) h += 24; if (t.last == null || h > t.last) t.last = h; }
  });
  return t;
}

/* ---------- correlaciones comida/hábitos → recuperación del día siguiente ---------- */
const TARGETS = [
  { k: "recovery", name: "recuperación", unit: "pts", min: 4 },
  { k: "sleepScore", name: "puntaje de sueño", unit: "pts", min: 4 },
  { k: "hrv", name: "HRV", unit: "ms", min: 3 }
];
const FEATURES = [
  { k: "kcal", icon: "🔥", hi: "comes más calorías", lo: "comes menos calorías", unit: " kcal", fmt: v => Math.round(v) },
  { k: "prot", icon: "💪", hi: "comes más proteína", lo: "comes menos proteína", unit: " g", fmt: v => Math.round(v) },
  { k: "carb", icon: "🍞", hi: "comes más carbohidratos", lo: "comes menos carbohidratos", unit: " g", fmt: v => Math.round(v) },
  { k: "fat", icon: "🥑", hi: "comes más grasa", lo: "comes menos grasa", unit: " g", fmt: v => Math.round(v) },
  { k: "last", icon: "🌙", hi: "tu última comida es más tarde", lo: "tu última comida es más temprano", unit: "", fmt: v => fmtHour(v) }
];

function insights(trend, prof) {
  const log = (prof && prof.log) || {}, jr = (prof && prof.journal) || {};
  const pairs = [];                       // [{nut, tags|null, next}]
  for (let i = 0; i < trend.length - 1; i++) {
    const d = trend[i].date, next = trend[i + 1];
    pairs.push({ date: d, nut: dayNutrition(log[d]), tags: jr[d] || null, next });
  }
  const out = [];

  FEATURES.forEach(f => {
    const rows = pairs.filter(p => p.nut && p.nut[f.k] != null);
    if (rows.length < 10) return;
    let best = null;
    TARGETS.forEach(t => {
      const r = rows.filter(p => p.next[t.k] != null);
      if (r.length < 10) return;
      const xs = r.map(p => p.nut[f.k]), ys = r.map(p => p.next[t.k]);
      const c = pearson(xs, ys), med = median(xs);
      const hi = r.filter(p => p.nut[f.k] > med).map(p => p.next[t.k]), lo = r.filter(p => p.nut[f.k] <= med).map(p => p.next[t.k]);
      if (hi.length < 3 || lo.length < 3) return;
      const diff = avg(hi) - avg(lo);
      if (Math.abs(c) < 0.3 || Math.abs(diff) < t.min) return;
      if (!best || Math.abs(c) > Math.abs(best.c)) best = { t, c, diff, med, n: r.length };
    });
    if (best) {
      const up = best.diff > 0;
      out.push({
        icon: f.icon, kind: "food", score: Math.abs(best.c), good: up,
        text: `Los días que ${f.hi} (más de ${f.fmt(best.med)}${f.unit}), tu ${best.t.name} del día siguiente es ${r0(Math.abs(best.diff))} ${best.t.unit} ${up ? "mayor" : "menor"}.`,
        n: best.n
      });
    }
  });

  TAGS.forEach(tg => {
    const filled = pairs.filter(p => p.tags);
    const w = filled.filter(p => p.tags[tg.key]), wo = filled.filter(p => !p.tags[tg.key]);
    if (w.length < 3 || wo.length < 3) return;
    let best = null;
    TARGETS.forEach(t => {
      const a = nums(w.map(p => p.next[t.k])), b = nums(wo.map(p => p.next[t.k]));
      if (a.length < 3 || b.length < 3) return;
      const diff = avg(a) - avg(b), rel = Math.abs(diff) / t.min;
      if (Math.abs(diff) >= t.min && (!best || rel > best.rel)) best = { t, diff, rel };
    });
    if (best) {
      const up = best.diff > 0;
      out.push({
        icon: tg.label.split(" ")[0], kind: "habit", score: Math.min(1, best.rel / 4), good: up,
        text: `${tg.label.replace(/^\S+\s/, "")}: ${up ? "+" : "−"}${r0(Math.abs(best.diff))} ${best.t.unit} de ${best.t.name} al día siguiente (${w.length} días con, ${wo.length} sin).`,
        n: w.length + wo.length
      });
    }
  });

  out.sort((a, b) => b.score - a.score);
  const paired = pairs.filter(p => p.nut && p.next.recovery != null).length;
  const journalDays = pairs.filter(p => p.tags).length;
  return { items: out.slice(0, 7), pairedDays: paired, journalDays };
}

/* ---------- alertas de sobreentrenamiento ---------- */
function alerts(trend) {
  const last3 = trend.slice(-3), out = [];
  if (last3.length < 3) return out;
  const hrvLow = last3.every(d => d.hrv != null && d.hrvLow != null && d.hrv < d.hrvLow);
  const base = avg(trend.slice(-17, -3).map(d => d.rhr));
  const rhrNow = avg(last3.map(d => d.rhr));
  const rhrUp = base != null && rhrNow != null && rhrNow - base >= 3;
  const lowRec = trend.slice(-2).every(d => d.recovery != null && d.recovery < 50);
  const sleepLow = avg(last3.map(d => d.sleepHours));
  const poorSleep = sleepLow != null && sleepLow < 6.5;
  const hardLoad = avg(last3.map(d => d.strain)) >= 14;
  const strainRec = hardLoad && (trend[trend.length - 1].recovery || 100) < 60;

  const flags = [];
  if (hrvLow) flags.push("HRV por debajo de tu rango normal 3 días seguidos");
  if (rhrUp) flags.push("FC en reposo " + r0(rhrNow - base) + " lpm más alta que tu promedio");
  if (lowRec) flags.push("recuperación bajo 50 dos días seguidos");
  if (poorSleep) flags.push("sueño promedio de " + r1(sleepLow) + " h en los últimos 3 días");
  if (strainRec) flags.push("esfuerzo alto sostenido con recuperación en baja");

  if (flags.length >= 2) out.push({ level: "danger", title: "Posible sobreentrenamiento", text: "Tu cuerpo da varias señales de fatiga: " + flags.join("; ") + ". Baja la intensidad hoy y prioriza dormir." });
  else if (flags.length === 1) out.push({ level: "warn", title: "Ojo con tu recuperación", text: flags[0][0].toUpperCase() + flags[0].slice(1) + ". Si se repite mañana, conviene un día suave." });
  return out;
}

/* ---------- plan de entrenamiento del día ---------- */
const STRENGTH = ["strength_training"];
function plan(g, alertList) {
  const trend = g.trend, today = trend[trend.length - 1];
  let rec = today.recovery;
  if (rec == null) { for (let i = trend.length - 2; i >= 0 && rec == null; i--) rec = trend[i].recovery; }
  if (rec == null) return null;

  const acute = avg(trend.slice(-4, -1).map(d => d.strain));
  const chronic = avg(trend.slice(-31, -1).map(d => d.strain));
  const ratio = acute != null && chronic ? acute / chronic : null;
  const since = ds => (g.activities || []).filter(a => a.start && a.start.slice(0, 10) >= addDays(g.date, ds));
  const recent = since(-2);
  const lastTypes = recent.map(a => a.type);
  const didStrength = lastTypes.some(t => STRENGTH.includes(t));
  const daysSinceHard = (() => {
    for (let i = 1; i <= 7; i++) { const d = trend[trend.length - 1 - i]; if (d && d.strain >= 12) return i; }
    return 7;
  })();

  const reasons = ["Recuperación de hoy: " + rec + "%."];
  if (ratio != null) reasons.push("Carga reciente " + (ratio > 1.25 ? "alta" : ratio < 0.8 ? "baja" : "normal") + " frente a tu promedio de 30 días (×" + r1(ratio) + ").");
  if (recent.length) reasons.push("Últimos 2 días: " + recent.map(a => a.name).slice(0, 3).join(", ") + ".");
  const danger = alertList.some(a => a.level === "danger");

  let title, detail, target;
  if (danger || rec < 34) {
    title = "Descanso activo"; target = [3, 8];
    detail = "Caminata suave de 20–30 min en zona 1, movilidad y estiramientos. Cena temprano y apunta a 8 h de sueño.";
  } else if (rec < 50 || (ratio != null && ratio > 1.4)) {
    title = "Entrenamiento ligero"; target = [7, 11];
    detail = "Caminata de 40–60 min en zona 1–2, o fuerza técnica con poco peso (esfuerzo 5/10). Sin llegar al fallo.";
  } else if (rec < 67 || alertList.length) {
    target = [10, 14];
    if (alertList.length) reasons.push("Hay una alerta de fatiga activa: se modera la intensidad aunque la recuperación sea buena.");
    if (didStrength) { title = "Cardio en zona 2"; detail = "40–50 min en zona 2 (FC 119–138). Mantiene la forma sin cargar los músculos de ayer."; }
    else { title = "Fuerza moderada"; detail = "45–60 min con esfuerzo 6–7/10, 3–4 series por ejercicio y 1–2 repeticiones en reserva."; }
  } else {
    target = [14, 18];
    if (daysSinceHard >= 3 || (ratio != null && ratio < 0.8)) { title = "Día para exigirte"; detail = "Fuerza pesada o intervalos intensos: llevas días sin una sesión dura y tu cuerpo está listo."; }
    else if (didStrength) { title = "Cardio de calidad"; detail = "Intervalos o tempo 40–50 min (zonas 3–4). Alterna con la fuerza de los últimos días."; }
    else { title = "Fuerza intensa"; detail = "60 min con cargas altas, 4 series por ejercicio principal. Buen día para subir peso."; }
  }
  const done = today.strain != null ? today.strain : 0;
  if (g.date === new Date().toISOString().slice(0, 10) && done >= target[1]) reasons.push("Ya llevas esfuerzo " + r1(done) + ": con eso cumpliste el objetivo del día.");
  return { title, detail, target, reasons, recovery: rec };
}

/* ---------- texto de contexto para la IA ---------- */
function contextText(g, prof, extra) {
  const t = g.trend, today = t[t.length - 1], L = [];
  const log = (prof && prof.log) || {};
  L.push("Datos Garmin de " + g.date + ":");
  L.push("- Recuperación estimada: " + (today.recovery != null ? today.recovery + "%" : "sin datos") + " | esfuerzo estimado: " + r1(g.strain) + "/21");
  if (g.sleep) L.push("- Sueño: " + r1(g.sleep.seconds / 3600) + " h, puntaje " + g.sleep.score + ", profundo " + r0((g.sleep.deep || 0) / 60) + " min, REM " + r0((g.sleep.rem || 0) / 60) + " min, " + g.sleep.awakeCount + " despertares");
  if (g.hrv && g.hrv.last != null) L.push("- HRV anoche " + g.hrv.last + " ms (promedio semanal " + g.hrv.weekly + ", rango normal " + g.hrv.low + "–" + g.hrv.high + ")");
  L.push("- FC en reposo " + g.heartRate.resting + " lpm | Body Battery al despertar " + g.bodyBattery.wake + ", ahora " + g.bodyBattery.now);
  L.push("- Pasos " + g.day.steps + "/" + g.day.stepGoal + " | calorías gastadas " + g.day.kcalTotal + " (activas " + g.day.kcalActive + ") | estrés prom. " + g.day.stressAvg);
  const wk = t.slice(-7);
  L.push("- Últimos 7 días (prom.): recuperación " + r0(avg(wk.map(d => d.recovery))) + "%, sueño " + r1(avg(wk.map(d => d.sleepHours))) + " h, HRV " + r0(avg(wk.map(d => d.hrv))) + " ms, esfuerzo " + r1(avg(wk.map(d => d.strain))));
  const acts = (g.activities || []).filter(a => a.start && a.start.slice(0, 10) >= addDays(g.date, -6)).slice(0, 8);
  if (acts.length) L.push("- Entrenamientos recientes: " + acts.map(a => a.name + " (" + a.start.slice(0, 10) + ", " + r0(a.duration / 60) + " min, " + r0(a.calories) + " kcal)").join("; "));
  const nut = dayNutrition(log[g.date]);
  L.push("- Comida registrada ese día: " + (nut ? r0(nut.kcal) + " kcal, P " + r0(nut.prot) + " g, C " + r0(nut.carb) + " g, G " + r0(nut.fat) + " g" + (nut.last != null ? ", última comida " + fmtHour(nut.last) : "") : "nada todavía"));
  const jr = prof && prof.journal && prof.journal[g.date];
  if (jr) L.push("- Diario del día: " + Object.keys(jr).filter(k => jr[k]).map(k => (TAG_LABEL[k] || k).replace(/^\S+\s/, "")).join(", "));
  if (extra && extra.plan) L.push("- Plan sugerido por la app: " + extra.plan.title + " (esfuerzo objetivo " + extra.plan.target.join("–") + ")");
  if (extra && extra.alerts && extra.alerts.length) L.push("- Alertas: " + extra.alerts.map(a => a.title + ": " + a.text).join(" "));
  if (extra && extra.insights && extra.insights.items.length) L.push("- Patrones detectados: " + extra.insights.items.slice(0, 4).map(i => i.text).join(" "));
  return L.join("\n");
}

/* ---------- estadísticas de la semana (para el resumen con IA) ---------- */
function weekStats(g, prof) {
  const t = g.trend, log = (prof && prof.log) || {};
  const wk = t.slice(-7), prev = t.slice(-14, -7);
  const nutr = days => days.map(d => dayNutrition(log[d.date])).filter(Boolean);
  const f = (days) => {
    const n = nutr(days);
    return {
      recuperacion: r0(avg(days.map(d => d.recovery))), sueno_h: r1(avg(days.map(d => d.sleepHours))), puntaje_sueno: r0(avg(days.map(d => d.sleepScore))),
      hrv: r0(avg(days.map(d => d.hrv))), fc_reposo: r1(avg(days.map(d => d.rhr))), pasos: r0(avg(days.map(d => d.steps))),
      esfuerzo: r1(avg(days.map(d => d.strain))), estres: r0(avg(days.map(d => d.stress))),
      dias_con_comida_registrada: n.length, kcal_comidas: n.length ? r0(avg(n.map(x => x.kcal))) : null, proteina_g: n.length ? r0(avg(n.map(x => x.prot))) : null,
      kcal_gastadas: r0(avg(days.map(d => d.kcalTotal)))
    };
  };
  const acts = (g.activities || []).filter(a => a.start && a.start.slice(0, 10) >= wk[0].date);
  const tags = {};
  wk.forEach(d => { const j = prof && prof.journal && prof.journal[d.date]; if (j) Object.keys(j).forEach(k => { if (j[k]) tags[k] = (tags[k] || 0) + 1; }); });
  return {
    semana: { desde: wk[0].date, hasta: wk[wk.length - 1].date, ...f(wk) },
    semana_anterior: f(prev),
    entrenamientos: acts.map(a => ({ nombre: a.name, fecha: a.start.slice(0, 10), min: r0(a.duration / 60), kcal: r0(a.calories) })),
    habitos_diario: Object.keys(tags).map(k => (TAG_LABEL[k] || k) + " ×" + tags[k])
  };
}

/* ---------- API para el servidor ---------- */
function analyze(g, prof) {
  const jr = (prof && prof.journal) || {}, log = (prof && prof.log) || {};
  g.trend.forEach(d => { const n = dayNutrition(log[d.date]); d.kcalIn = n ? r0(n.kcal) : null; d.protIn = n ? r0(n.prot) : null; });
  const alertList = alerts(g.trend);
  const ins = insights(g.trend, prof);
  const pl = plan(g, alertList);
  const journal = {};
  g.trend.forEach(d => { if (jr[d.date]) journal[d.date] = jr[d.date]; });
  return { alerts: alertList, insights: ins, plan: pl, journal, tags: TAGS };
}

module.exports = { TAGS, analyze, contextText, weekStats, dayNutrition, parseTime };
