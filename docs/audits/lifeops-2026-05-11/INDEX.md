# LifeOps benchmark + prompt-optimization pipeline rebuild — 2026-05-11

> **Canonical entry-point: [`REPORT.md`](./REPORT.md)** — start there for the
> single-page rebuild overview (mission, quick-start, architecture, test
> grid, follow-ups). This INDEX is the wave-by-wave deliverable list.

## Mission
Unified metrics, prompt optimization, multi-tier model e2e, native DSPy-style optimizer. Built on top of the 2026-05-09 audit foundation.

## Wave map
- Wave 0 — prep (this doc, schemas)
- Wave 1 — foundation (telemetry, aggregator, tier switch, cache CI gate)
- Wave 2 — prompt + tool-search optimization (review surface, native DSPy primitives, retrieval, speed wins)
- Wave 3 — multi-tier e2e + eliza-1 (CI workflow, eliza-1 honest labeling)
- Wave 4 — cleanup + code debt
- Wave 5 — verify + close gaps

## Cross-cutting decisions
- **Cerebras prompt caching IS supported on gpt-oss-120b** (default-on, 128-token blocks). All harnesses treat Cerebras like Anthropic for cache accounting.
- **Native DSPy rebuild, no ax library import** — Signature, Predict, ChainOfThought, BootstrapFewShot, COPRO, MIPROv2 implemented in our own TS source under `plugins/app-training/src/dspy/`.
- **No HTML artifacts in the pipeline** — JSON + Markdown + CSV only.
- **CI** — new workflow `.github/workflows/lifeops-bench-multi-tier.yml`, separate from existing `lifeops-bench.yml`.
- **Stub action verdicts**: DELETE `searchYouTube` (duplicate of playMusicQuery), DELETE `autofill` (deprecated by CREDENTIALS umbrella). FINISH list: `app-create`, `app-load-from-directory`, `perpetual-market`, `document`, `resolve-request`, `book-travel`, `mcp` — all are working production code, not real stubs.

