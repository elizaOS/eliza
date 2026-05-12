# Wave 01 - Search Pollution and Generated Artifacts Dry Run

Date: 2026-05-11
Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Worker: Wave 1
Mode: dry run only

This report is non-destructive. No source, config, test, asset, route,
package, generated output, or benchmark file was edited, moved, renamed, or
deleted while preparing it. The only intended write from this worker is this
markdown file.

## Scope

Wave 01 covers files and directories that make repository search noisy because
they are generated, duplicated by build output, local benchmark output, rendered
audit output, or machine-generated report evidence.

In scope:

- Ignored local build and cache directories such as `.turbo/`, `dist/`,
  `build/`, `.vite/`, and `.next/`.
- Ignored benchmark run outputs under `packages/benchmarks/benchmark_results/`.
- Ignored local logs, media, sqlite files, and generated keyword/homepage
  output.
- Tracked generated catalogs and specs that are likely required by runtime or
  packaging and therefore need owner review rather than immediate deletion.
- Tracked audit/report artifacts that may be useful historical evidence but
  pollute text search.
- Current dirty generated/report files so later cleanup does not overwrite
  other workers.

Out of scope:

- Any deletion or rename during this dry run.
- Any source, config, or test edits to change ignore rules or search config.
- Any cleanup of LifeOps behavior, task primitives, health plugin integration,
  or scheduled-task contracts. Those are governed by later waves and the root
  `AGENTS.md` constraints.
- Any attempt to decide whether generated source files should be committed
  without an owner decision and regeneration proof.

## Inspection Commands Used

Read-only commands used for this manifest:

```sh
git status --short
git status --ignored --short
git ls-files
git ls-files -o -i --exclude-standard
git ls-files -o --exclude-standard
git check-ignore -v <paths>
rg --files
rg --files -g '.gitignore'
rg -n '<pattern>' <paths>
```

No destructive command was run.

## Repository State Observed

The worktree was already dirty before this report. Relevant dirty/generated
items observed:

- Modified tracked rendered audit output:
  `docs/audits/response-handler-and-evaluator-systems-2026-05-11.html`.
- Modified tracked generated/action catalog files:
  `packages/core/src/generated/action-docs.ts` and
  `packages/prompts/specs/actions/plugins.generated.json`.
- Modified tracked benchmark latest files:
  `packages/benchmarks/benchmark_results/latest/hermes_swe_env__eliza.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_swe_env__hermes.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_swe_env__openclaw.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_tblite__eliza.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_tblite__hermes.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_tblite__openclaw.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_terminalbench_2__eliza.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_terminalbench_2__hermes.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_terminalbench_2__openclaw.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_yc_bench__eliza.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_yc_bench__hermes.json`,
  `packages/benchmarks/benchmark_results/latest/hermes_yc_bench__openclaw.json`,
  and `packages/benchmarks/benchmark_results/latest/index.json`.
- Untracked dry-run reports appeared under
  `docs/audits/repo-cleanup-2026-05-11/` while this worker was inspecting:
  `README.md`, `wave-07-naming-text-cleanup.md`, and
  `wave-08-final-validation-signoff.md`. They were not touched by this worker.

Ignored/generated count snapshot from `git status --ignored --short`:

| Category | Count observed |
| --- | ---: |
| Ignored entries total | 2447 |
| Ignored `.turbo/` directories | 192 |
| Ignored `dist/` directories | 180 |
| Ignored `build/` directories | 20 |
| Ignored `.vite/` directories | 1 |
| Ignored `.next/` directories | 1 |
| Ignored entries under `packages/benchmarks/benchmark_results/` | 575 |
| Ignored benchmark `rg_*` run directories | 571 |
| Ignored inference report media/log files | 2 |
| Ignored hardware verification logs | 12 |
| Ignored `packages/shared/src/i18n/generated/` entry | 1 |
| Ignored `packages/homepage/src/generated/` entry | 1 |

Tracked generated/report count snapshot:

