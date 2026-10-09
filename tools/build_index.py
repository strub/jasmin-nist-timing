#!/usr/bin/env python3
"""Build the site's manifests from the result files.

Input (written by jasmin-nist's CI, never edited):

    data/proofs/<commit>.json                     proofs timing, main
    data/bench/<runner>/<commit>.json             cycle benchmarks, main
    data/pr/<number>/bench/<runner>/<commit>.json cycle benchmarks of a PR run

Output (into OUT_DIR, rebuilt on every deploy):

    index.json               light manifest: main commits (oldest first by
                             commit date) with their run metadata, and the
                             PRs that have bench records
    series/proofs.json       proof time per commit (total, per top-level
                             directory), column-wise, for the Trends tab
    series/bench-<r>.json    median and quartiles per measurement and commit,
                             column-wise, for the Trends tab
    pr/<number>.json         one PR's bench runs, with their merge base

The dashboard fetches index.json first, a series file only on the Trends
tab, and a full result file only for the commits or PR runs it shows.

Usage:  build_index.py [DATA_DIR] [OUT_DIR]
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as e:
        print(f"skipping {path}: {e}", file=sys.stderr)
        return None


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")) + "\n")


def bench_m(d):
    """'scheme|backend|operation' -> [median, p25, p75]"""
    return {f'{r["scheme"]}|{r["backend"]}|{r["operation"]}':
            [r["median"], r.get("p25", r["median"]), r.get("p75", r["median"])]
            for r in d.get("results", [])}


def main():
    data = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else ".")

    commits, proofs_groups, bench_series = {}, {}, {}

    def entry(sha, meta):
        c = commits.setdefault(sha, {"commit": sha})
        for k in ("commit_date", "subject"):
            if meta.get(k) and not c.get(k):
                c[k] = meta[k]
        return c

    for f in sorted((data / "proofs").glob("*.json")):
        d = load(f)
        if d is None:
            continue
        meta = d.get("meta", {})
        c = entry(f.stem, meta)
        c["proofs"] = {k: meta[k] for k in
                       ("total_seconds", "files", "machine", "tools", "date", "run_id")
                       if k in meta}
        groups = {}
        for x in d.get("files", []):
            top = x["path"].split("/")[0]
            groups[top] = round(groups.get(top, 0) + x["seconds"], 1)
        proofs_groups[f.stem] = groups

    runners = set()
    for f in sorted((data / "bench").glob("*/*.json")):
        d = load(f)
        if d is None:
            continue
        meta, runner = d.get("meta", {}), f.parent.name
        runners.add(runner)
        c = entry(f.stem, meta)
        c.setdefault("bench", {})[runner] = {
            k: meta[k] for k in ("reps", "iters", "env", "date", "run_id") if k in meta}
        bench_series.setdefault(runner, {})[f.stem] = bench_m(d)

    ordered = sorted(commits.values(),
                     key=lambda c: (c.get("commit_date") or "", c["commit"]))
    shas = [c["commit"] for c in ordered]

    # series, column-wise over `commits` (null where a commit has no value)
    with_proofs = [s for s in shas if s in proofs_groups]
    dirs = sorted({d for g in proofs_groups.values() for d in g})
    dump(out / "series" / "proofs.json", {
        "commits": with_proofs,
        "total": [commits[s]["proofs"].get("total_seconds") for s in with_proofs],
        "groups": {d: [proofs_groups[s].get(d) for s in with_proofs] for d in dirs},
    })
    for runner, per in bench_series.items():
        cs = [s for s in shas if s in per]
        keys = sorted({k for m in per.values() for k in m})
        dump(out / "series" / f"bench-{runner}.json", {
            "commits": cs,
            "m": {k: [per[s].get(k) for s in cs] for k in keys},
        })

    # PRs: one manifest each, and a summary in the index
    prs = []
    for pdir in sorted((data / "pr").glob("*"), key=lambda p: (len(p.name), p.name)):
        if not pdir.name.isdigit():
            continue
        runs = []
        for f in sorted(pdir.glob("bench/*/*.json")):
            d = load(f)
            if d is None:
                continue
            meta = d.get("meta", {})
            pr = meta.get("pr", {})
            runs.append({"commit": f.stem, "runner": f.parent.name,
                         "commit_date": meta.get("commit_date"), "subject": meta.get("subject"),
                         "date": meta.get("date"), "run_id": meta.get("run_id"),
                         "reps": meta.get("reps"), "iters": meta.get("iters"), "env": meta.get("env"),
                         "base": pr.get("base"), "merge_base": pr.get("merge_base"),
                         "merge_base_date": pr.get("merge_base_date"),
                         "title": pr.get("title"), "head_ref": pr.get("head_ref")})
        if not runs:
            continue
        runs.sort(key=lambda r: (r.get("date") or "", r["commit"]))
        last = runs[-1]
        dump(out / "pr" / f"{pdir.name}.json", {"number": int(pdir.name), "title": last.get("title"),
                                                "head_ref": last.get("head_ref"), "runs": runs})
        prs.append({"number": int(pdir.name), "title": last.get("title"),
                    "head_ref": last.get("head_ref"), "runs": len(runs), "last": last.get("date")})
    prs.sort(key=lambda p: p.get("last") or "", reverse=True)

    dump(out / "index.json", {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bench_runners": sorted(runners),
        "commits": ordered,
        "prs": prs,
    })
    print(f"{out}: {len(ordered)} commits, bench runners {sorted(runners)}, {len(prs)} PRs")


if __name__ == "__main__":
    main()
