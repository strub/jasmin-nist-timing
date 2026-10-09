// jasmin-nist results dashboard: timeline, commit and compare views over
// index.json (built by tools/build_index.py) and the per-commit result files.
//
// Routes (all in the URL fragment, so every view is a shareable link):
//   #/  or  #/results/<sha>  one commit's results (latest by default; ?zoom=dir/sub)
//   #/trends                 timelines             (?scheme=ML-KEM-768)
//   #/compare/<a>..<b>       b against a           (?zoom=dir/sub)
//   #/compare/<b>            b against the commit recorded just before it
// (#/commit/<sha> is kept as an alias of #/results/<sha>.)
// Commit ids may be abbreviated.

import { el, short, day, dur, minutes, cycles, kcycles, delta, deltaEl } from "./util.js";
import { lineChart, legend, barsH } from "./chart.js";
import { sunburst } from "./sunburst.js";

const REPO = "https://github.com/strub/jasmin-nist";
const view = document.getElementById("view");

// Noise thresholds. Proof times come from a single run each, so a change
// must be both large and relative; bench changes must clear the measured
// spread (quartiles of the passes must not overlap) and a floor.
const NOISE = {
  proofsTotal: 0.03,                  // total time: >= 3%
  proofsDir: { pct: 0.05, abs: 10 },  // per directory: >= 5% and >= 10 s
  proofsFile: { pct: 0.10, abs: 2 },  // per file: >= 10% and >= 2 s
  bench: 0.005,                       // bench: quartiles apart and >= 0.5%
};

// Fixed categorical slot per entity (never by rank).
const BACKEND_SLOT = { "jasmin": 1, "mlkem-native": 2, "mldsa-native": 2,
                       "pqcrystals": 3, "pqcrystals-ref": 4 };
const backendColor = b => `var(--s${BACKEND_SLOT[b] || 5})`;
const BACKEND_ORDER = ["jasmin", "mlkem-native", "mldsa-native", "pqcrystals", "pqcrystals-ref"];
const byBackend = (a, b) => (BACKEND_ORDER.indexOf(a) + 1 || 99) - (BACKEND_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b);
const OPS = { KEM: ["keypair", "encaps", "decaps"], SIG: ["keygen", "sign", "verify"] };