| Category | Count observed |
| --- | ---: |
| Tracked files matching generated-name patterns | 355 |
| Tracked files in `packages/benchmarks/benchmark_results/latest/*.json` | 151 |
| Tracked files under `docs/audits/lifeops-2026-05-11/` | 1007 |
| Tracked prompt-review markdown files under `docs/audits/lifeops-2026-05-11/prompts/` | 989 |
| Tracked files under `reports/**` | 105 |
| Tracked files under `packages/inference/reports/**` | 59 |

## Candidate Manifest

### C01 - Ignored Build and Tool Cache Directories

Status: ignored, untracked local output
Risk: low for local removal, low repository risk
Recommendation: removable locally after a final `git clean -ndX` review.

Exact candidate path families observed:

- `.turbo/`
- `dist/`
- `**/.turbo/`
- `**/dist/`
- `**/build/`
- `**/.vite/`
- `**/.next/`

Representative exact directories observed:

- `cloud/apps/frontend/dist/`
- `cloud/packages/billing/dist/`
- `cloud/packages/sdk/.turbo/`
- `cloud/packages/sdk/dist/`
- `cloud/packages/ui/dist/`
- `cloud/services/_smoke-mcp/dist/`
- `packages/agent/.turbo/`
- `packages/agent/dist/`
- `packages/app-core/.turbo/`
- `packages/app-core/dist/`
- `packages/app-core/platforms/android/app/build/`
- `packages/app-core/platforms/android/build/`
- `packages/app-core/platforms/android/capacitor-cordova-android-plugins/build/`
- `packages/app-core/platforms/electrobun/.turbo/`
- `packages/app-core/platforms/electrobun/build/`
- `packages/app/.turbo/`
- `packages/app/.vite/`
- `packages/app/dist/`
- `packages/browser-bridge/.turbo/`
- `packages/browser-bridge/dist/`
- `packages/core/.turbo/`
- `packages/core/dist/`
- `packages/prompts/.turbo/`
- `packages/prompts/dist/`
- `packages/shared/.turbo/`
- `packages/shared/dist/`
- `packages/ui/.turbo/`
- `packages/ui/dist/`
- `plugins/app-lifeops/.turbo/`
- `plugins/app-lifeops/dist/`
- `plugins/plugin-health/.turbo/`
- `plugins/plugin-health/dist/`
- `plugins/plugin-openai/.turbo/`
- `plugins/plugin-openai/dist/`
- `plugins/plugin-discord/.turbo/`
- `plugins/plugin-discord/dist/`

Why removable:

- These are ignored by repo or package-level `.gitignore` rules.
- They are build products or cache directories.
- Removing them should not produce a git diff.

Why review:

- Removal can force rebuilds and slow down other workers.
- Some ignored `dist/` directories may currently back a local dev server or
  package smoke test.

Non-destructive validation commands:

```sh
git status --ignored --short | sed -n 's/^!! //p' | rg '(^|/)(\.turbo|dist|build|\.vite|\.next)/$'
git clean -ndX . | rg '(^Would remove .*\.turbo/|^Would remove .*dist/|^Would remove .*build/|^Would remove .*\.vite/|^Would remove .*\.next/)'
git status --short
```

Owner questions:

- Is any local dev server depending on one of the ignored `dist/` directories?
- Should cleanup happen per package to avoid invalidating every worker cache at
  once?

### C02 - Ignored Benchmark Run Outputs

Status: ignored, untracked local benchmark output
Risk: low for local removal, medium if another worker still needs local run
evidence
Recommendation: removable locally after owner confirmation that no active
benchmark worker needs the current run directories.

Exact candidate paths observed:

- `benchmark_results/`
- `packages/benchmark_results/`
- `packages/benchmarks/benchmark_results/rg_*/` - 571 ignored run directories
  matching this exact prefix pattern.
- `packages/benchmarks/benchmark_results/configbench_sql/`
- `packages/benchmarks/benchmark_results/orchestrator.sqlite`
- `packages/benchmarks/benchmark_results/orchestrator.sqlite-shm`
- `packages/benchmarks/benchmark_results/orchestrator.sqlite-wal`
- `packages/benchmarks/benchmark_results/viewer_data.json`
- `packages/benchmarks/benchmark_results/.DS_Store`
- `packages/benchmarks/gaia/benchmark_results/`
- `packages/benchmarks/rlm-bench/benchmark_results/`
- `packages/benchmarks/terminal-bench/benchmark_results/`
- `packages/benchmarks/vending-bench/benchmark_results/`
- `packages/benchmarks/webshop/benchmark_results/`

