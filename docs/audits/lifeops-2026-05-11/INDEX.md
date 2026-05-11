# LifeOps benchmark + prompt-optimization pipeline rebuild — 2026-05-11

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
- [ ] W1-A unified telemetry across 3 harnesses
- [ ] W1-B JSON aggregator (extends aggregate-lifeops-run.mjs)
- [ ] W1-C MODEL_TIER switch + dflash wiring
- [ ] W1-D cache-key stability CI test

### Wave 2 — prompt + tool-search optimization
- [ ] W2-A review surface for optimized prompts
- [ ] W2-B native DSPy primitives (Signature, Predict, ChainOfThought)
- [ ] W2-C BootstrapFewShot, COPRO, MIPROv2 implementations
- [ ] W2-D tool-search retrieval speed wins

### Wave 3 — multi-tier e2e + eliza-1
- [ ] W3-A new CI workflow `.github/workflows/lifeops-bench-multi-tier.yml`
- [ ] W3-B eliza-1 honest labeling (`preRelease: true` until real bundle ships)

### Wave 4 — cleanup + code debt
- [ ] W4-A delete `searchYouTube`, delete `autofill`
- [ ] W4-B finish app-create / app-load-from-directory / perpetual-market / document / resolve-request / book-travel / mcp
- [ ] W4-C remove dead error-handling / fallback sludge in benchmark adapters
- [ ] W4-D consolidate duplicate metrics types across harnesses on the new schema

### Wave 5 — verify + close gaps
- [ ] W5-A full multi-tier run (small / mid / large / frontier)
- [ ] W5-B delta vs. baseline, optimizer improvement >= 20pp
- [ ] W5-C close remaining gaps; sign off
