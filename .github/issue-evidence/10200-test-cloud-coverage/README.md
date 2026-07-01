# #10200 — de-larp `test:cloud`: run the cloud routing + infra suites it silently skipped

Descends from #10200 ("optimize and **de-larp** dev/build/support scripts") —
acceptance criterion _"Reduce 'script says it passed but did not do the real
thing' cases by tightening preflights and output."_

## The false-green

`packages/scripts/test-cloud-run.mjs` (`bun run test:cloud`, the cloud unit-test
gate run by `cloud-tests.yml`'s `unit-tests` job) executed only three roots:
`packages/cloud/shared/src`, `packages/cloud/api/__tests__`, and
`packages/scripts/cloud`. It did **not** run:

- `packages/cloud/routing/src` — the model-routing resolver suite,
- `packages/cloud/infra/tests` — the IaC / static-config suite,

which together are **104 tests across 7 files**. And `cloud-tests.yml`'s `paths:`
filter did not list `packages/cloud/routing/**` or `packages/cloud/infra/**` at
all — so a routing- or infra-only PR triggered **no** cloud lane, and even when
the workflow ran for another reason, `test:cloud` never touched those suites.
Net: 104 real tests ran on **no PR lane** = silent false-green.

This is the same class of bug the runner's own comments already guard against
(the #9917 package-move stale-path note): _"`bun test <nonexistent-dir>` exits 0
with no tests run … turns this gate into a silent false-green."_

## The fix

1. `packages/scripts/test-cloud-run.mjs` — add `cloud/routing/src` and
   `cloud/infra/tests` to the test roots (and to the fail-loud missing-root
   guard, so a future move can't silently drop them). Both suites resolve their
   fixtures via `import.meta.dir`, so they are cwd-independent under the
   staging-dir run.
2. `.github/workflows/cloud-tests.yml` — add `packages/cloud/routing/**`,
   `packages/cloud/infra/**`, and `packages/scripts/test-cloud-run.mjs` to the PR
   and push `paths:` filters, so a routing/infra/runner change actually triggers
   the cloud workflow.

## Validation (real, local, macOS)

`test:cloud`'s exact mechanism = `bun test <roots> --timeout 120000 --isolate`
from a staging dir (`.tmp/cloud-unit-bun`, own `bunfig.toml`) with
`SKIP_DB_DEPENDENT=1 SKIP_SERVER_CHECK=true NODE_ENV=test`.

- **Added roots alone, under that exact mechanism:** `104 pass / 0 fail` (7 files).
- **Baseline (original 3 roots):** `2479 pass / 37 skip / 2 fail / 1 error`.
- **With routing + infra (this PR):** `2583 pass / 37 skip / 2 fail / 1 error`.

Delta: **+104 passing tests, zero new failures.** The 2 pre-existing fails + 1
error live in `cloud/shared` / `cloud/api` (unchanged by this PR) and are
local-macOS artifacts — a test shelling to GNU `sed -i` (BSD `sed` on macOS) and
a Bun partial-`mock.module` `Export named 'dbRead' not found` link error. Neither
occurs on CI's Linux `cloud-setup-test-env`, and neither is in the added suites.
Captured output: `run-summaries.txt`.

- `node --check packages/scripts/test-cloud-run.mjs` — clean.
- `bunx @biomejs/biome@2.5.1 check packages/scripts/test-cloud-run.mjs` — exit 0.

Screenshots/video/native capture: **N/A** — repository test-orchestration script +
workflow trigger only; no UI, runtime, or device surface. Evidence is the
before/after test counts above.