Git ignore evidence:

- `.gitignore:456:benchmark_results/`
- `packages/benchmarks/.gitignore:60:/benchmark_results/rg_*/`
- `packages/benchmarks/.gitignore:61:/benchmark_results/orchestrator.sqlite*`
- `packages/benchmarks/.gitignore:62:/benchmark_results/viewer_data.json`
- `packages/benchmarks/.gitignore:50:/benchmark_results/*`
- `packages/benchmarks/.gitignore:48:**/benchmark_results*/`

Why removable:

- These are local run groups, sqlite state, generated viewer data, and OS
  metadata.
- They are explicitly ignored by benchmark `.gitignore` rules.

Why review:

- Active benchmark workers may need local run state for analysis.
- `configbench_sql/` appears to contain a generated database directory, not just
  small JSON summaries. It should be removed only when no process uses it.

Non-destructive validation commands:

```sh
git status --ignored --short | sed -n 's/^!! //p' | rg '^packages/benchmarks/benchmark_results/'
git status --ignored --short | sed -n 's/^!! //p' | rg '^packages/benchmarks/benchmark_results/rg_[^/]+/$' | wc -l
git status --ignored --short | sed -n 's/^!! //p' | rg '(^|/)benchmark_results'
git check-ignore -v packages/benchmarks/benchmark_results/rg_20260511T183117Z_5416bd7d/
git check-ignore -v packages/benchmarks/benchmark_results/orchestrator.sqlite
git clean -ndX benchmark_results packages/benchmark_results packages/benchmarks/benchmark_results packages/benchmarks/gaia/benchmark_results packages/benchmarks/rlm-bench/benchmark_results packages/benchmarks/terminal-bench/benchmark_results packages/benchmarks/vending-bench/benchmark_results packages/benchmarks/webshop/benchmark_results
```

Owner questions:

- Are any `rg_*` directories still needed to debug current benchmark changes?
- Are the root `benchmark_results/` and `packages/benchmark_results/` folders
  stale duplicates of the package-scoped benchmark output?
- Should benchmark workers archive summary JSON elsewhere before local cleanup?
- Is `configbench_sql/` safe to clear, or is a Postgres process still using it?

### C03 - Ignored Generated Keyword/Homepage Output

Status: ignored, untracked local generated output
Risk: low if regeneration commands are available
Recommendation: removable locally, but only after confirming no active command
is writing to these directories.

Exact candidate paths observed:

- `packages/shared/src/i18n/generated/`
- `packages/homepage/src/generated/`

Git ignore evidence:

- `.gitignore:264:packages/shared/src/i18n/generated/`
- `packages/homepage/.gitignore:48:src/generated/`

Why removable:

- Both paths are ignored and described by ignore rules as generated output.
- The root package script includes
  `generate:action-search-keywords`, and `packages/core/package.json` has a
  prebuild guard for generated validation keyword data.

Why review:

- Generated i18n keyword files may be required locally for current builds.
- Removing without immediate regeneration may produce local build failures until
  the proper script runs.

Non-destructive validation commands:

```sh
git status --ignored --short | sed -n 's/^!! //p' | rg '^(packages/shared/src/i18n/generated/|packages/homepage/src/generated/)'
git check-ignore -v packages/shared/src/i18n/generated/
git check-ignore -v packages/homepage/src/generated/
rg -n 'generate:action-search-keywords|generate-keywords|src/generated' package.json packages/core/package.json packages/homepage/.gitignore
```

Owner questions:

- Should generated keyword output remain ignored and regenerated on demand?
- Does the homepage prebuild always regenerate `packages/homepage/src/generated/`
  before any deployment or preview build?

### C04 - Ignored Inference Logs and Media

Status: ignored, untracked local verification output
Risk: low for local cleanup after owner approval
Recommendation: removable locally if the inference/hardware owner has captured
the important results in tracked markdown or JSON.