let INDEX = null, COMMITS = [], POS = new Map();
const cache = new Map();
const benchHidden = new Map();   // runner -> Set of hidden backends
const fetchJSON = url => {
  if (!cache.has(url)) cache.set(url, fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`))));
  return cache.get(url);
};
const proofsFile = sha => fetchJSON(`data/proofs/${sha}.json`);

function resolve(id) {
  if (!id) return null;
  const hits = COMMITS.filter(c => c.commit.startsWith(id.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}
const prevOf = (c, has) => { for (let i = POS.get(c.commit) - 1; i >= 0; i--) if (!has || has(COMMITS[i])) return COMMITS[i]; return null; };
const nextOf = (c, has) => { for (let i = POS.get(c.commit) + 1; i < COMMITS.length; i++) if (!has || has(COMMITS[i])) return COMMITS[i]; return null; };
const label = c => `${short(c.commit)} · ${day(c.commit_date)} · ${c.subject || ""}`;
const xTitle = x => COMMITS[x] ? label(COMMITS[x]) : "";

// environment fingerprints: a change draws a marker and a compare notice
const proofsEnv = c => c.proofs && {
  arch: c.proofs.machine?.arch, cpus: c.proofs.machine?.cpus, jobs: c.proofs.machine?.jobs,
  easycrypt: c.proofs.tools?.easycrypt, z3: c.proofs.tools?.z3, cvc5: c.proofs.tools?.cvc5 };
const benchEnv = (c, r) => c.bench?.[r] && { ...c.bench[r].env, reps: c.bench[r].reps, iters: c.bench[r].iters };
function envDiff(a, b) {
  if (!a || !b) return [];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(k => String(a[k] ?? "") !== String(b[k] ?? ""))
    .map(k => ({ key: k, a: a[k] ?? "—", b: b[k] ?? "—" }));
}
function envMarks(has, env) {
  const marks = [];
  let prev = null;
  COMMITS.forEach((c, i) => {
    if (!has(c)) return;
    const e = env(c);
    if (prev && envDiff(prev, e).length) marks.push({ x: i });
    prev = e;
  });
  return marks;
}

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const [path, q] = h.split("?");
  const params = new URLSearchParams(q || "");
  return { parts: path.split("/").filter(Boolean), params };
}
function setParam(k, v) {
  const { parts, params } = parseHash();
  if (v) params.set(k, v); else params.delete(k);
  const qs = params.toString();
  history.replaceState(null, "", `#/${parts.join("/")}${qs ? "?" + qs : ""}`);
}
const go = hash => { location.hash = hash; };

function nav(active) {
  for (const a of document.querySelectorAll("header nav a"))
    a.classList.toggle("on", a.dataset.v === active);
}

// Commit picker: shows the current commit; opens a search over every
// recorded commit (hash prefix, subject words, date; all terms must match),
// newest first, a bounded list so the history can grow without limit.
function commitPicker(cur, onPick, aria) {
  const box = el("div", { class: "cpick" });
  const btn = el("button", { class: "cur", "aria-haspopup": "listbox", "aria-label": aria,
                             "aria-expanded": "false", text: label(cur) });
  const panel = el("div", { class: "panel", hidden: "" });
  const q = el("input", { type: "search", placeholder: "Search hash, subject or date (e.g. ntt 2026-10)",
                          "aria-label": `${aria}: search`, autocomplete: "off", spellcheck: "false" });
  const list = el("div", { class: "list", role: "listbox" });
  const more = el("div", { class: "more" });
  panel.append(q, list, more);
  box.append(btn, panel);
  const SHOW = 30, RECENT = 20;
  let hits = [], active = 0;
  const hay = c => `${c.commit} ${day(c.commit_date)} ${c.subject || ""}`.toLowerCase();
  const refresh = () => {
    const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = COMMITS.slice().reverse().filter(c => terms.every(t => hay(c).includes(t)));
    hits = all.slice(0, terms.length ? SHOW : RECENT);
    active = Math.max(0, hits.indexOf(cur));
    list.replaceChildren(...hits.map((c, i) => {
      const it = el("div", { class: "it" + (i === active ? " on" : "") + (c === cur ? " sel" : ""),
                             role: "option", "aria-selected": String(c === cur) },
        el("span", { class: "mono", text: short(c.commit) }), el("span", { class: "muted", text: day(c.commit_date) }),
        el("span", { class: "subj", text: c.subject || "" }));
      it.addEventListener("pointerdown", ev => { ev.preventDefault(); pick(c); });
      return it;
    }));
    const rest = all.length - hits.length;
    more.textContent = !all.length ? "No match." : rest > 0
      ? `${rest} more ${terms.length ? "matches: refine the search" : "older commits: search to find them"}` : "";
  };
  const mark = () => [...list.children].forEach((e, i) => {
    e.classList.toggle("on", i === active);
    if (i === active) e.scrollIntoView({ block: "nearest" });
  });
  const open = () => {
    panel.hidden = false; btn.setAttribute("aria-expanded", "true");
    q.value = ""; refresh(); q.focus();
    setTimeout(() => document.addEventListener("pointerdown", outside), 0);
  };
  const close = () => {
    panel.hidden = true; btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside);
  };
  const outside = ev => { if (!box.contains(ev.target)) close(); };
  const pick = c => { close(); if (c && c !== cur) onPick(c); };
  btn.addEventListener("click", () => panel.hidden ? open() : close());
  q.addEventListener("input", refresh);
  q.addEventListener("keydown", ev => {
    if (ev.key === "ArrowDown") active = Math.min(hits.length - 1, active + 1);
    else if (ev.key === "ArrowUp") active = Math.max(0, active - 1);
    else if (ev.key === "Enter") return pick(hits[active]);
    else if (ev.key === "Escape") { close(); return btn.focus(); }
    else return;
    ev.preventDefault(); mark();
  });
  return box;
}

// ---------------------------------------------------------------- timeline
// Trends window: the last N recorded commits (?range=30|100|300|all).
const RANGES = [30, 100, 300];
const DEFAULT_RANGE = 100;
function rangeStart(params) {
  const r = params.get("range");
  if (r === "all") return 0;
  const n = RANGES.includes(+r) ? +r : DEFAULT_RANGE;
  return Math.max(0, COMMITS.length - n);
}

