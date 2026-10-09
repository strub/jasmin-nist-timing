#!/usr/bin/env python3
"""Build the site's index of recorded commits from the result files.

    data/proofs/<commit>.json           proof-checking timings (one run)
    data/bench/<runner>/<commit>.json   cycle benchmarks (one run per machine)

Each file is the JSON a jasmin-nist CI run produced; only its "meta" is read
here. The index lists every commit that has at least one result, oldest
first by commit date, with what is available for it, so the dashboard can
walk the history and fetch only the files it needs.

Usage:  build_index.py [DATA_DIR] [OUT_JSON]
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_meta(path):
    try:
        return json.loads(path.read_text()).get("meta", {})
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
        meta = load_meta(f)
        if meta is None:
            continue
        c = entry(f.stem, meta)
        c["proofs"] = {k: meta[k] for k in
                       ("total_seconds", "files", "machine", "tools", "date")
                       if k in meta}

    runners = set()
    for f in sorted((data / "bench").glob("*/*.json")):
        meta = load_meta(f)
        if meta is None:
            continue
        runner = f.parent.name
        runners.add(runner)
        c = entry(f.stem, meta)
        c.setdefault("bench", {})[runner] = {
            k: meta[k] for k in ("reps", "iters", "env", "date") if k in meta}

    ordered = sorted(commits.values(),
                     key=lambda c: (c.get("commit_date") or "", c["commit"]))
    index = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bench_runners": sorted(runners),
        "commits": ordered,
    }
    out.write_text(json.dumps(index, indent=1) + "\n")
    print(f"{out}: {len(ordered)} commits, bench runners {sorted(runners)}")


if __name__ == "__main__":
    main()
