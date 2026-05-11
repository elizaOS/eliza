# LifeOps benchmark + prompt-optimization pipeline rebuild — 2026-05-11

> Single canonical entry-point for the rebuild. Cross-links every wave's
> commits, artifacts, and follow-ups. Companion to
> [`INDEX.md`](./INDEX.md), which lists per-wave deliverables.

## Mission

Unified metrics across hermes / openclaw / eliza harnesses, native
DSPy-style optimizer rebuilt in our packages (no `ax` import), multi-tier
model end-to-end (Cerebras + Anthropic + local Qwen 0.6B / 1.7B / 9B via
the dflash llama.cpp fork), CI gates that fire on cache-key churn and
prompt-cache-bust, JSON + Markdown + CSV artifact pipeline only (no HTML
output from the pipeline).

## Quick-start

```bash
# CI gate — cache-key churn detector (~2s)
bun run test:cache-stability

# Multi-tier benchmark suite (Cerebras + Anthropic)
bun run lifeops:multi-tier:smoke    # 5 scenarios
bun run lifeops:multi-tier:core     # 30 scenarios

# Prompt review surface
bun run lifeops:prompts:inventory
bun run lifeops:prompts:review
bun run lifeops:prompts:collisions

# Native DSPy-style optimizer (MIPRO / GEPA / bootstrap-fewshot)
bun run train --optimizer dspy-mipro --task action_planner --dataset <jsonl>
```

## Wave-by-wave delivered

Full per-wave detail in [`INDEX.md`](./INDEX.md). Headline commits:

### Wave 0 — prep
- `W0-A/B/C` — canonical metrics schema (TS Zod + Python dataclasses),
  report.json + delta.json schemas, round-trip smoke test, wave index.
- Schemas: [`packages/benchmarks/lib/src/metrics-schema.ts`](../../../packages/benchmarks/lib/src/metrics-schema.ts),
  [`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/metrics_schema.py`](../../../packages/benchmarks/lifeops-bench/eliza_lifeops_bench/metrics_schema.py).

### Wave 1 — foundation
- `W1-A` unified telemetry across 3 harnesses — `2cb3883c27`
- `W1-B` JSON aggregator + delta — `24e312952e`
- `W1-C` MODEL_TIER + dflash wiring — `f63347d0ce`, `6030ee0f27`
- `W1-D` cache-key stability CI gate — `f277b9519c`
  ([`cache-key-stability.md`](./cache-key-stability.md))
- Auxiliary fixes: `W1-9` `11822f4b52`, `W1-10` `a3567c5960`,
  `W1-11` `61b74af1f0`, `W1-5` `451054f9fa`.

### Wave 2 — prompt + tool-search optimization
- `W2-A` prompt + action review surface (markdown) — `7af94629a4`
  - [`prompts-manifest.json`](./prompts-manifest.json),
    [`prompts/INDEX.md`](./prompts/INDEX.md) (988 per-prompt pages),
    [`action-collisions.md`](./action-collisions.md) /
    [`action-collisions.json`](./action-collisions.json).
- `W2-B` native DSPy primitives + finisher — `e1c6a0d4bb`, `d2d93ea47a`
  - Source: `plugins/app-training/src/dspy/` — signature, predict,
    chain-of-thought, optimizers, lm-adapter, artifact. No `ax` import.
- `W2-C` retrieval funnel + Pareto + tier defaults — `e64bb8a6c4`
  ([`retrieval-funnel.md`](./retrieval-funnel.md),
  [`retrieval-pareto.md`](./retrieval-pareto.md)).
- `W2-D` structural speed wins (memos + breakpoint alignment + enum
  short-form + Cerebras compress) — `f593e17e8c`
  ([`serialization-audit.md`](./serialization-audit.md)).
- `W2-9` rebaseline closing-the-loop — `66db1854d2`
  ([`rebaseline-report.md`](./rebaseline-report.md)).

### Wave 3 — multi-tier e2e + eliza-1
- `W3-A` new CI workflow `lifeops-bench-multi-tier.yml` — `4bacadcf19`
- `W3-B` eliza-1 honest pre-release labeling + plugin-health fix —
  `87390a23f6` ([`eliza-1-status.md`](./eliza-1-status.md)).
- Personality bench scaffolding: `W3-2` `9bcff649b5`,
  `W3-3` `44af7fffc4`, `W3-3b` `9ef1f7991c`, `W3-4` `be69ff07a7`.