function rangeBar(params) {
  const cur = params.get("range") === "all" ? "all"
            : RANGES.includes(+params.get("range")) ? params.get("range") : String(DEFAULT_RANGE);
  const opts = RANGES.filter(n => n < COMMITS.length).map(String).concat("all");
  const bar = el("div", { class: "row card", style: "padding:10px 14px" },
                 el("span", { class: "muted", text: "Commits shown:" }));
  for (const o of opts) {
    const on = o === cur || (o === "all" && +cur >= COMMITS.length);
    const b = el("button", { class: on ? "on" : "", "aria-pressed": String(on),
                             text: o === "all" ? `all ${COMMITS.length}` : `last ${o}` });
    b.addEventListener("click", () => {
      setParam("range", o);
      const y = scrollY;               // keep the reader's place
      timeline(parseHash().params);
      scrollTo(0, y);
    });
    bar.append(b);
  }
  return bar;
}

function timeline(params) {
  nav("trends");
  view.replaceChildren();
  if (!COMMITS.length) { view.append(el("div", { class: "card empty", text: "No results recorded yet." })); return; }
  if (COMMITS.length > RANGES[0]) view.append(rangeBar(params));
  const start = rangeStart(params);

  for (const runner of INDEX.bench_runners) view.append(benchCard(runner, params, start));

  // proofs
  const pc = COMMITS.map((c, i) => [c, i]).filter(([c, i]) => c.proofs && i >= start);
  const card = el("div", { class: "card" });
  view.append(card);
  card.append(el("h2", { text: "Proof checking" }),
              el("p", { class: "sub", text: "Cumulative EasyCrypt checking time per commit (sum over files, minutes). " +
                "Dashed lines mark a change of machine or tool versions. Click a commit to compare it with the previous one." }));
  if (!pc.length) card.append(el("div", { class: "empty", text: "No proof timings yet." }));
  else {
    const marks = envMarks(c => c.proofs, proofsEnv);
    const pick = x => go(`#/compare/${COMMITS[x].commit}`);
    const common = { xLabel: x => short(COMMITS[x].commit), xTitle, envMarks: marks, onPick: pick };
    const pair = el("div", { class: "grid2" });
    const left = el("div"), right = el("div");
    pair.append(left, right);
    card.append(pair);
    left.append(el("h3", { text: "Total", style: "margin-top:4px" }));
    lineChart(left, [{ key: "total", label: "total", color: "var(--s1)",
      points: pc.map(([c, i]) => ({ x: i, y: c.proofs.total_seconds / 60 })) }],
      { ...common, yFormat: v => `${+v.toFixed(1)} min`, height: 170, aria: "total proof-checking time per commit" });
    const dirs = [...new Set(pc.flatMap(([c]) => Object.keys(c.proofs.groups || {})))].sort();
    const series = dirs.map((d, k) => ({ key: d, label: d, color: `var(--s${k % 8 + 1})`,
      points: pc.filter(([c]) => c.proofs.groups?.[d] != null).map(([c, i]) => ({ x: i, y: c.proofs.groups[d] / 60 })) }));
    right.append(el("h3", { text: "By top-level directory", style: "margin-top:4px" }));
    const host = el("div");
    let chart;
    legend(right, series, () => chart.redraw());
    right.append(host);
    chart = lineChart(host, series, { ...common, yFormat: v => `${+v.toFixed(1)} min`, endLabels: true,
                                      height: 170, aria: "proof-checking time per directory per commit" });
    const tb = el("tbody");
    for (const [c] of pc.slice().reverse()) {
      tb.append(el("tr", {}, el("td", {}, el("a", { href: `#/results/${c.commit}`, class: "mono", text: short(c.commit) })),
        el("td", { text: day(c.commit_date) }), el("td", { class: "num", text: minutes(c.proofs.total_seconds) }),
        ...dirs.map(d => el("td", { class: "num", text: c.proofs.groups?.[d] != null ? minutes(c.proofs.groups[d]) : "" }))));
    }
    card.append(el("details", {}, el("summary", { text: "Table view (minutes)" }),
      el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {},
        el("th", { text: "commit" }), el("th", { text: "date" }), el("th", { class: "num", text: "total" }),
        ...dirs.map(d => el("th", { class: "num", text: d })))), tb))));
  }
}

