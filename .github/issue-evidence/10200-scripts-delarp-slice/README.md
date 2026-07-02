# #10200 scripts de-larp slice — dead per-package script removal

Fresh audit of `scripts/`, `packages/scripts/`, and (uncovered by the inventory
tool) `packages/*/scripts` + `plugins/*/scripts` for the three de-larp axes.

## Axis results

| Axis | Finding |
|---|---|
| **Larp catch-verifiers** (`main().catch(console.error)` → logs but exits 0) | **0 remaining** — all fixed by prior slice #11548. Re-verified on develop tip `bc0dd00640`. |
| **`\|\| true` in verify paths** | 42 occurrences; every one is legitimate best-effort (`command -v X \|\| true` binary probes, idempotent `sed`/`cp` cleanup, `grep -c` no-match). No swallowed verify assertion found. Deferred (matches #11548's per-callsite-judgement note). |
| **Trivially-safe dupes** | `check-i18n.mjs` / `check-secret-hygiene.mjs` exist in both `packages/scripts/` and `packages/app-core/scripts/` but have **diverged** (in-repo `../..` root resolution vs fork `process.cwd()` — intentionally separate invocation contexts). NOT safe to dedupe. |
| **Dead scripts** (0 refs tree-wide: no package.json script, no `.github/workflows`, no import, no README/doc — proven via `git grep -l <basename>` excluding self) | **6 removed** (below). |

## Dead scripts removed (each 0 references, proven via `git grep -l`)

- `plugins/plugin-training/scripts/gepa-view-switching.ts` — completed GEPA/bootstrap-fewshot view-switching experiment one-off. plugin-training `package.json` wires `gepa:view-context` (→ `gepa-view-context.ts`, kept) and `verify:view-switching` (kept) but **not** this file. Same class as the GEPA eval one-offs deleted in #11548.
- `plugins/plugin-training/scripts/multishot-view-switching.ts` — completed multi-shot-demo finding experiment; not in `package.json`, zero refs.
- `packages/app/scripts/android-webview-attach-probe.mjs` — one-time "de-risk probe" proving Playwright's Android driver can attach to the Capacitor WebView; the real on-device harness now exists, probe is unreferenced.
- `packages/benchmarks/social-alpha/trenches-chat-dataset/scripts/monitor_progress.sh` — manual `watch`-loop helper for a price-fetch run; README documents the pipeline as only `build_dataset.ts` + `fetch_price_history.ts`; zero refs.
- `packages/benchmarks/social-alpha/trenches-chat-dataset/scripts/calculate_success_metrics.ts` — one-time dataset success-metric analysis; not in the README pipeline, not imported by `build_dataset.ts`, zero refs.
- `packages/benchmarks/social-alpha/trenches-chat-dataset/scripts/calculate_realistic_success_metrics.ts` — iterated near-duplicate of the above ("Updated realistic thresholds"); zero refs.

## Verification

- Per-file reference proof: `git grep -l "<basename>"` returns only the file itself for all 6 (captured pre-deletion).
- None of the 6 are `*.test.*` / `*.spec.*` — not picked up by any Vitest/Playwright test glob.
- All 6 are standalone entrypoints with no importers, so deletion cannot affect any package build or typecheck.
- `plugins/plugin-training` retains its wired harnesses (`gepa-view-context.ts`, `verify-view-switching.ts`, `verify-view-switching.grid.test.ts`, `lifeops-gepa-*`, `trajectory-quality-review.ts`).
- Trenches README pipeline (`build_dataset.ts`, `fetch_price_history.ts`) untouched.

## Honest scope note

Prior #10200 slices (#10479, #10681, #11548, #11367, …) already exhausted the
safe dead-script surface in `scripts/` and `packages/scripts/`, fixed all
silent-`exit 0` catch handlers, and corrected the inventory orphan model. The
remaining per-package `packages/*/scripts` orphans are overwhelmingly
manually-run operator/dev/QA/migration tools (the #11367 lesson: hand-run
entrypoints are false orphans), which this slice deliberately leaves in place.
The 6 removed here are the airtight completed-throwaway subset.
