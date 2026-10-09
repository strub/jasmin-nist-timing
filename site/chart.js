// Line chart over the recorded commits (x = commit position, oldest first).
//
// series:  [{ key, label, color (CSS var), points: [{ x, y, lo?, hi? }] }]
//          lo/hi draw a band (e.g. the bench quartiles) under the line.
// opts:    { xLabel(x) -> string, xTitle(x) -> string (tooltip heading),
//            yFormat(v) -> string, envMarks: [{ x, text }], onPick(x),
//            height, endLabels: bool }
// The crosshair snaps to the nearest commit and lists every visible series
// there; clicking picks that commit.

import { tip, hideTip, el, setText } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (t, at = {}) => {
  const e = document.createElementNS(NS, t);
  for (const k in at) e.setAttribute(k, at[k]);
  return e;
};

function niceTicks(lo, hi, n = 4) {
  if (lo === hi) { const d = Math.abs(lo) * 0.05 || 1; lo -= d; hi += d; }
  const span = hi - lo, raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = t0; t <= t1 + step / 2; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}

export function lineChart(host, series, opts = {}) {
  const wrap = el("div", { class: "chart" });
  host.appendChild(wrap);
  const draw = () => render(wrap, series, opts);
  draw();
  // redraw on width changes only, once per frame: a redraw may itself shift
  // the layout (e.g. a scrollbar appearing), which must not loop
  let lastW = wrap.clientWidth, queued = false;
  new ResizeObserver(() => {
    if (queued || wrap.clientWidth === lastW) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; lastW = wrap.clientWidth; draw(); });
  }).observe(wrap);
  return { redraw: draw };
}