function benchCard(runner, params, start = 0) {
  const bc = COMMITS.map((c, i) => [c, i]).filter(([c, i]) => c.bench?.[runner] && i >= start);
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: `Benchmarks · ${runner}` }),
              el("p", { class: "sub", text: "Median cycles per operation (median over the passes); the band spans the " +
                "passes' quartiles. Click a legend entry to hide a backend; click a commit to compare it with the previous one." }));
  if (!bc.length) { card.append(el("div", { class: "empty", text: "No benchmarks yet." })); return card; }
  const keys = new Set(bc.flatMap(([c]) => Object.keys(c.bench[runner].m)));
  const schemes = [...new Set([...keys].map(k => k.split("|")[0]))].sort();
  const withJasmin = schemes.filter(s => keys.has(`${s}|jasmin|keypair`) || keys.has(`${s}|jasmin|keygen`));
  const scheme = schemes.includes(params.get("scheme")) ? params.get("scheme") : (withJasmin[0] || schemes[0]);
  const bar = el("div", { class: "row", style: "margin-bottom:6px" });
  for (const s of schemes) {
    const b = el("button", { class: s === scheme ? "on" : "", text: s, "aria-pressed": String(s === scheme) });
    // rebuild this card only: re-rendering the page would scroll to the top
    b.addEventListener("click", () => { setParam("scheme", s); card.replaceWith(benchCard(runner, parseHash().params, start)); });
    bar.append(b);
  }
  card.append(bar);
  const backends = [...new Set([...keys].filter(k => k.startsWith(scheme + "|")).map(k => k.split("|")[1]))].sort(byBackend);
  const ops = [...new Set([...keys].filter(k => k.startsWith(scheme + "|")).map(k => k.split("|")[2]))];
  const opOrder = (ops.includes("keypair") ? OPS.KEM : OPS.SIG).filter(o => ops.includes(o));
  // hidden backends persist across scheme switches (pqcrystals-ref off by default)
  if (!benchHidden.has(runner)) benchHidden.set(runner, new Set(["pqcrystals-ref"]));
  const hid = benchHidden.get(runner);
  const shared = backends.map(b => {
    const ser = { key: b, label: b, color: backendColor(b) };
    Object.defineProperty(ser, "hidden", { get: () => hid.has(b),
      set: v => { if (v) hid.add(b); else hid.delete(b); } });
    return ser;
  });
  const marks = envMarks(c => c.bench?.[runner], c => benchEnv(c, runner));
  const charts = [];
  legend(card, shared, () => charts.forEach(ch => ch.redraw()));
  const grid = el("div", { class: "grid3" });
  card.append(grid);
  for (const op of opOrder) {
    const cell = el("div");
    grid.append(cell);
    cell.append(el("h3", { text: op, style: "margin-top:4px" }));
    const series = shared.map(s => {
      const ser = { key: s.key, label: s.label, color: s.color, points: bc.filter(([c]) => c.bench[runner].m[`${scheme}|${s.key}|${op}`])
        .map(([c, i]) => { const [m, lo, hi] = c.bench[runner].m[`${scheme}|${s.key}|${op}`]; return { x: i, y: m, lo, hi }; }) };
      Object.defineProperty(ser, "hidden", { get: () => s.hidden });
      return ser;
    });
    charts.push(lineChart(cell, series, { xLabel: x => short(COMMITS[x].commit), xTitle, envMarks: marks,
      yFormat: kcycles, height: 190, onPick: x => go(`#/compare/${COMMITS[x].commit}`),
      aria: `${scheme} ${op} cycles per commit` }));
  }
  const last = bc[bc.length - 1][0];
  const tb = el("tbody");
  for (const b of backends) tb.append(el("tr", {}, el("td", { text: b }),
    ...opOrder.map(op => { const v = last.bench[runner].m[`${scheme}|${b}|${op}`]; return el("td", { class: "num", text: v ? cycles(v[0]) : "" }); })));
  card.append(el("details", {}, el("summary", { text: `Table view: ${scheme} at the latest commit (${short(last.commit)})` }),
    el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { text: "backend" }),
      ...opOrder.map(o => el("th", { class: "num", text: o })))), tb))));
  return card;
}