## Schemas
- `packages/benchmarks/lib/src/metrics-schema.ts` (TS, Zod) — `@elizaos-benchmarks/lib`
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/metrics_schema.py` (Python mirror)
- Round-trip smoke test: `packages/benchmarks/lifeops-bench/tests/test_metrics_schema.py`

## Wave-by-wave deliverable index
(populated by each wave)

### Wave 0 — prep
- [x] W0-A canonical metrics schema (TS Zod + Python dataclasses)
- [x] W0-B report.json + delta.json schemas, round-trip smoke test
- [x] W0-C this index

### Wave 1 — foundation
- [x] W1-A unified telemetry across 3 harnesses (commit `2cb3883c27`)
  - `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/metrics_schema.py`
  - `packages/benchmarks/lib/src/metrics-schema.ts`
- [x] W1-B JSON aggregator + delta (commit `24e312952e`)
  - `scripts/aggregate-lifeops-run.mjs`, `scripts/lifeops-bench-delta.mjs`
  - `scripts/__tests__/aggregate-lifeops-run.test.mjs`
- [x] W1-C MODEL_TIER + dflash wiring (commits `f63347d0ce`, `6030ee0f27`)
  - `packages/benchmarks/lib/src/model-tiers.ts`, `local-llama-cpp.ts`
- [x] W1-D cache-key stability gate (commit `f277b9519c`)
  - `docs/audits/lifeops-2026-05-11/cache-key-stability.md`

### Wave 2 — prompt + tool-search optimization
- [x] W2-A prompt review surface (commit `7af94629a4`)
  - `scripts/lifeops-prompt-inventory.mjs`, `lifeops-prompt-review.mjs`, `lifeops-action-collisions.mjs`
  - `docs/audits/lifeops-2026-05-11/action-collisions.{md,json}`, `prompts-manifest.json`, `prompts/`
- [x] W2-B native DSPy primitives + finisher (commits `e1c6a0d4bb`, `d2d93ea47a`)
  - `plugins/app-training/src/dspy/` (signature, predict, chain-of-thought, optimizers, lm-adapter, artifact)
  - `plugins/app-training/src/backends/native.ts`, `plugins/app-training/src/cli/train.ts`
- [x] W2-C retrieval funnel instrumentation + Pareto sweep + per-tier defaults (commit `e64bb8a6c4`)
  - `packages/core/src/runtime/action-retrieval.ts` — added `measurementMode`, `tierOverrides`, `RetrievalMeasurement` (per-stage scores + fused top-K). Weighted RRF + env-driven MODEL_TIER override.
  - `packages/core/src/runtime/trajectory-recorder.ts` — extended `RecordedToolSearchStage` with `perStageScores`, `fusedTopK`, `selectedActions`, `correctActions`.
  - `packages/core/src/services/message.ts` — plumbed `ELIZA_RETRIEVAL_MEASUREMENT=1` through `buildV5PlannerActionSurface`.
  - `packages/benchmarks/lib/src/retrieval-defaults.ts` — `RETRIEVAL_DEFAULTS_BY_TIER` (small/mid/large/frontier topK + stage weights). Re-exported from `@elizaos-benchmarks/lib`.
  - `scripts/lifeops-retrieval-funnel.mjs` — emits `retrieval-funnel.{md,json}` from `~/.eliza/trajectories`.
  - `scripts/lifeops-retrieval-pareto.mjs` — top-K sweep (3/5/8/12/20) + per-tier recommended K against floors 0.70 / 0.78 / 0.85 / 0.90.
  - Tests: `action-retrieval-measurement.test.ts` (7), `retrieval-defaults.test.ts` (10), `lifeops-retrieval-funnel.test.mjs` (synthetic in → md+json out).
  - Defaults baked in (heuristic; recalibrate on first real measured run): small topK=5, mid=8, large=12, frontier=20. Small up-weights exact/regex/bm25 (precision-heavy), frontier up-weights keyword/embedding (recall-friendly).
- [x] W2-D structural speed wins (commit `f593e17e8c`)
  - `packages/core/src/runtime/planner-loop.ts` — module-level memos for available-actions / per-tool / routing-hints render.
  - `packages/core/src/runtime/action-retrieval.ts` — compress-mode top-K cap.
  - `docs/audits/lifeops-2026-05-11/serialization-audit.md`

### Wave 3 — multi-tier e2e + eliza-1
- [x] W3-A new CI workflow (commit `4bacadcf19`)
  - `.github/workflows/lifeops-bench-multi-tier.yml`
- [x] W3-B eliza-1 honest pre-release labeling + plugin-health fix (commit `87390a23f6`)
  - `packages/benchmarks/lib/src/eliza-1-bundle.ts`, `packages/benchmarks/lib/src/__tests__/eliza-1-bundle.test.ts`
  - `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/eliza_1_bundle.py`, `tests/test_eliza_1_bundle.py`
  - `scripts/aggregate-lifeops-run.mjs` — `--pre-release` flag + banner block
  - `scripts/__tests__/aggregate-lifeops-run.pre-release.test.mjs`
  - `docs/audits/lifeops-2026-05-11/eliza-1-status.md`

### Wave 4 — cleanup + code debt
- [x] W4-A deduplication + types consolidation (commit `bc38aef7ae`)
- [x] W4-B unused / legacy / fallback removal (commit `3d6988c15b`)
  - `docs/audits/lifeops-2026-05-11/known-typecheck-failures.md`
- [x] W4-C strong typing + error-handling simplification (commit `4cab97e161`)
- [x] W4-D slop + comment cleanup (commit `d5509afa3e`)

### Wave 5 — verify + close gaps
- [~] W5-A full multi-tier run (small / mid / large / frontier) — concurrent
  - [`wave-5a-gap-list.md`](./wave-5a-gap-list.md) — post-rebuild gap inventory
- [~] W5-B delta vs. baseline, optimizer improvement >= 20pp — concurrent
- [x] W5-C final REPORT.md + INDEX.md close-out
  - `docs/audits/lifeops-2026-05-11/REPORT.md` (this commit)

## Follow-ups

- **W5-A gap list** — [`wave-5a-gap-list.md`](./wave-5a-gap-list.md)
  (committed 2026-05-11; P0=0, P1=3 real fixes + 4 no-ops, P2=5, P3=6).
- **Wave-3 P0/P1 follow-ups** — full list in
  [`REPORT.md`](./REPORT.md) "Known issues + follow-ups" and
  [`rebaseline-report.md`](./rebaseline-report.md). Headline items:
  scorer name-aliasing layer for `CALENDAR_*` granular actions, soft
  `intent` kwarg in `_kwargs_match`, eliza bench-server LLM endpoint
  fix (Cerebras 404).
- **Retrieval defaults recalibration** — first run with
  `ELIZA_RETRIEVAL_MEASUREMENT=1` should rerun
  `bun run lifeops:retrieval:funnel` and
  `bun run lifeops:retrieval:pareto`, then either update
  `packages/benchmarks/lib/src/retrieval-defaults.ts` constants or
  document the measured deltas.
- **Wave 4-B residual typecheck failures** — see
  [`known-typecheck-failures.md`](./known-typecheck-failures.md);
  `action-retrieval.ts` wildcard-namespace path needs > 50 LoC repair
  (deferred from Wave 4-B scope).
