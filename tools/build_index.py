#!/usr/bin/env python3
"""Build the site's index of recorded commits from the result files.

    data/proofs/<commit>.json           proof-checking timings (one run)
    data/bench/<runner>/<commit>.json   cycle benchmarks (one run per machine)

Each file is the JSON a jasmin-nist CI run produced. The index lists every
commit that has at least one result, oldest first by commit date, with the
run's metadata and a compact summary for the timelines (proof time per
top-level directory; bench median and quartiles per measurement), so the
dashboard draws the history from the index alone and fetches a full file
only for the commits it compares.

Usage:  build_index.py [DATA_DIR] [OUT_JSON]
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


def main():
    data = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "index.json")

    commits = {}

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
        groups = {}
        for x in d.get("files", []):
            top = x["path"].split("/")[0]
            groups[top] = round(groups.get(top, 0) + x["seconds"], 1)
        c["proofs"] = {k: meta[k] for k in
                       ("total_seconds", "files", "machine", "tools", "date",
                        "run_id")
                       if k in meta}
        c["proofs"]["groups"] = groups

    runners = set()
    for f in sorted((data / "bench").glob("*/*.json")):
        d = load(f)
        if d is None:
            continue
        meta = d.get("meta", {})
        runner = f.parent.name
        runners.add(runner)
        c = entry(f.stem, meta)
        b = {k: meta[k] for k in ("reps", "iters", "env", "date", "run_id")
             if k in meta}
        # "scheme|backend|operation" -> [median, p25, p75]
        b["m"] = {f'{r["scheme"]}|{r["backend"]}|{r["operation"]}':
                  [r["median"], r.get("p25", r["median"]), r.get("p75", r["median"])]
                  for r in d.get("results", [])}
        c.setdefault("bench", {})[runner] = b

    ordered = sorted(commits.values(),
                     key=lambda c: (c.get("commit_date") or "", c["commit"]))
    index = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bench_runners": sorted(runners),
        "commits": ordered,
    }
    out.write_text(json.dumps(index, separators=(",", ":")) + "\n")
    print(f"{out}: {len(ordered)} commits, bench runners {sorted(runners)}")


if __name__ == "__main__":
    main()
