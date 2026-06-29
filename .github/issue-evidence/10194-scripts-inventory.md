# #10194 — build/scripts declutter: inventory + report-builder cluster removal

De-larp of `packages/scripts/`. This pass delivers the **inventory tool**, the
**report-builder cluster deletion**, and the **extended orphan guard**. The
risky dev-orchestrator / `run-all-tests.mjs` consolidation is **deferred** (see
below) to keep `verify` green and avoid behavior drift.

## Inventory tool

`node packages/scripts/audit-scripts-inventory.mjs` (root alias
`bun run audit:scripts:inventory`) classifies every `packages/scripts/*.mjs`
file and every root `package.json` script as `reachable-from-verify`,
`reachable-from-test`, `reachable-from-build`, `reachable-from-ci-workflow`, or
`orphan`. It follows the root-script call graph (`bun run X`), `.github/`
workflow references, and spawnSync/exec/import/string references between script
files. Machine-readable output is written to the gitignored
`reports/scripts-inventory.json`.

## Before / after

| Metric | Before | After | Δ |
| --- | ---: | ---: | ---: |
| `packages/scripts/*.mjs` files | 129 | 77 | −52 |
| `packages/scripts/*.mjs` LOC | 44,252 | 21,238 | −23,014 |
| root `package.json` scripts | 200 | 199 | −2 net (+1 inventory, −2 bench:analysis) |

> File/LOC counts measured by `wc -l packages/scripts/*.mjs`. The inventory tool
> reports the same totals.

Inventory category breakdown (after):

| category | files | LOC | roots |
| --- | ---: | ---: | ---: |
| reachable-from-verify | 15 | 5,826 | 8 |
| reachable-from-test | 2 | 1,193 | 1 |
| reachable-from-build | 2 | 388 | 2 |
| reachable-from-ci-workflow | 31 | 9,036 | 55 |
| orphan | 27 | 4,795 | 133 |
| **TOTAL** | **77** | **21,238** | **199** |

(The "orphan" rows here reflect the inventory's strict *transitive-reachability*
model — many are legitimate human-run entrypoints in allowlisted namespaces that
`audit-scripts.mjs` recognizes; the inventory is a quantification report, not the
deletion gate.)

## What was deleted (52 files, 23,014 LOC)

The dead **benchmark/scenario/live-test/corpus/review report-builder cluster** —
AI-generated HTML/markdown report generators that nothing in `verify`, `test`,
`build`, or any `.github/` workflow ran, writing only into the gitignored
`reports/benchmark-analysis/`. The whole cluster was reachable solely through two
unused npm scripts:

- `bench:analysis:build` → `build-benchmark-analysis-reports.mjs` (spawned 49
  sub-builders via `spawnSync`).
- `bench:analysis:verify` → `verify-benchmark-analysis-reports.mjs`.

Removed:

- `build-benchmark-analysis-reports.mjs` (entrypoint) + its 49 spawned builders
  (`build-benchmark-*`, `build-scenario-*`, `build-live-test-*`,
  `build-corpus-*`, `build-review-*`, plus `build-final-goal-readiness-gate`,
  `build-global-playback-index`, `build-manual-review-progress-board`,
  `build-rerun-batch-scripts`, `build-rerun-command-catalog`).
- `verify-benchmark-analysis-reports.mjs` (the `bench:analysis:verify` sibling).
- `mirror-benchmark-run-artifacts.mjs` — pure spawnSync/cpSync plumbing for the
  deleted cluster, left with zero referencers after the cluster was removed.

Both `bench:analysis:build` and `bench:analysis:verify` were removed from root
`package.json`. Confirmed via `git grep` that **no** reference to any deleted
file or to `bench:analysis` remains anywhere in the repo (package.json,
`.github/`, other scripts, docs).

## Extended orphan guard

`audit-scripts.mjs` (`bun run audit:scripts`, part of `verify`) gained check
**(d)**: any `packages/scripts/*.mjs` referenced by nothing — no root alias, no
CI workflow, no docs, no other reachable script — now fails the audit. This
prevents the cluster from silently regrowing. A small `ORPHAN_SCRIPT_FILE_ALLOWLIST`
keeps standalone human-run diagnostic/guard tools (`audit-bin-export-subpaths`,
`benchmark-to-training-dataset`, `check-i18n`, `check-secret-hygiene`,
`dev-health-check`, `triage-tests`, `run-live-test-with-artifacts`), each with a
written reason.

Guard demo (acceptance criterion): dropping a deliberately-orphaned
`zzz-deliberate-orphan-demo.mjs` into `packages/scripts/` makes the audit emit
`[orphan-file] …`; removing it returns the audit to
`[audit-scripts] OK — no orphan/no-op/broken scripts.`

## Verification

- `node packages/scripts/audit-scripts-inventory.mjs` — runs, prints counts,
  writes `reports/scripts-inventory.json` (gitignored).
- `bun run audit:scripts` — **OK** (orphan/no-op/broken + new orphan-file checks).
- `node packages/scripts/audit-scripts.self-test.mjs` — **passed**.
- `git grep` for deleted filenames / `bench:analysis` — **clean**.
- `bunx biome check` on the two changed scripts — clean after format.

## Deferred (explicitly out of this pass)

- **Dev orchestrator consolidation** (`dev-ui.mjs` 1,420 lines, `dev-all.mjs`
  646, `dev-harness.mjs`, `dev-agent-watch.mjs`, `dev-views.mjs`, `dev.mjs`) —
  six overlapping launchers. Collapsing them risks breaking the live dev loop;
  needs its own scoped change with a documented boundary.
- **`run-all-tests.mjs`** (1,080 lines) line-count reduction — behavior-critical
  test orchestrator; out of scope here.
- **`build.ts` consolidation** — owned by #10078, not touched.