// ---------------------------------------------------------------- commit
async function commitView(c, params) {
  nav("results");
  view.replaceChildren();
  const head = el("div", { class: "card" });
  view.append(head);
  head.append(el("h2", { text: c.subject || short(c.commit) }),
    el("p", { class: "sub" }, el("span", { class: "mono", text: c.commit }), ` · ${day(c.commit_date)} · `,
       el("a", { href: `${REPO}/commit/${c.commit}`, text: "commit" }),
       c.proofs?.run_id ? " · " : null, c.proofs?.run_id ? el("a", { href: `${REPO}/actions/runs/${c.proofs.run_id}`, text: "proofs run" }) : null));
  const bar = el("div", { class: "row" });
  const cp = commitPicker(c, x => go(`#/results/${x.commit}`), "commit");
  cp.style.flex = "1 1 320px";
  bar.append(cp);
  const p = prevOf(c), n = nextOf(c);
  const bp = el("button", { text: "◀ older" }); bp.disabled = !p; bp.addEventListener("click", () => go(`#/results/${p.commit}`));
  const bn = el("button", { text: "newer ▶" }); bn.disabled = !n; bn.addEventListener("click", () => go(`#/results/${n.commit}`));
  const bc = el("button", { text: "compare with previous" }); bc.disabled = !p; bc.addEventListener("click", () => go(`#/compare/${c.commit}`));
  bar.append(bp, bn, bc);
  head.append(bar);

  for (const runner of INDEX.bench_runners) {
    const b = c.bench?.[runner];
    if (!b) continue;
    const card = el("div", { class: "card" });
    view.append(card);
    card.append(el("h2", { text: `Benchmarks · ${runner}` }),
      el("p", { class: "sub", text: `Median cycles, ${b.reps || 1} passes × ${b.iters || "?"} iterations; ± half the passes' interquartile range. ` +
        Object.entries(b.env || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") }));
    card.append(benchBars(runner, b.m));
  }
  if (c.proofs) {
    const card = el("div", { class: "card" });
    view.append(card);
    const m = c.proofs.machine || {}, t = c.proofs.tools || {};
    card.append(el("h2", { text: "Proof checking" }),
      el("p", { class: "sub", text: `${c.proofs.files} files · ${dur(c.proofs.total_seconds)} cumulative · ` +
        `${m.arch || "?"}, ${m.cpus || "?"} CPUs, ${m.jobs || "?"} jobs · EasyCrypt ${short(t.easycrypt || "?")} · ${t.z3 || ""} · ${t.cvc5 || ""}` }));
    const host = el("div");
    card.append(host);
    try {
      const d = await proofsFile(c.commit);
      sunburst(host, d.files, { zoom: params.get("zoom"), onZoom: z => setParam("zoom", z) });
      const rows = d.files.slice().sort((a, b) => b.seconds - a.seconds);
      card.append(fileTable(rows.map(f => [f.path, dur(f.seconds), `${(100 * f.seconds / c.proofs.total_seconds).toFixed(2)}%`]),
                            ["file", "time", "share"], "All files as a table"));
    } catch (e) { host.append(el("div", { class: "empty", text: String(e) })); }
  }
}

function fileTable(rows, head, summary, limit) {
  const tb = el("tbody");
  const shown = limit ? rows.slice(0, limit) : rows;
  // a row's node cells may also appear in another table: insert copies
  for (const r of shown) tb.append(el("tr", {}, ...r.map((v, i) => v instanceof Node ? el("td", { class: "num" }, v.cloneNode(true))
    : el("td", { class: i ? "num" : "mono", text: v }))));
  const tbl = el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {},
    ...head.map((h, i) => el("th", { class: i ? "num" : "", text: h })))), tb));
  if (!summary) return tbl;
  return el("details", {}, el("summary", { text: summary }), tbl);
}

// bench tables per scheme; with `base`, a comparison (base -> m)
function benchTables(m, base, { schemes: only = null, heading = true } = {}) {
  const wrap = el("div");
  const schemes = only || [...new Set(Object.keys(m).map(k => k.split("|")[0]))].sort();
  for (const s of schemes) {
    const ks = Object.keys(m).filter(k => k.startsWith(s + "|"));
    const backends = [...new Set(ks.map(k => k.split("|")[1]))].sort(byBackend);
    const ops0 = [...new Set(ks.map(k => k.split("|")[2]))];
    const ops = (ops0.includes("keypair") ? OPS.KEM : OPS.SIG).filter(o => ops0.includes(o));
    const tb = el("tbody");
    for (const b of backends) {
      const cells = [];
      for (const op of ops) {
        const v = m[`${s}|${b}|${op}`];
        if (!v) { cells.push(el("td")); continue; }
        if (!base) {
          const half = v[0] ? (v[2] - v[1]) / 2 / v[0] : 0;
          cells.push(el("td", { class: "num", text: `${cycles(v[0])} ±${(100 * half).toFixed(1)}%` }));
        } else {
          const a = base[`${s}|${b}|${op}`];
          if (!a) { cells.push(el("td", { class: "num", text: `${cycles(v[0])} (new)` })); continue; }
          const sig = (v[1] > a[2] || v[2] < a[1]) && Math.abs(v[0] - a[0]) / a[0] >= NOISE.bench;
          cells.push(el("td", { class: "num" }, el("div", { text: `${cycles(a[0])} → ${cycles(v[0])}` }),
                                 deltaEl(delta(a[0], v[0], sig))));
        }
      }
      tb.append(el("tr", {}, el("td", { text: b }), ...cells));
    }
    if (heading) wrap.append(el("h3", { text: s }));
    wrap.append(el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {},
      el("th", { text: "backend" }), ...ops.map(o => el("th", { class: "num", text: o })))), tb)));
  }
  return wrap;
}

