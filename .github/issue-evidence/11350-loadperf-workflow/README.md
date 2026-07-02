# #11350 Loadperf Workflow Evidence

## Scope

- Added `.github/workflows/loadperf.yml`.
- The merged client lane from PR #11467 remains the PR-blocking bundle gate.
- This workflow adds the scheduled/manual heavier lane for bundle, production
  boot RSS/time, and frontend web-vitals KPIs.
- A narrow PR trigger runs the same stack job when this workflow or the loadperf
  harness changes, so a new workflow can prove itself before merge without
  charging every app/UI PR for boot and browser KPIs.
- State-sync is manual-dispatch only and requires `loadperf_base_url` or
  `loadperf_ws_url`, because the KPI must observe real broadcast traffic from a
  live stack.

## Local validation

- `actionlint .github/workflows/loadperf.yml`
- `python3` + PyYAML safe-load of `.github/workflows/loadperf.yml`
- `git diff --cached --check`
- `git diff --check origin/develop...HEAD` after rebasing onto current
  `origin/develop`

## Evidence gaps

- GitHub Actions execution evidence must come from the PR run after pushing the
  workflow file. This local evidence only validates syntax and diff hygiene.
