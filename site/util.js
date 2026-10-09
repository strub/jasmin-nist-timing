// DOM, tooltip and formatting helpers. Every string that comes from data
// (paths, subjects, names) goes through textContent, never innerHTML.

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
export const setText = (e, s) => { e.textContent = s; return e; };

const tipEl = () => document.getElementById("tip");
export function tip(title, rows, x, y, foot) {
  const t = tipEl();
  t.replaceChildren();
  t.appendChild(el("div", { class: "t", text: title }));
  for (const r of rows) {
    const row = el("div", { class: "r" });
    if (r.color) { const k = el("span", { class: "key" }); k.style.background = r.color; row.append(k); }
    row.append(el("span", { class: "v", text: r.value }), el("span", { class: "l", text: r.label }));
    t.appendChild(row);
  }
  if (foot) t.appendChild(el("div", { class: "t", text: foot, style: "margin:6px 0 0" }));
  t.style.display = "block";
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, x + 14)) + "px";
  t.style.top = Math.max(8, Math.min(innerHeight - h - 8, y + 14)) + "px";
}
export const hideTip = () => { tipEl().style.display = "none"; };

export const short = sha => sha.slice(0, 8);
export const day = iso => (iso || "").slice(0, 10);
export const cycles = v => Math.round(v).toLocaleString("en-US");
export function kcycles(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + "k";
  return String(Math.round(v));
}
// axis ticks: round values without decimals (25k, 1.5M)
export function kround(v) {
  if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
export function dur(s) {
  if (s >= 3600) return (s / 3600).toFixed(2) + " h";
  if (s >= 60) return (s / 60).toFixed(1) + " min";
  return s.toFixed(1) + " s";
}
export const minutes = s => (s / 60).toFixed(s >= 600 ? 0 : 1);

// A change between a and b where lower is better. verdict: "better",
// "worse" or "same" (within noise); rendered as icon + signed % + word.
export function delta(a, b, significant) {
  const pct = a ? (b - a) / a : 0;
  const verdict = !significant ? "same" : pct < 0 ? "better" : "worse";
  return { pct, verdict };
}
export function deltaEl({ pct, verdict }, abs) {
  const icon = verdict === "better" ? "▼" : verdict === "worse" ? "▲" : "≈";
  const word = verdict === "better" ? "faster" : verdict === "worse" ? "slower" : "noise";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "±";
  const p = Math.abs(pct * 100);
  const txt = `${icon} ${sign}${p.toFixed(p < 10 ? 1 : 0)}%` +
              (abs ? ` (${abs})` : "");
  return el("span", { class: `d ${verdict}`, title: word, text: txt + " " + word });
}