// One commit's benchmarks: per scheme, one bar chart per operation (a bar
// per backend, zero baseline, whisker = the passes' quartiles, label =
// cycles and ratio to jasmin), and the scheme's table folded underneath.
function benchBars(runner, m) {
  const wrap = el("div");
  // schemes with a jasmin implementation first (the one under study)
  const hasJasmin = s => Object.keys(m).some(k => k.startsWith(`${s}|jasmin|`));
  const schemes = [...new Set(Object.keys(m).map(k => k.split("|")[0]))]
    .sort((a, b) => (hasJasmin(b) - hasJasmin(a)) || a.localeCompare(b));
  const backends = [...new Set(Object.keys(m).map(k => k.split("|")[1]))].sort(byBackend);
  if (!benchHidden.has(runner)) benchHidden.set(runner, new Set(["pqcrystals-ref"]));
  const hid = benchHidden.get(runner);
  const shared = backends.map(b => {
    const ser = { key: b, label: b, color: backendColor(b) };
    Object.defineProperty(ser, "hidden", { get: () => hid.has(b), set: v => { if (v) hid.add(b); else hid.delete(b); } });
    return ser;
  });
  const charts = [];
  legend(wrap, shared, () => charts.forEach(c => c.redraw()));
  for (const s of schemes) {
    const ks = Object.keys(m).filter(k => k.startsWith(s + "|"));
    const ops0 = [...new Set(ks.map(k => k.split("|")[2]))];
    const ops = (ops0.includes("keypair") ? OPS.KEM : OPS.SIG).filter(o => ops0.includes(o));
    wrap.append(el("h3", { text: s }));
    const grid = el("div", { class: "grid3" });
    wrap.append(grid);
    for (const op of ops) {
      const cell = el("div");
      grid.append(cell);
      cell.append(el("div", { class: "muted", style: "font-size:12px;margin:2px 0 2px", text: op }));
      const jas = m[`${s}|jasmin|${op}`];
      const rows = shared.filter(b => m[`${s}|${b.key}|${op}`]).map(b => {
        const [v, lo, hi] = m[`${s}|${b.key}|${op}`];
        const r = { key: b.key, label: b.label, color: b.color, value: v, lo, hi,
                    note: jas && b.key !== "jasmin" ? `${(v / jas[0]).toFixed(2)}× jasmin` : null };
        Object.defineProperty(r, "hidden", { get: () => b.hidden });
        return r;
      });
      charts.push(barsH(cell, rows, { format: kcycles, title: `${s} ${op} · median cycles`,
                                      aria: `${s} ${op}: median cycles per backend` }));
    }
    wrap.append(el("details", {}, el("summary", { text: `Table view: ${s}` }),
                   benchTables(m, null, { schemes: [s], heading: false })));
  }
  return wrap;
}

