# jasmin-nist results

Proof-checking timings and cycle benchmarks of
[jasmin-nist](https://github.com/strub/jasmin-nist), one record per commit on
its `main` branch, published at https://www.strub.nu/jasmin-nist-timing/.

- `data/proofs/<commit>.json`: EasyCrypt proof-checking time per file, with
  the machine and tool versions of the run (main).
- `data/bench/<runner>/<commit>.json`: median cycles per scheme, backend and
  operation over several passes, with their spread and the environment (main).
- `data/pr/<number>/bench/<runner>/<commit>.json`: the same for a bench run of
  a labelled pull request, with the PR's merge base; kept apart from main's
  history (delete a PR's folder to prune it).
- `site/`: the dashboard. `tools/build_index.py` generates, at deploy time,
  a light `index.json` (main commits and their run metadata, PRs), the
  Trends data (`series/`) and one manifest per PR (`pr/<number>.json`).

The files are pushed by jasmin-nist's CI (a publish job on a GitHub-hosted
runner, with this repo's deploy key) and are never edited afterwards; the
`pages` workflow rebuilds and deploys the site on every push.
