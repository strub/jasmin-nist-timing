// jasmin-nist results dashboard: timeline, commit and compare views over
// index.json (built by tools/build_index.py) and the per-commit result files.
//
// Routes (all in the URL fragment, so every view is a shareable link):
//   #/  or  #/results/<sha>  one commit's results (latest by default; ?zoom=dir/sub)
//   #/trends                 timelines             (?scheme=ML-KEM-768)
//   #/compare/<a>..<b>       b against a           (?zoom=dir/sub)
//   #/compare/<b>            b against the commit recorded just before it
//   #/prs                    pull requests with recorded benchmarks
//   #/pr/<number>            a PR's bench run against its merge base (?run=<sha>)
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
// Schemes grouped by family (ML-KEM, then ML-DSA), then by parameter set.
const FAMILY = ["ML-KEM", "ML-DSA"];
function bySchemeOrder(a, b) {
  const fam = s => { const i = FAMILY.findIndex(f => s.startsWith(f + "-")); return i < 0 ? FAMILY.length : i; };
  const num = s => parseInt(s.replace(/^.*-/, ""), 10) || 0;
  return fam(a) - fam(b) || num(a) - num(b) || a.localeCompare(b);
}

let INDEX = null, COMMITS = [], POS = new Map();
const cache = new Map();
const benchHidden = new Map();   // runner -> Set of hidden backends
// Generated manifests (index.json, series/, pr/) change on every deploy and
// Pages lets browsers cache everything for 10 minutes: revalidate them
// (a conditional request, cheap when unchanged). Result files under data/
// never change once written, so the normal cache is right for them.
const fetchJSON = url => {
  if (!cache.has(url)) {
    const fresh = !url.startsWith("data/");
    cache.set(url, fetch(url, fresh ? { cache: "no-cache" } : {})
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`))));
  }
  return cache.get(url);
};
const proofsFile = sha => fetchJSON(`data/proofs/${sha}.json`);
const benchFile = (runner, sha) => fetchJSON(`data/bench/${runner}/${sha}.json`);
const prBenchFile = (n, runner, sha) => fetchJSON(`data/pr/${n}/bench/${runner}/${sha}.json`);
const proofsSeries = () => fetchJSON("series/proofs.json");
const benchSeries = runner => fetchJSON(`series/bench-${runner}.json`);
// a bench result file -> { "scheme|backend|operation": [median, p25, p75] }
const toM = d => Object.fromEntries((d.results || []).map(r =>
  [`${r.scheme}|${r.backend}|${r.operation}`, [r.median, r.p25 ?? r.median, r.p75 ?? r.median]]));

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
      timeline(parseHash().params).then(() => scrollTo(0, y));
    });
    bar.append(b);
  }
  return bar;
}

async function timeline(params) {
  nav("trends");
  if (!COMMITS.length) { view.replaceChildren(el("div", { class: "card empty", text: "No results recorded yet." })); return; }
  // the trends' values live in the series files, loaded with this tab only
  let ps = null, bs = {};
  try {
    const hasProofs = COMMITS.some(c => c.proofs);
    [ps, ...bs] = await Promise.all([hasProofs ? proofsSeries() : null,
                                     ...INDEX.bench_runners.map(r => benchSeries(r))]);
    bs = Object.fromEntries(INDEX.bench_runners.map((r, i) => [r, bs[i]]));
  } catch (e) { view.replaceChildren(el("div", { class: "card empty", text: `Cannot load the trends: ${e}` })); return; }
  view.replaceChildren();
  if (COMMITS.length > RANGES[0]) view.append(rangeBar(params));
  const start = rangeStart(params);

  for (const runner of INDEX.bench_runners) view.append(benchCard(runner, params, start, bs[runner]));

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
    const at = new Map(ps.commits.map((sha, k) => [sha, k]));
    const group = (c, d) => ps.groups[d]?.[at.get(c.commit)] ?? null;
    const dirs = Object.keys(ps.groups).filter(d => pc.some(([c]) => group(c, d) != null)).sort();
    const series = dirs.map((d, k) => ({ key: d, label: d, color: `var(--s${k % 8 + 1})`,
      points: pc.filter(([c]) => group(c, d) != null).map(([c, i]) => ({ x: i, y: group(c, d) / 60 })) }));
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
        ...dirs.map(d => el("td", { class: "num", text: group(c, d) != null ? minutes(group(c, d)) : "" }))));
    }
    card.append(el("details", {}, el("summary", { text: "Table view (minutes)" }),
      el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {},
        el("th", { text: "commit" }), el("th", { text: "date" }), el("th", { class: "num", text: "total" }),
        ...dirs.map(d => el("th", { class: "num", text: d })))), tb))));
  }
}

function benchCard(runner, params, start, series) {
  const at = new Map(series.commits.map((sha, k) => [sha, k]));
  const val = (c, key) => series.m[key]?.[at.get(c.commit)] ?? null;
  const bc = COMMITS.map((c, i) => [c, i]).filter(([c, i]) => c.bench?.[runner] && at.has(c.commit) && i >= start);
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: `Benchmarks · ${runner}` }),
              el("p", { class: "sub", text: "Median cycles per operation (median over the passes); the band spans the " +
                "passes' quartiles. Click a legend entry to hide a backend; click a commit to compare it with the previous one." }));
  if (!bc.length) { card.append(el("div", { class: "empty", text: "No benchmarks yet." })); return card; }
  const keys = new Set(Object.keys(series.m).filter(k => bc.some(([c]) => val(c, k))));
  const schemes = [...new Set([...keys].map(k => k.split("|")[0]))].sort(bySchemeOrder);
  const withJasmin = schemes.filter(s => keys.has(`${s}|jasmin|keypair`) || keys.has(`${s}|jasmin|keygen`));
  const scheme = schemes.includes(params.get("scheme")) ? params.get("scheme") : (withJasmin[0] || schemes[0]);
  const bar = el("div", { class: "row", style: "margin-bottom:6px" });
  for (const s of schemes) {
    const b = el("button", { class: s === scheme ? "on" : "", text: s, "aria-pressed": String(s === scheme) });
    // rebuild this card only: re-rendering the page would scroll to the top
    b.addEventListener("click", () => { setParam("scheme", s); card.replaceWith(benchCard(runner, parseHash().params, start, series)); });
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
      const key = `${scheme}|${s.key}|${op}`;
      const ser = { key: s.key, label: s.label, color: s.color, points: bc.filter(([c]) => val(c, key))
        .map(([c, i]) => { const [m, lo, hi] = val(c, key); return { x: i, y: m, lo, hi }; }) };
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
    ...opOrder.map(op => { const v = val(last, `${scheme}|${b}|${op}`); return el("td", { class: "num", text: v ? cycles(v[0]) : "" }); })));
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

  const missing = (title, what) => view.append(el("div", { class: "card" }, el("h2", { text: title }),
    el("div", { class: "empty", text: `No ${what} recorded for this commit: its CI run may still be in ` +
      "progress, may have failed, or did not run for this commit." })));
  for (const runner of INDEX.bench_runners) {
    const b = c.bench?.[runner];
    if (!b) { missing(`Benchmarks · ${runner}`, "benchmarks"); continue; }
    const card = el("div", { class: "card" });
    view.append(card);
    card.append(el("h2", { text: `Benchmarks · ${runner}` }),
      el("p", { class: "sub", text: `Median cycles, ${b.reps || 1} passes × ${b.iters || "?"} iterations; ± half the passes' interquartile range. ` +
        Object.entries(b.env || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") }));
    const host = el("div");
    card.append(host);
    try { host.append(benchBars(runner, toM(await benchFile(runner, c.commit)))); }
    catch (e) { host.append(el("div", { class: "empty", text: String(e) })); }
  }
  if (!c.proofs) missing("Proof checking", "proof timings");
  else {
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
  const schemes = only || [...new Set(Object.keys(m).map(k => k.split("|")[0]))].sort(bySchemeOrder);
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
  const schemes = [...new Set(Object.keys(m).map(k => k.split("|")[0]))].sort(bySchemeOrder);
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

function envNotice(diffs, what) {
  if (!diffs.length) return null;
  return el("div", { class: "notice" }, el("strong", { text: `${what}: the environment differs between A and B` }),
    " — changes may come from it rather than from the code.",
    el("ul", {}, ...diffs.map(d => el("li", {}, el("span", { text: `${d.key}: ` }), el("span", { class: "mono", text: `${d.a} → ${d.b}` })))));
}

// Bench comparison A -> B: verdict counts and per-scheme tables. A change
// counts only if the passes' quartiles separate and it exceeds the floor.
function benchCompare(ma, mb) {
  const wrap = el("div");
  let better = 0, worse = 0;
  for (const k of Object.keys(mb)) {
    const x = ma[k], y = mb[k];
    if (!x) continue;
    const sig = (y[1] > x[2] || y[2] < x[1]) && Math.abs(y[0] - x[0]) / x[0] >= NOISE.bench;
    if (sig) y[0] < x[0] ? better++ : worse++;
  }
  const n = Object.keys(mb).length;
  wrap.append(el("p", { class: "sub", text: `${better} faster, ${worse} slower, ${n - better - worse} unchanged ` +
    `(of ${n} measurements). Cells: A → B median cycles.` }), benchTables(mb, ma));
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


  // bench
  for (const runner of INDEX.bench_runners) {
    const card = el("div", { class: "card" });
    view.append(card);
    card.append(el("h2", { text: `Benchmarks · ${runner}` }));
    const ba = a.bench?.[runner], bb = b.bench?.[runner];
    if (!ba || !bb) { card.append(el("div", { class: "empty", text: `No benchmark for ${!ba ? "A" : "B"} on this machine.` })); continue; }
    const n = envNotice(envDiff(benchEnv(a, runner), benchEnv(b, runner)), "Bench");
    if (n) card.append(n);
    try {
      const [ma, mb] = await Promise.all([benchFile(runner, a.commit), benchFile(runner, b.commit)]).then(ds => ds.map(toM));
      card.append(benchCompare(ma, mb));
    } catch (e) { card.append(el("div", { class: "empty", text: String(e) })); }
  }

  // proofs
  const card = el("div", { class: "card" });
  view.append(card);
  card.append(el("h2", { text: "Proof checking" }));
  if (!a.proofs || !b.proofs) card.append(el("div", { class: "empty", text: `No proof timings for ${!a.proofs ? "A" : "B"}.` }));
  else {
    const n = envNotice(envDiff(proofsEnv(a), proofsEnv(b)), "Proofs");
    if (n) card.append(n);
    let fa = null, fb = null;
    try { [fa, fb] = await Promise.all([proofsFile(a.commit), proofsFile(b.commit)]); }
    catch (e) { card.append(el("div", { class: "empty", text: String(e) })); }
    if (fa && fb) {
      const am = new Map(fa.files.map(f => [f.path, f.seconds]));
      const bm = new Map(fb.files.map(f => [f.path, f.seconds]));
      // A change splits into: files in both runs (the speed change, which
      // gets the verdict), files new in B, and files removed since A.
      const split = (keep = () => true) => {
        const r = { ta: 0, tb: 0, ca: 0, cb: 0, added: 0, nAdded: 0, removed: 0, nRemoved: 0 };
        for (const [p, x] of am) if (keep(p)) {
          r.ta += x;
          if (bm.has(p)) { r.ca += x; r.cb += bm.get(p); } else { r.removed += x; r.nRemoved++; }
        }
        for (const [p, y] of bm) if (keep(p)) { r.tb += y; if (!am.has(p)) { r.added += y; r.nAdded++; } }
        return r;
      };
      const signed = v => `${v >= 0 ? "+" : "−"}${dur(Math.abs(v))}`;
      const files = n => `${n} file${n > 1 ? "s" : ""}`;
      const churn = r => [r.nAdded ? `+${dur(r.added)} new (${files(r.nAdded)})` : null,
                          r.nRemoved ? `−${dur(r.removed)} removed (${files(r.nRemoved)})` : null].filter(Boolean).join(" · ");
      const T = split();
      const dt = delta(T.ca, T.cb, T.ca > 0 && Math.abs(T.cb - T.ca) / T.ca >= NOISE.proofsTotal);
      card.append(el("div", { class: "tiles", style: "margin-top:10px" },
        el("div", { class: "tile" }, el("div", { class: "k", text: "A total" }), el("div", { class: "v", text: dur(T.ta) }),
           el("div", { class: "s muted", text: files(am.size) })),
        el("div", { class: "tile" }, el("div", { class: "k", text: "B total" }), el("div", { class: "v", text: dur(T.tb) }),
           el("div", { class: "s muted", text: `${files(bm.size)} · ${signed(T.tb - T.ta)}` })),
        el("div", { class: "tile" }, el("div", { class: "k", text: "change on files in both" }), el("div", { class: "v" }, deltaEl(dt)),
           el("div", { class: "s muted", text: [signed(T.cb - T.ca), churn(T)].filter(Boolean).join(" · ") }))));
      const dirs = [...new Set([...am.keys(), ...bm.keys()].map(p => p.split("/")[0]))].sort();
      const drows = dirs.map(d => {
        const r = split(p => p.split("/")[0] === d);
        const verdict = r.ca > 0
          ? deltaEl(delta(r.ca, r.cb, Math.abs(r.cb - r.ca) >= NOISE.proofsDir.abs && Math.abs(r.cb - r.ca) / r.ca >= NOISE.proofsDir.pct))
          : el("span", { class: "muted", text: r.nAdded ? "new" : "removed" });
        return [d, r.ta ? dur(r.ta) : "—", r.tb ? dur(r.tb) : "—", verdict, churn(r) || "—"];
      });
      card.append(el("h3", { text: "By top-level directory" }),
                  fileTable(drows, ["directory", "A", "B", "change on files in both", "new / removed"]));
      const host = el("div");
      card.append(el("h3", { text: "B by file, colored by change against A" }), host);
      sunburst(host, fb.files, { base: fa.files, zoom: params.get("zoom"), onZoom: z => setParam("zoom", z) });
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
    }
  }
}

// ---------------------------------------------------------------- PRs
function prsView() {
  nav("prs");
  const prs = INDEX.prs || [];
  const card = el("div", { class: "card" }, el("h2", { text: "Pull requests" }),
    el("p", { class: "sub", text: "Benchmarks of labelled pull requests, each run compared with the PR's merge base on main. " +
      "PR records are kept apart from main's history." }));
  view.replaceChildren(card);
  if (!prs.length) { card.append(el("div", { class: "empty", text: "No pull request benchmarks recorded yet." })); return; }
  const tb = el("tbody");
  for (const p of prs)
    tb.append(el("tr", {}, el("td", {}, el("a", { href: `#/pr/${p.number}`, text: `#${p.number}` })),
      el("td", { text: p.title || "" }), el("td", { class: "mono", text: p.head_ref || "" }),
      el("td", { class: "num", text: String(p.runs) }), el("td", { class: "num", text: day(p.last) })));
  card.append(el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {},
    el("th", { text: "PR" }), el("th", { text: "title" }), el("th", { text: "branch" }),
    el("th", { class: "num", text: "runs" }), el("th", { class: "num", text: "last run" }))), tb)));
}