// ---------------------------------------------------------------- compare
async function compareView(a, b, params) {
  nav("compare");
  view.replaceChildren();
  const head = el("div", { class: "card" });
  view.append(head);
  head.append(el("h2", { text: "Compare" }),
    el("p", { class: "sub", text: "B against A. Lower is better: ▼ faster, ▲ slower, ≈ within noise " +
      `(proofs: total ±${NOISE.proofsTotal * 100}%, files ±${NOISE.proofsFile.pct * 100}% and ${NOISE.proofsFile.abs} s; ` +
      `bench: quartiles overlap or under ${NOISE.bench * 100}%).` }));
  const picker = (lab, cur, other, setTo) => {
    const row = el("div", { class: "pick" });
    const sel = commitPicker(cur, setTo, `commit ${lab}`);
    const p = prevOf(cur), n = nextOf(cur);
    const bp = el("button", { text: "◀", title: "older", "aria-label": `${lab}: older commit` }); bp.disabled = !p;
    bp.addEventListener("click", () => setTo(p));
    const bn = el("button", { text: "▶", title: "newer", "aria-label": `${lab}: newer commit` }); bn.disabled = !n;
    bn.addEventListener("click", () => setTo(n));
    row.append(el("span", { class: "lab", text: lab }), sel, bp, bn);
    return row;
  };
  const route = (x, y) => go(`#/compare/${x.commit}..${y.commit}`);
  head.append(picker("A", a, b, c => route(c, b)), el("div", { style: "height:6px" }), picker("B", b, a, c => route(a, c)));
  const steps = el("div", { class: "row", style: "margin-top:8px" });
  const pa = prevOf(a), pb = prevOf(b), na = nextOf(a), nb = nextOf(b);
  const s1 = el("button", { text: "◀ step both older" }); s1.disabled = !(pa && pb);
  s1.addEventListener("click", () => route(pa, pb));
  const s2 = el("button", { text: "step both newer ▶" }); s2.disabled = !(na && nb);
  s2.addEventListener("click", () => route(na, nb));
  const sw = el("button", { text: "swap A ↔ B" }); sw.addEventListener("click", () => route(b, a));
  steps.append(s1, s2, sw, el("a", { href: `${REPO}/compare/${a.commit}...${b.commit}`, class: "muted", style: "margin-left:auto", text: "code diff on GitHub" }));
  head.append(steps);
  if (a === b) head.append(el("div", { class: "notice", text: "A and B are the same commit." }));

  const envNotice = (diffs, what) => {
    if (!diffs.length) return null;
    return el("div", { class: "notice" }, el("strong", { text: `${what}: the environment differs between A and B` }),
      " — changes may come from it rather than from the code.",
      el("ul", {}, ...diffs.map(d => el("li", {}, el("span", { text: `${d.key}: ` }), el("span", { class: "mono", text: `${d.a} → ${d.b}` })))));
  };

  // bench
  for (const runner of INDEX.bench_runners) {
    const card = el("div", { class: "card" });
    view.append(card);
    card.append(el("h2", { text: `Benchmarks · ${runner}` }));
    const ba = a.bench?.[runner], bb = b.bench?.[runner];
    if (!ba || !bb) { card.append(el("div", { class: "empty", text: `No benchmark for ${!ba ? "A" : "B"} on this machine.` })); continue; }
    const n = envNotice(envDiff(benchEnv(a, runner), benchEnv(b, runner)), "Bench");
    if (n) card.append(n);
    let better = 0, worse = 0;
    for (const k of Object.keys(bb.m)) {
      const x = ba.m[k], y = bb.m[k];
      if (!x) continue;
      const sig = (y[1] > x[2] || y[2] < x[1]) && Math.abs(y[0] - x[0]) / x[0] >= NOISE.bench;
      if (sig) y[0] < x[0] ? better++ : worse++;
    }
    card.append(el("p", { class: "sub", text: `${better} faster, ${worse} slower, ${Object.keys(bb.m).length - better - worse} unchanged ` +
      `(of ${Object.keys(bb.m).length} measurements). Cells: A → B median cycles.` }));
    card.append(benchTables(bb.m, ba.m));
  }

  // proofs
  const card = el("div", { class: "card" });
  view.append(card);
  card.append(el("h2", { text: "Proof checking" }));
  if (!a.proofs || !b.proofs) card.append(el("div", { class: "empty", text: `No proof timings for ${!a.proofs ? "A" : "B"}.` }));
  else {
    const n = envNotice(envDiff(proofsEnv(a), proofsEnv(b)), "Proofs");
    if (n) card.append(n);
    const ta = a.proofs.total_seconds, tbv = b.proofs.total_seconds;
    const dt = delta(ta, tbv, Math.abs(tbv - ta) / ta >= NOISE.proofsTotal);
    card.append(el("div", { class: "tiles", style: "margin-top:10px" },
      el("div", { class: "tile" }, el("div", { class: "k", text: "A total" }), el("div", { class: "v", text: dur(ta) }),
         el("div", { class: "s muted", text: `${a.proofs.files} files` })),
      el("div", { class: "tile" }, el("div", { class: "k", text: "B total" }), el("div", { class: "v", text: dur(tbv) }),
         el("div", { class: "s muted", text: `${b.proofs.files} files` })),
      el("div", { class: "tile" }, el("div", { class: "k", text: "change" }), el("div", { class: "v" }, deltaEl(dt)),
         el("div", { class: "s muted", text: `${tbv >= ta ? "+" : "−"}${dur(Math.abs(tbv - ta))}` }))));
    const dirs = [...new Set([...Object.keys(a.proofs.groups || {}), ...Object.keys(b.proofs.groups || {})])].sort();
    const drows = dirs.map(d => {
      const x = a.proofs.groups?.[d], y = b.proofs.groups?.[d];
      if (x == null || y == null) return [d, x == null ? "—" : dur(x), y == null ? "—" : dur(y), el("span", { class: "muted", text: x == null ? "new" : "removed" })];
      const sig = Math.abs(y - x) >= NOISE.proofsDir.abs && Math.abs(y - x) / x >= NOISE.proofsDir.pct;
      return [d, dur(x), dur(y), deltaEl(delta(x, y, sig))];
    });
    card.append(el("h3", { text: "By top-level directory" }), fileTable(drows, ["directory", "A", "B", "change"]));
    const host = el("div");
    card.append(el("h3", { text: "B by file, colored by change against A" }), host);
    try {
      const [fa, fb] = await Promise.all([proofsFile(a.commit), proofsFile(b.commit)]);
      sunburst(host, fb.files, { base: fa.files, zoom: params.get("zoom"), onZoom: z => setParam("zoom", z) });
      const am = new Map(fa.files.map(f => [f.path, f.seconds]));
      const bm = new Map(fb.files.map(f => [f.path, f.seconds]));
      const paths = [...new Set([...am.keys(), ...bm.keys()])];
      const rows = paths.map(p => {
        const x = am.get(p), y = bm.get(p);
        const d = (y ?? 0) - (x ?? 0);
        let cell;
        if (x == null) cell = el("span", { class: "muted", text: "new" });
        else if (y == null) cell = el("span", { class: "muted", text: "removed" });
        else cell = deltaEl(delta(x, y, Math.abs(d) >= NOISE.proofsFile.abs && Math.abs(d) / x >= NOISE.proofsFile.pct));
        return { d, row: [p, x == null ? "—" : dur(x), y == null ? "—" : dur(y), cell] };
      }).sort((u, v) => Math.abs(v.d) - Math.abs(u.d));
      const changed = rows.filter(r => r.row[3].classList?.contains("better") || r.row[3].classList?.contains("worse") || r.row[3].classList?.contains("muted"));
      card.append(el("h3", { text: `Files with a change beyond noise (${changed.length} of ${rows.length})` }),
        changed.length ? fileTable(changed.map(r => r.row), ["file", "A", "B", "change"]) : el("div", { class: "muted", text: "None." }),
        fileTable(rows.map(r => r.row), ["file", "A", "B", "change"], "All files, largest absolute change first"));
    } catch (e) { host.append(el("div", { class: "empty", text: String(e) })); }
  }
}

