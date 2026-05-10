# Baseline metrics — 2026-05-09

Pre-Wave-1 / Wave-2 "before" snapshot for the on-device inference cleanup.
Wave-2 verification diffs against this directory.

Run by the baseline-metrics agent. Read-only on source code; only writes
were under this directory.

## Files

| File | Purpose | Notes |
|---|---|---|
| `INDEX.md` | this file | |
| `knip.txt` | full `bunx knip` (NODE_OPTIONS=--max-old-space-size=8192) output | 10,931 lines. First attempt OOMed at 4 GB; rerun with 8 GB succeeded. |
| `knip-scoped.txt` | `knip.txt` filtered to W1-H scopes (plugin-local-inference, plugin-local-ai, plugin-local-embedding, native-plugins, services/local-inference) | 184 lines. Use this for the W1-H delete/consolidate diff. |
| `madge-circular.txt` | `madge --circular packages/ plugins/` (all extensions) | 14,831 files, 42 cycles. Most cycles are noise from `dist/` artifacts and `packages/app-core/platforms/electrobun/build/` chunks. |
| `madge-circular-src.txt` | `madge --circular --extensions ts,tsx --exclude '(dist\|platforms/electrobun/build\|node_modules)'` | The clean source-only view: **4 cycles**. These are the real ones to fix. |
| `madge-graph.json` | full module graph (JSON form, src-only) | ~1 MB. Used in lieu of the SVG/dot output (graphviz/`gvpr` is not installed on this host). |
| `aosp-symbols-pre.txt` | `nm -D --defined-only` for libllama / libggml-* / libllama-common across `~/.eliza/local-inference/bin/dflash/{android-arm64-cpu,android-arm64-vulkan,linux-x64-cpu,linux-x64-vulkan}/` | 44,134 lines. Header lists the W1-A / W1-B grep keys. **Zero QJL, PolarQuant, TBQ3/TBQ4, or eliza-llama-shim symbols are present today.** Wave-1 must change that. |
| `catalog-coverage.md` | per-entry table of `{contextLength, tokenizerFamily, runtime.kvCache, runtime.dflash}` for `MODEL_CATALOG` | 27 entries total. Coverage: 23/27 contextLength, 27/27 tokenizerFamily, 6/27 runtime block, 2/27 kvCache, 4/27 dflash. Lists the 4 hidden DFlash drafters that still need `contextLength`. |
| `profile.json` / `profile.md` | `node scripts/benchmark/profile-inference.mjs --label baseline-stub-2026-05-09 --out reports/porting/2026-05-09-baseline/` against the in-process `stub-agent-server.mjs` | 48 runs (4 models × 3 KV configs × 2 DFlash modes × 4 prompts), all OK. Numbers are stub latency only — not representative of real inference. They prove the harness works end-to-end and give a numerical floor (load ~120 ms, total ~170-200 ms median, "tok/s" is a deterministic stub function of prompt length). |
| `larp-inventory.md` | W2 acceptance checklist | 34 items extracted from 8 Wave-0 audit subagent reports. 12 HIGH, 12 MED, 10 LOW. Each item has a "W2 acceptance" line. |
| `test-pass-counts.txt` | `bunx vitest run` counts for app-core, agent, plugin-aosp-local-inference | app-core 145/154 + 1 fail + 8 skip; agent 61/61 pass; aosp plugin has no tests. The single app-core failure (`active-model.test.ts`) is a pre-existing test/code drift documented in the file. |

## Process notes

- knip OOMed on the default Node heap. Re-ran with `NODE_OPTIONS="--max-old-space-size=8192"`. Future runs should keep that override or add a project-level `knip.json` to scope the analysis.
- `gvpr` (graphviz) is not on this host, so madge's `--image` and `--dot` outputs are unavailable. `madge-graph.json` is the substitute.
- `~/.eliza/local-inference/bin/dflash/` already contains a previously-built llama.cpp set (Apothic-AI fork commit). The symbol dump confirms that build does NOT carry TurboQuant / QJL / PolarQuant / shim exports yet — i.e. the `audit-android-aosp.md` claim that "TBQ3_0 / TBQ4_0 are verified in shipped libs" does NOT match this dev box's local artifacts. This is itself a finding (recorded as larp E3) and should be reconciled before Wave-1 closes.
- The bench harness was exercised against `stub-agent-server.mjs` only. Running against `bun run dev` is left to a follow-up baseline pass; per the task spec it would have been "too many moving parts for a baseline".

## Source audit reports

The audit subagent transcripts that fed `larp-inventory.md` are extracted to
`/tmp/audit-extracts/audit-*.md` (8 files, ~100 KB total). Originals live under
`/tmp/claude-1000/-home-shaw-milady-eliza/4b3bac68-b53d-4cf6-9d19-164ea09586c1/tasks/<id>.output`
as JSONL transcripts; the extracts contain just the final assistant text per
audit task.

## Quick stats

- Source-only circular dependencies: **4**
- knip-flagged scoped issues: **184 lines** across 5 directories
- Catalog entries with full metadata coverage: **23 / 27**
- AOSP native libs with QJL exports: **0 / 4** built backends
- AOSP native libs with PolarQuant Q4_POLAR exports: **0 / 4**
- AOSP native libs with TBQ3_0 / TBQ4_0 exports: **0 / 4** (contradicts docs — see larp E3)
- Tests passing (app-core + agent): **206**
- Tests failing: **1** (active-model contextSize drift)
- Larps catalogued for W2 verification: **34**