async function prView(number, params) {
  nav("prs");
  view.replaceChildren(el("div", { class: "card empty", text: "Loading…" }));
  let pr;
  try { pr = await fetchJSON(`pr/${number}.json`); }
  catch (e) { view.replaceChildren(el("div", { class: "card empty", text: `No benchmarks recorded for PR #${number}.` })); return; }
  const runs = pr.runs;
  const want = params.get("run");
  const run = (want && runs.filter(r => r.commit.startsWith(want)).pop()) || runs[runs.length - 1];
  const head = el("div", { class: "card" });
  view.replaceChildren(head);
  head.append(el("h2", { text: `PR #${pr.number}${pr.title ? " · " + pr.title : ""}` }),
    el("p", { class: "sub" }, el("span", { class: "mono", text: pr.head_ref || "" }), " · ",
       el("a", { href: `${REPO}/pull/${pr.number}`, text: "pull request" }), " · ",
       el("a", { href: `#/prs`, text: "all PRs" })));
  if (runs.length > 1) {
    const sel = el("select", { "aria-label": "PR run" });
    for (const r of runs.slice().reverse()) {
      const o = el("option", { value: r.commit, text: `${short(r.commit)} · ${day(r.date)} · ${r.subject || ""}` });
      if (r === run) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => go(`#/pr/${pr.number}?run=${sel.value}`));
    head.append(el("div", { class: "row" }, el("span", { class: "muted", text: `Run (${runs.length}):` }), sel));
  }
  // base: the merge base's main record, else the closest earlier recorded main commit
  const hasBench = c => c.bench?.[run.runner];
  let base = COMMITS.find(c => c.commit === run.merge_base && hasBench(c)), approx = false;
  if (!base && run.merge_base_date) {
    const earlier = COMMITS.filter(c => hasBench(c) && (c.commit_date || "") <= run.merge_base_date);
    base = earlier[earlier.length - 1]; approx = !!base;
  }
  const card = el("div", { class: "card" });
  view.append(card);
  card.append(el("h2", { text: `Benchmarks · ${run.runner}` }),
    el("p", { class: "sub" }, "A = ", base ? el("a", { href: `#/results/${base.commit}`, class: "mono", text: short(base.commit) }) : "—",
       " (main) · B = ", el("span", { class: "mono", text: short(run.commit) }), ` (PR run, ${day(run.date)})`,
       run.run_id ? " · " : null, run.run_id ? el("a", { href: `${REPO}/actions/runs/${run.run_id}`, text: "CI run" }) : null,
       base ? " · " : null, base ? el("a", { href: `${REPO}/compare/${base.commit}...${run.commit}`, text: "code diff" }) : null));
  if (!base) {
    card.append(el("div", { class: "empty", text: `No main commit with a recorded benchmark to compare with (merge base ${short(run.merge_base || "?")}).` }));
    return;
  }
  if (approx) card.append(el("div", { class: "notice", text: `The merge base ${short(run.merge_base)} has no recorded benchmark; ` +
    `compared with ${short(base.commit)}, the closest earlier main commit that has one.` }));
  const n = envNotice(envDiff(benchEnv(base, run.runner), { ...run.env, reps: run.reps, iters: run.iters }), "Bench");
  if (n) card.append(n);
  try {
    const [ma, mb] = await Promise.all([benchFile(run.runner, base.commit), prBenchFile(pr.number, run.runner, run.commit)])
      .then(ds => ds.map(toM));
    card.append(benchCompare(ma, mb),
                el("details", {}, el("summary", { text: "The PR run on its own (charts)" }), benchBars(run.runner, mb)));
  } catch (e) { card.append(el("div", { class: "empty", text: String(e) })); }
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
  } else if (v === "prs") {
    return prsView();
  } else if (v === "pr" && /^\d+$/.test(arg || "")) {
    return prView(+arg, params);
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
  const nprs = (ix.prs || []).length;
  document.getElementById("gen").textContent = `${COMMITS.length} commits${nprs ? ` · ${nprs} PRs` : ""} · ` +
    `updated ${ix.generated.replace("T", " ").replace("Z", " UTC")}`;
  window.addEventListener("hashchange", route);
  route();
}).catch(e => view.replaceChildren(el("div", { class: "card empty", text: `Cannot load the index: ${e}` })));