// ---------------------------------------------------------------- router
function route() {
  const { parts, params } = parseHash();
  const [v, arg] = parts;
  if (!v || v === "results" || v === "commit") {
    if (!COMMITS.length) return timeline(params);   // shows "no results yet"
    const c = arg ? resolve(arg) : COMMITS[COMMITS.length - 1];
    if (c) return commitView(c, params);
  } else if (v === "trends") {
    return timeline(params);
  } else if (v === "compare") {
    if (!COMMITS.length) return timeline(params);
    let a, b;
    if (arg && arg.includes("..")) { const [x, y] = arg.split(".."); a = resolve(x); b = resolve(y); }
    else { b = resolve(arg) || COMMITS[COMMITS.length - 1]; a = prevOf(b) || b; }
    if (a && b) return compareView(a, b, params);
  }
  view.replaceChildren(el("div", { class: "card empty", text: `Unknown or ambiguous link: #/${parts.join("/")}` }));
}

fetchJSON("index.json").then(ix => {
  INDEX = ix;
  COMMITS = ix.commits;
  COMMITS.forEach((c, i) => POS.set(c.commit, i));
  document.getElementById("gen").textContent = `${COMMITS.length} commits · updated ${ix.generated.replace("T", " ").replace("Z", " UTC")}`;
  window.addEventListener("hashchange", route);
  route();
}).catch(e => view.replaceChildren(el("div", { class: "card empty", text: `Cannot load the index: ${e}` })));