function render(wrap, series, opts) {
  const W = Math.max(280, wrap.clientWidth || 600);
  const H = opts.height || 220;
  const vis = series.filter(s => !s.hidden && s.points.length);
  const xs = vis.flatMap(s => s.points.map(p => p.x));
  const ys = vis.flatMap(s => s.points.flatMap(p => [p.y, p.lo ?? p.y, p.hi ?? p.y]));
  // end labels only when they don't collide (else legend + tooltip carry
  // identity); decided up front, since it sets the right margin
  const M = { l: 58, r: 34, t: 14, b: 26 };
  let showEnd = false;
  if (opts.endLabels && xs.length) {
    const t = niceTicks(Math.min(...ys), Math.max(...ys));
    const yy = y => (1 - (y - t[0]) / (t[t.length - 1] - t[0] || 1)) * (H - M.t - M.b);
    const ends = vis.map(s => yy(s.points.reduce((a, b) => (b.x > a.x ? b : a)).y)).sort((a, b) => a - b);
    showEnd = !ends.some((y, i) => i && y - ends[i - 1] < 13);
    if (showEnd) M.r = Math.min(150, W * 0.22);
  }
  wrap.innerHTML = "";
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
                             "aria-label": opts.aria || "line chart" });
  wrap.appendChild(svg);
  if (!xs.length) {
    const t = svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle" });
    t.textContent = "no data";
    svg.appendChild(t);
    return;
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const px = x => x1 === x0 ? M.l + (W - M.l - M.r) / 2
                            : M.l + (x - x0) / (x1 - x0) * (W - M.l - M.r);
  const py = y => M.t + (1 - (y - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);

  // grid + y ticks
  const g = svgEl("g", { class: "grid" });
  for (const t of ticks) {
    g.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: py(t), y2: py(t) }));
    const lab = svgEl("text", { x: M.l - 8, y: py(t), "text-anchor": "end",
                                "dominant-baseline": "middle" });
    lab.textContent = (opts.yFormat || String)(t);
    g.appendChild(lab);
  }
  svg.appendChild(g);

  // x labels: first, last and a few in between, never colliding
  const allX = [...new Set(xs)].sort((a, b) => a - b);
  const maxLabels = Math.max(2, Math.floor((W - M.l - M.r) / 90));
  const stride = Math.max(1, Math.ceil(allX.length / maxLabels));
  const ax = svgEl("g", { class: "axis" });
  ax.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b }));
  // every stride-th commit plus the last one, then drop any label whose
  // text would touch the one before (the last always stays). Labels are
  // ~56px wide: centred ones need 84px between anchors, the right-aligned
  // last one 112px from a centred neighbour.
  const keep = allX.map((x, i) => i).filter(i => i % stride === 0 || i === allX.length - 1);
  const gap = i => (i === allX.length - 1 ? 112 : 84);
  const kept = [];
  for (const i of keep) {
    const far = () => !kept.length || px(allX[i]) - px(allX[kept[kept.length - 1]]) >= gap(i);
    if (i === allX.length - 1) while (kept.length > 1 && !far()) kept.pop();
    if (far()) kept.push(i);
  }
  for (const i of kept) {
    const x = allX[i];
    const anchor = allX.length > 1 && i === 0 ? "start"
                 : allX.length > 1 && i === allX.length - 1 ? "end" : "middle";
    const t = svgEl("text", { x: px(x), y: H - M.b + 15, "text-anchor": anchor });
    t.textContent = opts.xLabel ? opts.xLabel(x) : String(x);
    ax.appendChild(t);
  }
  svg.appendChild(ax);

  // environment changes
  const env = svgEl("g", { class: "env" });
  for (const m of opts.envMarks || []) {
    // a change at the first visible commit came from outside the window
    if (m.x <= x0 || m.x > x1) continue;
    const X = px(m.x - 0.5);
    env.appendChild(svgEl("line", { x1: X, x2: X, y1: M.t - 4, y2: H - M.b }));
    const t = svgEl("text", { x: X + 3, y: M.t + 4 });
    t.textContent = "env";
    env.appendChild(t);
  }
  svg.appendChild(env);

  // series: band, line, dots (dots only when sparse)
  const sparse = allX.length <= 40;
  const labels = [];
  for (const s of vis) {
    const sg = svgEl("g", { class: "series" });
    const pts = s.points.slice().sort((a, b) => a.x - b.x);
    if (pts.some(p => p.lo != null)) {
      const up = pts.map(p => `${px(p.x)},${py(p.hi ?? p.y)}`);
      const dn = pts.slice().reverse().map(p => `${px(p.x)},${py(p.lo ?? p.y)}`);
      if (pts.length > 1)
        sg.appendChild(svgEl("path", { class: "band", d: `M${up.join("L")}L${dn.join("L")}Z`,
                                       fill: s.color }));
    }
    if (pts.length > 1)
      sg.appendChild(svgEl("path", { class: "line", stroke: s.color,
        d: "M" + pts.map(p => `${px(p.x)},${py(p.y)}`).join("L") }));
    if (sparse || pts.length === 1)
      for (const p of pts)
        sg.appendChild(svgEl("circle", { cx: px(p.x), cy: py(p.y), r: 4, fill: s.color }));
    svg.appendChild(sg);
    if (showEnd) {
      const last = pts[pts.length - 1];
      labels.push({ y: py(last.y), x: px(last.x), text: s.label, color: s.color });
    }
  }

  for (const l of labels) {
    const t = svgEl("text", { x: l.x + 8, y: l.y, class: "end",
                              "dominant-baseline": "middle" });
    t.textContent = l.text;
    svg.appendChild(t);
  }

  // crosshair + readout + pick
  const xh = svgEl("line", { class: "xhair", y1: M.t, y2: H - M.b, visibility: "hidden" });
  svg.appendChild(xh);
  const hit = svgEl("rect", { class: "hit", x: M.l - 6, y: 0, width: W - M.l - M.r + 12,
                               height: H, tabindex: 0 });
  svg.appendChild(hit);
  const nearest = clientX => {
    const r = svg.getBoundingClientRect();
    const vx = (clientX - r.left) / r.width * W;
    return allX.reduce((b, x) => Math.abs(px(x) - vx) < Math.abs(px(b) - vx) ? x : b, allX[0]);
  };
  let cur = null;
  const show = (x, ev) => {
    cur = x;
    xh.setAttribute("x1", px(x)); xh.setAttribute("x2", px(x));
    xh.setAttribute("visibility", "visible");
    const rows = vis.map(s => {
      const p = s.points.find(q => q.x === x);
      return p && { color: s.color, label: s.label,
                    value: (opts.yFormat || String)(p.y) +
                      (p.lo != null && p.hi != null && p.hi !== p.lo
                        ? ` (${(opts.yFormat || String)(p.lo)}–${(opts.yFormat || String)(p.hi)})` : "") };
    }).filter(Boolean);
    const r = svg.getBoundingClientRect();
    tip(opts.xTitle ? opts.xTitle(x) : String(x), rows,
        ev ? ev.clientX : r.left + px(x) / W * r.width, ev ? ev.clientY : r.top + 20,
        opts.onPick ? "click to compare with the previous commit" : null);
  };
  const hide = () => { cur = null; xh.setAttribute("visibility", "hidden"); hideTip(); };
  hit.addEventListener("pointermove", ev => show(nearest(ev.clientX), ev));
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("blur", hide);
  hit.addEventListener("click", ev => opts.onPick && opts.onPick(nearest(ev.clientX)));
  hit.addEventListener("keydown", ev => {
    const i = allX.indexOf(cur ?? allX[allX.length - 1]);
    if (ev.key === "ArrowLeft") show(allX[Math.max(0, i - 1)]);
    else if (ev.key === "ArrowRight") show(allX[Math.min(allX.length - 1, i + 1)]);
    else if (ev.key === "Enter" && cur != null && opts.onPick) opts.onPick(cur);
    else return;
    ev.preventDefault();
  });
}

// Legend with line keys; clicking toggles a series (colors stay with the entity).
export function legend(host, series, onToggle) {
  const lg = el("div", { class: "legend" });
  for (const s of series) {
    const it = el("span", { class: "item" + (s.hidden ? " off" : ""), role: "button",
                            tabindex: 0, "aria-pressed": String(!s.hidden) });
    const key = el("span", { class: "key" });
    key.style.background = s.color;
    it.appendChild(key);
    it.appendChild(document.createTextNode(s.label));
    const toggle = () => {
      s.hidden = !s.hidden;
      it.classList.toggle("off", s.hidden);
      it.setAttribute("aria-pressed", String(!s.hidden));
      onToggle();
    };
    it.addEventListener("click", toggle);
    it.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    lg.appendChild(it);
  }
  host.appendChild(lg);
  return lg;
}