### Wave 4 — cleanup + code debt
- `W4-A` deduplication + types consolidation — `bc38aef7ae`
- `W4-B` unused / legacy / fallback removal — `3d6988c15b`
  ([`known-typecheck-failures.md`](./known-typecheck-failures.md))
- `W4-C` strong typing + error-handling simplification — `4cab97e161`
- `W4-D` slop + comment cleanup — `d5509afa3e`

### Wave 5 — verify + close gaps
- `W5-A` full multi-tier run + delta vs baseline (concurrent — see
  [`INDEX.md`](./INDEX.md) for sign-off).
- `W5-B` optimizer improvement ≥ 20pp gate (concurrent).
- `W5-C` this report.

## Architecture in one screen

```
┌─────────────────────────────────────────────────────────────────────┐
│  Harnesses (hermes / openclaw / eliza)                              │
│     │   uses                                                        │
│     ▼                                                               │
│  Telemetry  → trajectories  → ~/.milady/trajectories/*.jsonl        │
│     │                                                               │
│     ▼                                                               │
│  scripts/aggregate-lifeops-run.mjs                                  │
│     │ emits                                                         │
│     ▼                                                               │
│   report.{json,md,csv}    ──► scripts/lifeops-bench-delta.mjs       │
│                                                                     │
│  ModelTier (small | mid | large | frontier)                         │
│    ├─ live-provider  → Cerebras gpt-oss-120b, Anthropic Opus 4.7    │
│    └─ dflash         → local Qwen 0.6B / 1.7B / 9B via llama.cpp    │
│                                                                     │
│  OptimizedPromptService ◄── native DSPy optimizer                   │
│    (plugins/app-training/src/dspy/)                                 │
│    Optimizers: BootstrapFewShot, COPRO, MIPROv2                     │
│                                                                     │
│  CI gates                                                           │
│    ├─ cache-key-stability.yml (Wave 1-D snapshot test)              │
│    └─ lifeops-bench-multi-tier.yml (Wave 3-A multi-tier suite)      │
└─────────────────────────────────────────────────────────────────────┘
```

## Cross-cutting decisions

- **Cerebras prompt caching IS supported on `gpt-oss-120b`** — default
  on, 128-token blocks, 5-minute eviction. All harnesses treat
  Cerebras like Anthropic for cache accounting.
- **Native DSPy primitives in `plugins/app-training/src/dspy/`** —
  Signature, Predict, ChainOfThought, BootstrapFewShot, COPRO,
  MIPROv2. No external `ax` library import.
- **JSON + Markdown + CSV only** — no HTML in the pipeline.
- **CI:** dedicated `.github/workflows/lifeops-bench-multi-tier.yml`,
  skip-not-fail on missing API keys.
- **Stay on `develop`, commits-only, no stashes** (per
  [`AGENTS.md`](../../../AGENTS.md) git-workflow rules).
- **Honest eliza-1 labeling** — every bundle below
  `eliza-1-final-weights` stays `preRelease=true`; aggregator stamps a
  banner on `report.md` and `preRelease:true` on every `RunMetrics`.
- **Stub action verdicts** (Wave 4 audit): DELETE `searchYouTube`
  (duplicate of `playMusicQuery`), DELETE `autofill` (deprecated by
  `CREDENTIALS` umbrella). FINISH list (real production code, not
  stubs): `app-create`, `app-load-from-directory`, `perpetual-market`,
  `document`, `resolve-request`, `book-travel`, `mcp`.

## Test grid

| Suite                                  | Count | Result |
|----------------------------------------|------:|:-------|
| Cache stability                        |    10 | pass   |
| Benchmarks lib (TS)                    |    44 | pass   |
| DSPy primitives (TS)                   |    11 | pass   |
| Action-retrieval measurement (TS)      |     7 | pass   |
| Retrieval defaults (TS)                |    10 | pass   |
| Retrieval funnel script (TS)           |     3 | pass   |
| Aggregator round-trip (TS + Python)    |     8 | pass   |
| Eliza-1 bundle gating (TS + Python)    |     6 | pass   |
| Metrics schema round-trip              |     4 | pass   |
| Aggregator pre-release banner          |     2 | pass   |
| Serialization-audit memo regression    |     8 | pass   |

Per-wave run-logs and failure detail in the individual wave docs
linked above. The full re-baseline run (W2-9) corpus is preserved at
`~/.milady/runs/lifeops/lifeops-multiagent-best`.

## Verification commands run + outcomes

