// Zoomable sunburst of proof-checking time by directory (ported from
// jasmin-nist's scripts/timing-sunburst.py).
//
// sunburst(host, files, opts)
//   files: [{ path, seconds }]           the run to draw (arc size = its time)
//   opts.base: [{ path, seconds }]       optional: color each arc by its change
//                                        against this run (diverging blue/red)
//   opts.zoom: "dir/sub"                 initial zoom path
//   opts.onZoom(path)                    called on zoom (to keep it in the URL)

import { el, tip, hideTip, dur } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (t, at = {}) => {
  const e = document.createElementNS(NS, t);
  for (const k in at) e.setAttribute(k, at[k]);
  return e;
};
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

function build(files) {
  const root = { name: "proofs", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.children.has(d)) node.children.set(d, { name: d, children: new Map() });
      node = node.children.get(d);
    }
    node.children.set(parts[parts.length - 1], { name: parts[parts.length - 1], seconds: f.seconds });
  }
  const freeze = (n, depth, path) => {
    n.depth = depth; n.path = path;
    if (n.children) {
      n.children = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name));
      n.seconds = 0;
      for (const c of n.children)
        n.seconds += freeze(c, depth + 1, path ? path + "/" + c.name : c.name).seconds;
    }
    return n;
  };
  return freeze(root, 0, "");
}

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const toHex = v => "#" + v.map(x => Math.round(x).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
const inkFor = c => { const [r, g, b] = hex(c); return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1a1a19" : "#ffffff"; };

// Diverging color for a relative change: -RANGE..+RANGE onto blue..gray..red.
const RANGE = 0.5;
function divColor(pct) {
  const t = Math.max(-1, Math.min(1, pct / RANGE));
  const mid = css("--div-mid");
  return t < 0 ? mix(mid, css("--div-neg"), -t) : mix(mid, css("--div-pos"), t);
}

export function sunburst(host, files, opts = {}) {
  const root = build(files);
  const baseMap = opts.base ? new Map(opts.base.map(f => [f.path, f.seconds])) : null;
  // Change of a slice = over its files present in both runs only: a new file
  // (or a rename) is not a speed change. New files are hatched instead, and
  // files gone since the base run are listed beside the chart.
  const common = n => n.children
    ? n.children.reduce((acc, c) => { const x = common(c); return [acc[0] + x[0], acc[1] + x[1]]; }, [0, 0])
    : (baseMap.has(n.path) ? [baseMap.get(n.path), n.seconds] : [0, 0]);
  const newSec = n => n.children ? n.children.reduce((a, c) => a + newSec(c), 0)
                                 : (baseMap.has(n.path) ? 0 : n.seconds);
  const isNew = n => newSec(n) === n.seconds && n.seconds > 0;
  const removed = baseMap ? opts.base.filter(f => !files.some(g => g.path === f.path))
                                     .sort((x, y) => y.seconds - x.seconds) : [];
  const families = root.children.map(c => c.name);
  const famColor = name => css(SLOTS[families.indexOf(name) % SLOTS.length]);
  const surface = () => css("--surface-1");

  const box = el("div", { class: "sb" });
  const plot = el("div", { class: "plot" });
  const side = el("div", { class: "side" });
  const crumbs = el("div", { class: "crumbs" });
  host.append(crumbs, box);
  box.append(plot, side);

  const hatchId = `hatch${Math.random().toString(36).slice(2, 8)}`;
  let zoom = root;
  if (opts.zoom) {
    let n = root;
    for (const seg of opts.zoom.split("/")) {
      const nx = (n.children || []).find(k => k.name === seg);
      if (!nx) { n = root; break; }
      n = nx;
    }
    zoom = n.children ? n : root;
  }
  const zoomTo = n => { zoom = n; opts.onZoom && opts.onZoom(n === root ? "" : n.path); render(); };

  const W = 560, CX = W / 2, R0 = 46;
  let RING = 42;
  const depthBelow = n => n.children ? 1 + Math.max(...n.children.map(depthBelow)) : 0;
  const arcPath = (a0, a1, r0, r1) => {
    const p = (a, r) => [CX + r * Math.sin(a), CX - r * Math.cos(a)];
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = p(a0, r0), [x1, y1] = p(a1, r0), [x2, y2] = p(a1, r1), [x3, y3] = p(a0, r1);
    return `M${x0},${y0}A${r0},${r0} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r1},${r1} 0 ${large} 0 ${x3},${y3}Z`;
  };

  function render() {
    hideTip();
    plot.replaceChildren();
    // rings share the radius left around the centre disc, so the deepest
    // file at this zoom level still fits
    RING = Math.min(64, (CX - R0 - 2) / Math.max(1, depthBelow(zoom)));
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${W}`, role: "img",
                               "aria-label": "sunburst of proof-checking time" });
    if (baseMap) {   // hatching for files new in B: tone-on-tone 45° lines
      const pat = svgEl("pattern", { id: hatchId, patternUnits: "userSpaceOnUse", width: 6, height: 6,
                                     patternTransform: "rotate(45)" });
      pat.append(svgEl("rect", { width: 6, height: 6, fill: css("--div-mid") }),
                 svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: css("--muted"), "stroke-width": 2 }));
      const defs = svgEl("defs");
      defs.append(pat);
      svg.append(defs);
    }
    const labels = [];
    let lid = 0;
    const total = root.seconds;
    const draw = (node, a0, a1, ring) => {
      if (node !== zoom) {
        const r0 = R0 + ring * RING, r1 = r0 + RING - 2;
        let fill, ink;
        if (baseMap) {
          const [ca, cb] = common(node);
          fill = divColor(ca ? (cb - ca) / ca : 0);
          ink = fill;
          if (isNew(node)) { ink = css("--div-mid"); fill = `url(#${hatchId})`; }
        } else {
          const rel = node.depth - zoom.depth, t = Math.min(0.62, 0.16 * (rel - 1));
          fill = mix(famColor(node.path.split("/")[0]), surface(),
                     node.children ? t : Math.min(0.7, t + 0.10));
          ink = fill;
        }
        const path = svgEl("path", { d: arcPath(a0, a1, r0, r1), fill, class: "arc",
                                     stroke: surface(), "stroke-width": 1.5 });
        path.addEventListener("pointermove", ev => {
          const rows = [{ value: dur(node.seconds), label: `${(100 * node.seconds / total).toFixed(1)}% of total` }];
          if (baseMap) {
            const [ca, cb] = common(node), nw = newSec(node);
            if (isNew(node)) rows.push({ value: "new", label: "not in A" });
            else {
              const pct = ca ? (cb - ca) / ca : 0;
              rows.push({ value: `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(100 * pct).toFixed(1)}%`,
                          label: node.children ? `on files in both (${dur(ca)} in A)` : `vs ${dur(ca)} in A` });
              if (nw > 0) rows.push({ value: dur(nw), label: "in files new in B" });
            }
          }
          tip(node.path + (node.children ? "/" : ""), rows, ev.clientX, ev.clientY);
        });
        path.addEventListener("pointerleave", hideTip);
        path.addEventListener("click", () => node.children && zoomTo(node));
        svg.appendChild(path);
        const span = a1 - a0, rm = (r0 + r1) / 2, len = span * rm;
        if (len > 34) {
          const p = (a, r) => [CX + r * Math.sin(a), CX - r * Math.cos(a)];
          const [xs, ys] = p(a0, rm), [xe, ye] = p(a1, rm);
          const id = `sbl${Math.random().toString(36).slice(2, 7)}${lid++}`;
          svg.appendChild(svgEl("path", { id, fill: "none",
            d: `M${xs},${ys}A${rm},${rm} 0 ${span > Math.PI ? 1 : 0} 1 ${xe},${ye}` }));
          const txt = svgEl("text", { class: "albl" });
          txt.style.fill = inkFor(ink);
          const tp = svgEl("textPath", { href: "#" + id, startOffset: "50%", "text-anchor": "middle" });
          tp.textContent = node.name;
          txt.appendChild(tp);
          svg.appendChild(txt);
          labels.push({ txt, tp, name: node.name, room: len - 8 });
        }
      }
      if (node.children) {
        let a = a0;
        for (const c of node.children) {
          const sw = (a1 - a0) * (c.seconds / node.seconds || 0);
          draw(c, a, a + sw, node === zoom ? 0 : ring + 1);
          a += sw;
        }
      }
    };
    draw(zoom, 0, 2 * Math.PI, -1);

    const c = svgEl("circle", { cx: CX, cy: CX, r: R0 - 4, fill: "var(--page)", stroke: "var(--hairline)" });
    c.style.cursor = zoom === root ? "default" : "pointer";
    c.addEventListener("click", () => {
      if (zoom === root) return;
      const parts = zoom.path.split("/"); parts.pop();
      let up = root;
      for (const p of parts) up = up.children.find(k => k.name === p) || up;
      zoomTo(up);
    });
    const t1 = svgEl("text", { x: CX, y: CX - 6, class: "ct", "text-anchor": "middle" });
    t1.textContent = zoom.name;
    const t2 = svgEl("text", { x: CX, y: CX + 12, class: "cs", "text-anchor": "middle" });
    t2.textContent = dur(zoom.seconds);
    svg.append(c, t1, t2);
    plot.appendChild(svg);

    for (const { txt, tp, name, room } of labels) {
      if (txt.getComputedTextLength() <= room) continue;
      let n = name.length;
      while (n > 2) { n--; tp.textContent = name.slice(0, n) + "…"; if (txt.getComputedTextLength() <= room) break; }
      if (n <= 2) txt.remove();
    }

    // breadcrumb
    crumbs.replaceChildren();
    const trail = [root];
    if (zoom !== root) {
      let n = root;
      for (const p of zoom.path.split("/")) { n = n.children.find(k => k.name === p); if (!n) break; trail.push(n); }
    }
    trail.forEach((n, i) => {
      if (i) crumbs.append(" / ");
      if (n === zoom) crumbs.append(el("span", { class: "here", text: n.name }));
      else { const a = el("a", { text: n.name, tabindex: 0 }); a.addEventListener("click", () => zoomTo(n)); crumbs.append(a); }
    });

    // side: legend (by directory) or the diverging ramp
    side.replaceChildren();
    if (baseMap) {
      side.append(el("div", { class: "sub", text: "Color: change of each slice against A" }),
                  el("div", { class: "ramp" }),
                  el("div", { class: "ramp-l" }, el("span", { text: `−${RANGE * 100}% faster` }),
                     el("span", { text: "0" }), el("span", { text: `+${RANGE * 100}% slower` })),
                  el("div", { class: "legend", style: "margin-top:6px" },
                     el("span", { class: "item", style: "cursor:default" }, el("span", { class: "sw hatch" }),
                        "new in B (not compared)")));
      if (removed.length) {
        const SHOWN = 8;
        const tot = removed.reduce((a, f) => a + f.seconds, 0);
        const ul = el("ul", { class: "removed" });
        for (const f of removed.slice(0, SHOWN))
          ul.append(el("li", {}, el("span", { class: "mono", text: f.path }), el("span", { class: "muted num", text: dur(f.seconds) })));
        side.append(el("div", { class: "sub", style: "margin:10px 0 2px",
                                text: `Removed since A: ${removed.length} file${removed.length > 1 ? "s" : ""}, ${dur(tot)} in A` }), ul);
        if (removed.length > SHOWN) side.append(el("div", { class: "muted", style: "font-size:12px",
                                                            text: `… and ${removed.length - SHOWN} more (see the file table)` }));
      }
    }
    const lg = el("div", { class: "legend", style: "flex-direction:column;gap:4px" });
    for (const f of root.children) {
      const it = el("span", { class: "item", tabindex: 0 });
      if (!baseMap) { const sw = el("span", { class: "sw" }); sw.style.background = famColor(f.name); it.append(sw); }
      it.append(el("span", { text: f.name, style: "flex:1" }),
                el("span", { class: "muted num", text: `${dur(f.seconds)} · ${(100 * f.seconds / total).toFixed(0)}%` }));
      it.addEventListener("click", () => zoomTo(f));
      lg.append(it);
    }
    side.append(lg, el("div", { class: "sub", style: "margin-top:8px",
      text: "Click a slice or a directory to zoom in; the centre or the breadcrumb zooms out. " +
            "Times are cumulative per file (a parallel run's wall time is lower)." }));
  }
  render();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}