export { setText };

// Horizontal bars from a zero baseline, one per entity (e.g. backend).
// rows: [{ key, label, color, value, lo?, hi?, note? }]
//   lo/hi: spread, shown in the tooltip; note: short secondary text after
//   the value label (muted)
// opts: { format(v), tickFormat(v), aria, title }
export function barsH(host, rows, opts = {}) {
  const wrap = el("div", { class: "chart" });
  host.appendChild(wrap);
  const draw = () => renderBars(wrap, rows, opts);
  draw();
  let lastW = wrap.clientWidth, queued = false;
  new ResizeObserver(() => {
    if (queued || wrap.clientWidth === lastW) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; lastW = wrap.clientWidth; draw(); });
  }).observe(wrap);
  return { redraw: draw };
}

function renderBars(wrap, rows, opts) {
  const vis = rows.filter(r => !r.hidden && r.value != null);
  const W = Math.max(240, wrap.clientWidth || 320);
  const BAR = 18, GAP = 10;
  const fmt = opts.format || String;
  wrap.innerHTML = "";
  const labW = Math.min(104, W * 0.32);
  // values and notes in aligned columns right of the plot, clear of the grid
  const VAL = 46, NOTE = vis.some(r => r.note) ? 42 : 0, COLGAP = 10;
  const M = { l: labW, r: COLGAP + VAL + (NOTE ? 6 + NOTE : 0), t: 4, b: 20 };
  const xVal = W - (NOTE ? 6 + NOTE : 0), xNote = W;
  const H = M.t + M.b + vis.length * (BAR + GAP) - (vis.length ? GAP : 0);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${Math.max(H, 40)}`, role: "img",
                             "aria-label": opts.aria || "bar chart" });
  wrap.appendChild(svg);
  if (!vis.length) {
    const t = svgEl("text", { x: W / 2, y: 22, "text-anchor": "middle" });
    t.textContent = "no data";
    svg.appendChild(t);
    return;
  }
  const max = Math.max(...vis.map(r => r.hi ?? r.value));
  const ticks = niceTicks(0, max, 3);
  const top = ticks[ticks.length - 1];
  const px = v => M.l + v / top * (W - M.l - M.r);
  const g = svgEl("g", { class: "grid" });
  for (const t of ticks) {
    g.appendChild(svgEl("line", { x1: px(t), x2: px(t), y1: M.t, y2: H - M.b }));
    const lab = svgEl("text", { x: px(t), y: H - M.b + 14, "text-anchor": t ? "middle" : "start" });
    lab.textContent = (opts.tickFormat || fmt)(t);
    g.appendChild(lab);
  }
  svg.appendChild(g);
  vis.forEach((r, i) => {
    const y = M.t + i * (BAR + GAP);
    const name = svgEl("text", { x: M.l - 8, y: y + BAR / 2, "text-anchor": "end",
                                 "dominant-baseline": "middle", class: "end" });
    name.textContent = r.label;
    svg.appendChild(name);
    // 4px rounded data end, square at the baseline
    const x0 = px(0), x1 = Math.max(x0 + 1, px(r.value)), rad = Math.min(4, (x1 - x0) / 2);
    svg.appendChild(svgEl("path", { fill: r.color, class: "bar",
      d: `M${x0},${y}H${x1 - rad}Q${x1},${y} ${x1},${y + rad}V${y + BAR - rad}Q${x1},${y + BAR} ${x1 - rad},${y + BAR}H${x0}Z` }));
    const val = svgEl("text", { x: xVal, y: y + BAR / 2, "dominant-baseline": "middle",
                                "text-anchor": "end", class: "end" });
    val.textContent = fmt(r.value);
    svg.appendChild(val);
    if (r.note) {
      const nt = svgEl("text", { x: xNote, y: y + BAR / 2, "dominant-baseline": "middle",
                                 "text-anchor": "end", class: "end note" });
      nt.textContent = r.note;
      svg.appendChild(nt);
    }
    const hit = svgEl("rect", { class: "hit", x: 0, y: y - GAP / 2, width: W, height: BAR + GAP, tabindex: 0,
                                style: "cursor:default" });
    const show = ev => {
      const rr = svg.getBoundingClientRect();
      const rows2 = [{ color: r.color, label: r.label, value: fmt(r.value) }];
      if (r.lo != null && r.hi != null) rows2.push({ label: "quartiles of the passes", value: `${fmt(r.lo)}–${fmt(r.hi)}` });
      if (r.note) rows2.push({ label: "", value: r.note });
      tip(opts.title || "", rows2, ev ? ev.clientX : rr.left + px(r.value) / W * rr.width,
          ev ? ev.clientY : rr.top + (y + BAR) / Math.max(H, 40) * rr.height);
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("focus", () => show());
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("blur", hideTip);
    svg.appendChild(hit);
  });
}