```bash
bun run verify                          # typecheck + lint
bun run test                            # parallel TS test suite
bun run test:cache-stability            # 10/10 unchanged hashes
bun run lifeops:verify-cerebras         # both eval + train reachable
MILADY_BENCH_LIMIT=25 MILADY_BENCH_SKIP_JS=1 \
  LIFEOPS_USE_MOCKOON=1 \
  OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
  MILADY_PROVIDER=cerebras \
  BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gpt-oss-120b \
  bun run lifeops:full                  # full run, status=0
```

Known residual typecheck failures are documented (with scope) in
[`known-typecheck-failures.md`](./known-typecheck-failures.md). Per
Wave 4-B disposition, none are blockers for the rebuild — the
remaining items either need targeted regex-fusion work in
`action-retrieval.ts` (> 50 LoC) or are stale Wave-0 reports that no
longer reproduce on current `develop`.

## Known issues + follow-ups

From [`rebaseline-report.md`](./rebaseline-report.md) Wave-3 follow-ups:

- **[P0] Scorer name-aliasing layer** — map `CALENDAR_*` granular
  action names to `CALENDAR(subaction=*)` before `compare_actions`.
  Without this, granular-action agents get false zeros on every
  read-only scenario.
- **[P0] Mark `intent` as soft in `_kwargs_match`** — currently caps
  every partial pass at 0.80.
- **[P0] Fix eliza bench-server LLM endpoint** — OpenAI plugin path
  hits a Cerebras endpoint returning 404. Pin to
  `/v1/chat/completions` or add `@elizaos/plugin-cerebras` to the
  bench server's plugin chain.
- **[P1] Concurrency / backoff for Cerebras** — lower default
  `--concurrency 4 → 2` or add exponential-backoff retry in the
  in-process hermes adapter.
- **[P1] `BLOCK` simile** — every agent confuses "focus block" with a
  `BLOCK` action; either add a `BLOCK → CALENDAR.create_event` simile
  or rewrite the smoke scenario.
- **[P1] Search-then-act in system prompts** — every
  cancel/reschedule/delete scenario fails because agents skip the
  search step.
- **[P2] Run other domains** — calendar slice is 25/25; the suite
  has 100+ scenarios across mail, reminders, contacts, finance,
  travel, health.
- **[P2] Plumb hermes per-turn `cost_usd` and `latency_ms`** into
  `MessageTurn` for granular debugging.

`docs/audits/lifeops-2026-05-11/wave-5a-gap-list.md` lands separately
as W5-A completes — it will be linked from [`INDEX.md`](./INDEX.md)
under "Wave 5 follow-ups" once the multi-tier validation run finishes.

Wave 4-B residuals (full text in
[`known-typecheck-failures.md`](./known-typecheck-failures.md)):

- `packages/core/src/runtime/__tests__/action-retrieval.test.ts`
  "regex scoring" test — wildcard-namespace path in
  `action-retrieval.ts` returns zero results for `<name>_*` patterns
  (> 50 LoC fix, Wave 5 to decide repair vs. relax).
- `packages/app-core/src/browser.ts` ambiguous `ConfigField` /
  `getPlugins` re-export — does not reproduce on current `develop`.
- `plugin-imessage` "not built" — does not reproduce; `dist/` is
  present.

## Open decisions for the operator

1. When to re-bench Anthropic with the new DSPy-optimized planner
   (current re-baseline is Cerebras-only because the env's
   `ANTHROPIC_API_KEY` was unset).
2. When to bump per-tier retrieval defaults from the heuristic
   bake-in (small=5, mid=8, large=12, frontier=20) to measured Pareto
   values. Today's `retrieval-funnel.{md,json}` is structurally
   correct but `counted samples: 0` because no full run yet emits
   `MILADY_RETRIEVAL_MEASUREMENT=1` trajectories. First measured run
   should rerun `bun run lifeops:retrieval:funnel` +
   `lifeops:retrieval:pareto` and either update
   `retrieval-defaults.ts` constants or document the deltas.
3. Whether to land the Wave-3 P0 scorer name-aliasing layer before
   the next published benchmark — without it, the granular
   elizaOS-style agent path is structurally penalized vs. the
   umbrella-form Hermes path.
4. Whether to flip `MILADY_BENCH_PRE_RELEASE` rules for the local
   Qwen tiers once a real (non-standin) training run lands. The
   current rule is correct (every bundle is `preRelease=true`) but
   conservative; once weights land, the aggregator should emit
   `preRelease=false` automatically without doc-edits.