Exact candidate paths observed:

- `packages/inference/reports/local-e2e/2026-05-11/voice-loop-trials/eliza-local-voice-smoke_seed42.tts.log`
- `packages/inference/reports/local-e2e/2026-05-11/voice-loop-trials/eliza-local-voice-smoke_seed42.wav`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T044002Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T044009Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T044024Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T044109Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T044137Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T050934Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T060435Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T060510Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T062056Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T133104Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T133109Z.log`
- `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T140828Z.log`

Git ignore evidence:

- `.gitignore:55:*.wav`
- `.gitignore:193:*.log`

Why removable:

- These are ignored run artifacts, not tracked reports.
- The tracked inference reports already include JSON and markdown summaries
  under `packages/inference/reports/**`.

Why review:

- Hardware logs may be the only raw evidence for a device-specific failure.
- The `.wav` file may be useful for voice-quality debugging even though it is
  ignored.

Non-destructive validation commands:

```sh
git status --ignored --short | sed -n 's/^!! //p' | rg '^packages/inference/(reports|verify)/.*\.(log|wav)$'
git check-ignore -v packages/inference/reports/local-e2e/2026-05-11/voice-loop-trials/eliza-local-voice-smoke_seed42.wav
git check-ignore -v packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T044002Z.log
git clean -ndX packages/inference/reports packages/inference/verify/hardware-results
```

Owner questions:

- Has the inference owner summarized these raw logs in tracked evidence?
- Are the hardware timestamps tied to a currently unresolved device issue?

### C05 - Tracked Benchmark Latest JSON

Status: tracked; 151 files; 13 modified in current worktree
Risk: medium
Recommendation: needs benchmark owner decision. Do not remove during Wave 01
without confirming whether these are official published baselines.

Exact candidate directory:

- `packages/benchmarks/benchmark_results/latest/`

Exact modified files observed:

- `packages/benchmarks/benchmark_results/latest/hermes_swe_env__eliza.json`
- `packages/benchmarks/benchmark_results/latest/hermes_swe_env__hermes.json`
- `packages/benchmarks/benchmark_results/latest/hermes_swe_env__openclaw.json`
- `packages/benchmarks/benchmark_results/latest/hermes_tblite__eliza.json`
- `packages/benchmarks/benchmark_results/latest/hermes_tblite__hermes.json`
- `packages/benchmarks/benchmark_results/latest/hermes_tblite__openclaw.json`
- `packages/benchmarks/benchmark_results/latest/hermes_terminalbench_2__eliza.json`
- `packages/benchmarks/benchmark_results/latest/hermes_terminalbench_2__hermes.json`
- `packages/benchmarks/benchmark_results/latest/hermes_terminalbench_2__openclaw.json`
- `packages/benchmarks/benchmark_results/latest/hermes_yc_bench__eliza.json`
- `packages/benchmarks/benchmark_results/latest/hermes_yc_bench__hermes.json`
- `packages/benchmarks/benchmark_results/latest/hermes_yc_bench__openclaw.json`
- `packages/benchmarks/benchmark_results/latest/index.json`

Tracked status evidence:

- `git ls-files 'packages/benchmarks/benchmark_results/latest/*.json'` returned
  151 files.
- `packages/benchmarks/.gitignore` explicitly keeps
  `/benchmark_results/latest/**` while ignoring most other benchmark output.

Why potentially removable:

- They are generated benchmark result snapshots and add large JSON noise to
  search results.
- The repo already ignores ad-hoc benchmark output elsewhere.

Why review:

- The `.gitignore` exception indicates these may be intentionally committed as
  canonical latest results.
- Current modifications imply another worker or benchmark run is actively
  changing part of this directory.
- Removing them may break benchmark viewer assumptions or published docs.

Non-destructive validation commands:

```sh
git ls-files 'packages/benchmarks/benchmark_results/latest/*.json' | wc -l
git status --short 'packages/benchmarks/benchmark_results/latest'
rg -n 'benchmark_results/latest|latest/index.json|viewer_data|benchmark_results' packages/benchmarks docs packages/docs
git diff --stat -- packages/benchmarks/benchmark_results/latest
```

Owner questions:

- Are `latest/*.json` files release artifacts that must stay tracked?
- If they remain tracked, should repo search tooling exclude this directory?
- If they should be removed, what command regenerates a complete `latest/`
  dataset, and which CI job verifies it?

### C06 - Tracked LifeOps Audit Prompt Explosion

Status: tracked; 1007 files under `docs/audits/lifeops-2026-05-11/`; 989
prompt markdown files under `prompts/`
Risk: medium
Recommendation: needs LifeOps/docs owner decision. This is search pollution,
but it is historical audit evidence. Prefer keeping summaries and manifests, or
moving generated prompt detail to an archive, only after signoff.

Exact candidate paths:

- `docs/audits/lifeops-2026-05-11/prompts/`
- `docs/audits/lifeops-2026-05-11/prompts/INDEX.md`
- `docs/audits/lifeops-2026-05-11/prompts-manifest.json`
- `docs/audits/lifeops-2026-05-11/action-collisions.json`
- `docs/audits/lifeops-2026-05-11/action-collisions.md`
- `docs/audits/lifeops-2026-05-11/INDEX.md`

Why potentially removable or archivable:

- The per-prompt markdown files are generated audit leaves, often one file per
  prompt field.
- The directory contributes hundreds of search hits for action and parameter
  names.

Why review:

- `docs/audits/lifeops-2026-05-11/INDEX.md` points to the prompt manifest and
  prompt directory as audit evidence.
- Scripts in `scripts/lifeops-prompt-review.mjs`,
  `scripts/lifeops-prompt-inventory.mjs`, and tests under `scripts/__tests__`
  know about this audit path.
- LifeOps has strict architecture constraints in `AGENTS.md`; cleanup must not
  obscure evidence about prompt content versus structural behavior.

Non-destructive validation commands:

```sh
git ls-files 'docs/audits/lifeops-2026-05-11/**' | wc -l
git ls-files 'docs/audits/lifeops-2026-05-11/prompts/*.md' | wc -l
rg -n 'docs/audits/lifeops-2026-05-11|prompts-manifest|lifeops-prompt' docs scripts plugins/app-lifeops packages/benchmarks
git log --oneline -- docs/audits/lifeops-2026-05-11/prompts | head
```

Owner questions:

- Should per-prompt markdown leaves be retained in git, compressed into a
  single manifest, or moved to an external artifact store?
- Which audit files are required for future LifeOps review?
- Can search tooling exclude `docs/audits/lifeops-2026-05-11/prompts/` while
  preserving the evidence in git?

### C07 - Tracked Rendered HTML Audit Output

Status: tracked; modified in current worktree
Risk: medium
Recommendation: needs docs/audit owner decision. Do not touch while modified.

Exact candidate path:

- `docs/audits/response-handler-and-evaluator-systems-2026-05-11.html`

Why potentially removable:

- It is rendered HTML under docs audits, likely generated from another source or
  analysis flow.
- HTML audit exports are noisy in text search compared with markdown sources.

Why review:

- The file is currently modified by someone else.
- There may not be a checked-in markdown/source equivalent.
- Deleting rendered audit evidence could remove the only browsable version of
  that audit.

Non-destructive validation commands:

```sh
git status --short docs/audits/response-handler-and-evaluator-systems-2026-05-11.html
git diff --stat -- docs/audits/response-handler-and-evaluator-systems-2026-05-11.html
rg -n 'response-handler-and-evaluator-systems-2026-05-11' docs packages plugins scripts
```

Owner questions:

- Is there a canonical markdown/source file for this HTML report?
- Should rendered HTML audit files be kept, archived, or ignored going forward?

### C08 - Tracked Root `reports/` Evidence

Status: tracked; 105 files under `reports/**`
Risk: medium
Recommendation: keep until docs/porting owner signs off. This is search
pollution, but many docs link to it directly.

Exact candidate paths:

- `reports/barrel-audit.json`
- `reports/barrel-audit.md`
- `reports/path-alias-audit.json`
- `reports/path-alias-audit.md`
- `reports/porting/2026-05-09-baseline/`
- `reports/porting/2026-05-09-unified/`
- `reports/porting/2026-05-09-w2/`
- `reports/porting/2026-05-09-w3/`
- `reports/porting/2026-05-09-w4/`
- `reports/porting/2026-05-10/`

Why potentially removable or archivable:

- These are generated command reports, logs, PTX/SPV samples, symbol listings,
  md5 listings, and benchmark profiles.
- They add many matches for build, kernel, symbol, and benchmark terms.

Why review:

- `docs/porting/CURRENT-STATE.md`, `docs/porting/build-matrix.md`, and
  `docs/porting/CLEANUP-LEDGER.md` link directly to these paths.
- Some source comments and verification docs point to report files as evidence.
- The reports may be required for hardware/kernel audit traceability.

Non-destructive validation commands:

```sh
git ls-files 'reports/**' | wc -l
git ls-files 'reports/**'
rg -n 'reports/porting|reports/barrel-audit|reports/path-alias-audit' docs packages plugins scripts
git log --oneline -- reports | head
```

Owner questions:

- Are root `reports/porting/**` files required as permanent evidence?
- Should the repo keep only index/summary files and move raw samples/logs
  elsewhere?
- If archived, what link strategy keeps existing docs valid?

### C09 - Tracked Inference Report Evidence

Status: tracked; 59 files under `packages/inference/reports/**`
Risk: medium
Recommendation: keep until inference owner decides retention policy.

Exact candidate paths:

- `packages/inference/reports/porting/2026-05-10/`
- `packages/inference/reports/porting/2026-05-11/`
- `packages/inference/reports/local-e2e/2026-05-11/`

Representative exact tracked files:

- `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`
- `packages/inference/reports/porting/2026-05-11/fused-attn-op-contract.md`
- `packages/inference/reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md`
- `packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.md`
- `packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.json`
- `packages/inference/reports/local-e2e/2026-05-11/local-e2e-smoke-report.json`
- `packages/inference/reports/local-e2e/2026-05-11/eval-suite-run/README.md`

Why potentially removable or archivable:

- Many files are generated run reports and local E2E result JSON.
- They create search noise around model names, devices, kernels, and smoke test
  terms.

Why review:

- Inference source, verification docs, and training scripts reference these
  reports.
- Some files are design/contract documents, not merely generated output.
- Hardware evidence may be difficult to reproduce.

Non-destructive validation commands:

```sh
git ls-files 'packages/inference/reports/**' | wc -l
git ls-files 'packages/inference/reports/**'
rg -n 'packages/inference/reports|reports/porting/2026-05-11|remaining-work-ledger|fused-attn-op-contract' packages/inference packages/app-core packages/training docs scripts
```

Owner questions:

- Which inference reports are contractual docs versus disposable run artifacts?
- Should local E2E JSON be retained in git or published outside the source tree?
- Is there a minimum evidence set required for hardware verification?

### C10 - Tracked Generated Source and Specs

Status: tracked; 355 generated-name files total; some modified in current
worktree
Risk: high for deletion
Recommendation: do not remove in Wave 01. Treat as generated source or package
fixtures unless an owner provides a regeneration contract and CI proof.

Exact generated source/spec directories and counts observed:

| Path | Count |
| --- | ---: |
| `cloud/apps/api/src/` generated router files | 1 |
| `cloud/services/operator/capabilities/crd/generated/` | 1 |
| `packages/app-core/scripts/generated/` | 1 |
| `packages/core/src/features/advanced-capabilities/experience/generated/specs/` | 2 |
| `packages/core/src/generated/` | 2 |
| `packages/core/src/i18n/generated/` | 1 |
| `packages/prompts/specs/actions/` generated JSON | 1 |
| `packages/shared/src/i18n/keywords/` generated keyword JSON | 1 |
| `plugins/app-lifeops/src/lifeops/i18n/generated/` | 192 |
| `plugins/plugin-anthropic/generated/specs/` | 1 |
| `plugins/plugin-anthropic/python/elizaos_plugin_anthropic/generated/specs/` | 2 |
| `plugins/plugin-anthropic/rust/src/generated/specs/` | 2 |
| `plugins/plugin-discord/generated/specs/` | 2 |
| `plugins/plugin-elizacloud/generated/specs/` | 1 |
| `plugins/plugin-farcaster/generated/specs/` | 2 |
| `plugins/plugin-google-genai/generated/specs/` | 1 |
| `plugins/plugin-groq/generated/specs/` | 1 |
| `plugins/plugin-inmemorydb/generated/specs/` | 1 |
| `plugins/plugin-instagram/generated/specs/` | 1 |
| `plugins/plugin-linear/generated/specs/` | 1 |
| `plugins/plugin-local-ai/generated/specs/` | 1 |
| `plugins/plugin-mcp/generated/specs/` | 1 |
| `plugins/plugin-minecraft/generated/specs/` | 1 |
| `plugins/plugin-ollama/generated/specs/` | 1 |
| `plugins/plugin-openai/generated/specs/` | 1 |
| `plugins/plugin-openrouter/generated/specs/` | 1 |
| `plugins/plugin-pdf/generated/specs/` | 1 |
| `plugins/plugin-roblox/generated/specs/` | 1 |
| `plugins/plugin-shell/generated/specs/` | 4 |
| `plugins/plugin-sql/src/generated/specs/` | 1 |
| `plugins/plugin-tee/generated/specs/` | 1 |
| `plugins/plugin-vision/generated/specs/` | 1 |
| `plugins/plugin-wallet/src/chains/evm/generated/specs/` | 2 |
| `plugins/plugin-wallet/src/chains/solana/generated/specs/` | 2 |

Exact dirty generated files observed:

- `packages/core/src/generated/action-docs.ts`
- `packages/prompts/specs/actions/plugins.generated.json`

Why potentially removable:

- Generated source/spec files are search noise by nature.
- Some may be regenerated from action specs or translation scripts.

Why review:

- `packages/core/src/action-docs.ts`, `packages/core/src/actions.ts`, tests,
  and public exports import `packages/core/src/generated/action-docs.ts`.
- `packages/prompts/package.json` defines build scripts that generate
  `plugins.generated.json` and action docs.
- `plugins/app-lifeops/docs/audit/translation-harness.md` documents generated
  i18n files under `plugins/app-lifeops/src/lifeops/i18n/generated/`.
- Removing generated source files can break package builds, published package
  contents, runtime imports, Python/Rust plugin wrappers, and TypeScript
  declaration consumers.

Non-destructive validation commands:

```sh
git ls-files | rg '(^|/)(generated|__generated__)(/|$)|generated\.|\.generated\.'
git ls-files | rg '(^|/)(generated|__generated__)(/|$)|generated\.|\.generated\.' | wc -l
rg -n 'generated/action-docs|plugins\.generated\.json|generated/specs|lifeops/i18n/generated' packages plugins cloud scripts docs
git status --short | rg 'generated|\.generated\.'
```

Regeneration commands to validate before any future deletion proposal:

```sh
bun --cwd packages/prompts run build
bun run generate:action-search-keywords
bun --cwd packages/core run build
bun --cwd plugins/app-lifeops run verify
```

Owner questions:

- Which generated source/spec files are intentionally checked in for package
  consumers?
- Which generated files can be recreated deterministically in CI?
- Should search tooling exclude generated source directories instead of
  deleting them?
- Who owns current modifications to `action-docs.ts` and
  `plugins.generated.json`?

## Proposed Non-Destructive Validation Suite

Run these before any implementation PR:

```sh
git status --short
git status --ignored --short | sed -n 's/^!! //p' | rg '(^|/)(\.turbo|dist|build|\.vite|\.next)/$'
git status --ignored --short | sed -n 's/^!! //p' | rg '^packages/benchmarks/benchmark_results/'
git status --ignored --short | sed -n 's/^!! //p' | rg '^packages/inference/(reports|verify)/.*\.(log|wav)$'
git ls-files 'packages/benchmarks/benchmark_results/latest/*.json' | wc -l
git ls-files 'docs/audits/lifeops-2026-05-11/**' | wc -l
git ls-files 'reports/**' | wc -l
git ls-files 'packages/inference/reports/**' | wc -l
git ls-files | rg '(^|/)(generated|__generated__)(/|$)|generated\.|\.generated\.' | wc -l
rg -n 'reports/porting|packages/inference/reports|benchmark_results/latest|docs/audits/lifeops-2026-05-11|generated/action-docs|plugins\.generated\.json' docs packages plugins scripts cloud
git clean -ndX .
```

Expected result for this dry run:

- `git clean -ndX .` should only print ignored files/directories.
- Tracked files must not appear in `git clean -ndX .` output.
- Any tracked candidate deletion requires a separate owner-approved PR.
- Dirty tracked files must be either committed by their owner or explicitly
  excluded from cleanup.

## Risk Register

| Risk | Level | Notes |
| --- | --- | --- |
| Removing ignored build/cache output breaks active local processes | Low | Avoid while dev servers or benchmark runs are active. |
| Removing ignored benchmark run dirs loses raw local evidence | Medium | Confirm active workers no longer need `rg_*` directories or sqlite state. |
| Removing tracked benchmark `latest` files breaks viewer/docs | Medium | `.gitignore` keeps `latest/**`, which signals intentional tracking. |
| Removing tracked audit prompt files loses LifeOps review evidence | Medium | Scripts and audit indexes reference the directory. |
| Removing root/inference reports breaks traceability links | Medium | Many docs and source comments point at report paths. |
| Removing generated source/spec files breaks builds/runtime imports | High | Treat as keep unless regeneration plus CI is proven. |
| Cleaning while worktree is dirty overwrites another worker's context | High | Current modified files must be preserved and coordinated. |

## Owner Questions

- Benchmark owner: Should `packages/benchmarks/benchmark_results/latest/*.json`
  stay tracked as canonical latest results?
- Benchmark owner: Are the 571 ignored `rg_*` run directories still needed by
  active workers?
- LifeOps/docs owner: Should `docs/audits/lifeops-2026-05-11/prompts/` remain
  in git, be archived, or be excluded from search tooling?
- Docs owner: Is the tracked HTML audit report canonical, generated from
  another source, or disposable after markdown/source verification?
- Porting/inference owners: Which report directories are contractual evidence
  versus disposable generated output?
- Platform/package owners: Which tracked generated source/spec files are
  required for package consumers?
- Release owner: Which regeneration commands are mandatory gates before any
  generated file deletion?
- Cleanup coordinator: Should low-risk ignored cleanup run once centrally, or
  should each worker clean only its package area?

## Final Implementation Checklist

- [ ] Confirm no active worker needs ignored build/cache output.
- [ ] Capture a fresh `git status --short` and assign owners for every dirty
  tracked generated/report file.
- [ ] Run `git clean -ndX .` and save/review the would-remove list before any
  cleanup.
- [ ] For ignored low-risk candidates, get explicit approval to remove only
  ignored local artifacts.
- [ ] Do not remove tracked candidates in the ignored-artifact cleanup step.
- [ ] For `packages/benchmarks/benchmark_results/latest/`, get benchmark owner
  retention policy and regeneration command.
- [ ] For `docs/audits/lifeops-2026-05-11/prompts/`, get LifeOps/docs owner
  retention policy.
- [ ] For `reports/**` and `packages/inference/reports/**`, map all inbound
  references with `rg -n` and decide keep, archive, or summarize.
- [ ] For tracked generated source/specs, prove deterministic regeneration with
  owner-approved commands before proposing deletion.
- [ ] Run package-specific validation after any approved cleanup:
  `bun --cwd packages/prompts run build`,
  `bun run generate:action-search-keywords`,
  `bun --cwd packages/core run build`, and
  `bun --cwd plugins/app-lifeops run verify` where relevant.
- [ ] Re-run `rg --files`/`git ls-files` candidate counts and compare against
  this dry-run manifest.
- [ ] Open a cleanup PR with separate commits for ignored-local cleanup policy,
  tracked benchmark/report decisions, and generated-source policy changes.
- [ ] Include rollback notes for every tracked deletion.
