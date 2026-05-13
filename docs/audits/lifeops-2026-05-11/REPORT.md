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

### Wave 6 — scoring correctness + personality judge + measured retrieval
- `W6-1` scorer canonicalization for 7 more umbrellas + OWNER_* aliases — `48ab9f1d7e`
- `W6-4` MESSAGE umbrella read-side + CALENDAR umbrella translation — `82e71d3e73`
- `W6-5` LIFE_* inline wire shape into tool descriptions — `0aa9727223`
- `W6-7` scorer re-weight read-only scenarios (state_hash no longer dominates) — `ccb3e5798c`
- `W6-G2` measured retrieval funnel + Pareto (n=479 counted samples; RRF Top-3 0.89, Top-5 0.98) — `3083b6a9f4`
  - Default topK updates: mid 8→6, large 12→8, frontier 20→12, small 5 unchanged
  - Added `scripts/lifeops-retrieval-replay.mjs` + `lifeops:retrieval:{replay,funnel,pareto}` scripts
- `W6-G3` personality aggressive-register diagnosis + fix — `98e7e6a3f3`
  - `hold_style.aggressive.code.004`: bridge was lossy-mapping `all_lowercase` → `terse`; new `checkAllLowercase` judge
  - `escalation.aggressive.code.004`: bridge was lossy-mapping `playful` → `warmer`; new `playfulScore` judge
  - Result: 5/6 PASS post-fix vs 0/6 pre-fix; personality bench from 40→45 tests
- `W6-G6` catch-all sweep — bug/test/lint fixes — `7f81b18bff`

### Wave 7 — final hardening, Qwen 27B weights, MIPRO retrain, scope isolation
- `W7-H1-redo` pull 27B + 27B-1M Qwen weights (hardlink sharing, single 16.5 GB inode) — `e529d7d5f8`
  - sha256 `f741bb17c9e5eae6629f211aed5675edad1120504654b27704fcdf5653e6417b`; both bundles verified; eliza-1 bundle tests 13/13
- `W7-H3` DSPy-MIPRO retrain on real trajectories (63-row dataset from `~/.eliza/trajectories`) — `21c2677645`
  - Overall pass@1: 0.286 → 0.429 (+14.3pp). Zero domain regressions.
  - Artifacts: `scripts/eliza-trajectory-to-dataset.mjs`, `plugins/app-training/datasets/eliza_action_planner_real.jsonl`
  - Detail: [`h3-mipro-real-trajectories.md`](./h3-mipro-real-trajectories.md)
- `W7-H4` openclaw turn-14 uppercase slip fix — `838297c785`
- `W7-H5` tiered-action-surface action-aware parent lookup — `d1fb10b227`
- `W7-H6` CerebrasJudge extraction, role-seeding tests, bench-server expansions — `53e97402c0`
  - Extract `CerebrasJudge` + `extractBalancedJsonObject` to `cerebras-judge.ts`
  - New test suites: `cerebras-judge.test.ts`, `role-seeding.test.ts`, `server-role-seeding.test.ts`, `scope-mode.test.ts`
  - Bench-server `/v1/roles` endpoints; scope-isolated rubric; bridge runner flags
- `W7-B` travel passengers schema + HEALTH discriminator alignment — `137fc88b73`
- `W7-E` audit-log endpoint + coolnessScore rubric + escalation probe backfill — `1b922b1c61`
- `W7-F` SCOPE_VARIANT_TO_MODE mapping + scope rubric modes — `9c791d5e94`
- MILADY→ELIZA rename back-compat finalized — `8a55c04e40`
  - `MILADY_CONFIG_PATH` / `milady.json` / `~/.milady` all honored with one-time migration + deprecation warning
- `fix(bench)` scope-isolated legacy mode back-compat + lifeops conftest sys.path — `a8849560d7`
  - Final fix: 88/88 personality-bench TS, 1499+ lifeops Python tests all green

## Architecture in one screen

```
┌─────────────────────────────────────────────────────────────────────┐
│  Harnesses (hermes / openclaw / eliza)                              │
│     │   uses                                                        │
│     ▼                                                               │
│  Telemetry  → trajectories  → ~/.eliza/trajectories/*.jsonl        │
│     │                                                               │
│     ▼                                                               │
│  scripts/aggregate-lifeops-run.mjs                                  │
│     │ emits                                                         │
│     ▼                                                               │
│   report.{json,md,csv}    ──► scripts/lifeops-bench-delta.mjs       │
│                                                                     │
│  ModelTier (small | mid | large | frontier)                         │
│    ├─ live-provider  → Cerebras gpt-oss-120b, Anthropic Opus 4.7    │
│    └─ dflash         → local Qwen 0.6B / 1.7B / 9B / 27B / 27B-1M  │
│                         via llama.cpp (eliza-1-* bundle manifests)   │
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
- **MILADY→ELIZA rename done** (`8a55c04e40`) — all env vars, config
  paths, and state dirs migrated with back-compat aliases. `~/.milady`
  is migrated to `~/.eliza` on first boot when `~/.eliza` is absent.
  `MILADY_*` vars still honored with a one-time deprecation warning.
- **27B / 27B-1M Qwen weights on disk** (`e529d7d5f8`) — hardlink
  sharing keeps total footprint at ~16.5 GB for both bundles. Both
  stay `preRelease=true` / `publishEligible=false` per eliza-1 gates.
- **MIPRO retrain on real trajectories** (`21c2677645`) — +14.3pp
  overall pass@1 (0.286→0.429). Artifact promoted to
  `~/.eliza/optimized-prompts/action_planner/current`.
- **Measured retrieval funnel** (`3083b6a9f4`) — RRF Top-3: 0.89,
  Top-5: 0.98, n=479. Default topK tightened from heuristics to
  measured Pareto (mid 8→6, large 12→8, frontier 20→12).

## Test grid

| Suite                                  | Count | Result | Notes |
|----------------------------------------|------:|:-------|:------|
| Cache stability                        |    10 | pass   | 10/10 unchanged hashes |
| Benchmarks lib (TS)                    |    44 | pass   |  |
| DSPy primitives (TS)                   |     9 | pass   |  |
| Action-retrieval measurement (TS)      |     7 | pass   |  |
| Retrieval defaults (TS)                |    10 | pass   |  |
| Retrieval funnel script (TS)           |     3 | pass   |  |
| Aggregator round-trip (TS + Python)    |     8 | pass   |  |
| Eliza-1 bundle gating (TS + Python)    |    13 | pass   | 27b + 27b-1m added (wave-7-h1-redo) |
| Metrics schema round-trip              |     4 | pass   |  |
| Aggregator pre-release banner          |     2 | pass   |  |
| Serialization-audit memo regression    |     8 | pass   |  |
| Aggregator + delta smoke               |     1 | pass   | `bun scripts/__tests__/aggregate-lifeops-run.test.mjs` |
| Multi-tier bench dry-run gate          |     1 | pass   | `bun scripts/__tests__/lifeops-multi-tier-bench.test.mjs` |
| hermes-adapter (Python)                |    69 | pass   | F4 fix — `attach_usage_cache_fields` stub exposure |
| openclaw-adapter (Python)              |    61 | pass   | 6 dead HTTP retry-loop tests trimmed alongside dead helper deletion |
| eliza-adapter (Python)                 |     9 | pass   | New `conftest.py` puts `packages/` on `sys.path` |
| lifeops-bench (Python)                 |  1499+ | pass  | All prior failures resolved; conftest sys.path fix (`a8849560d7`) cleared last failure |
| personality-bench (TS)                 |    88 | pass   | Was 0/6 before wave-6-g3 judge/bridge fixes; 88/88 after wave-7-h6 + scope-isolated back-compat (`a8849560d7`) |
| CerebrasJudge unit tests (TS)          |     8 | pass   | New suite from wave-7-h6 — JSON extractor + retry logic (`53e97402c0`) |
| Bench-server role-seeding (TS)         |    12 | pass   | role-seeding.test.ts + server-role-seeding.test.ts added in wave-7-h6 |
| Scope-mode (TS)                        |     5 | pass   | scope-mode.test.ts added in wave-7-h6 |
| plugin-app-training (TS, full)         |    65 | pass   | All 4 prior failures resolved (prompt-compare env fix, training-api defer, plugin-imessage/x402 `dist` rebuild) |
| packages/core (TS, full)               |   122 | pass   | All previously-documented pre-existing failures resolved |

Per-wave run-logs and failure detail in the individual wave docs
linked above. The full re-baseline run (W2-9) corpus is preserved at
`~/.eliza/runs/lifeops/lifeops-multiagent-best`. Wave 6-G6 sweep
details in [`known-typecheck-failures.md`](./known-typecheck-failures.md).

## Verification commands run + outcomes

```bash
bun run verify                          # typecheck + lint
bun run test                            # parallel TS test suite
bun run test:cache-stability            # 10/10 unchanged hashes
bun run lifeops:verify-cerebras         # both eval + train reachable
ELIZA_BENCH_LIMIT=25 ELIZA_BENCH_SKIP_JS=1 \
  LIFEOPS_USE_MOCKOON=1 \
  OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
  ELIZA_PROVIDER=cerebras \
  BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gpt-oss-120b \
  bun run lifeops:full                  # full run, status=0
```

Known residual typecheck failures are documented (with scope) in
[`known-typecheck-failures.md`](./known-typecheck-failures.md). Per
Wave 4-B disposition, none are blockers for the rebuild — the
remaining items either need targeted regex-fusion work in
`action-retrieval.ts` (> 50 LoC) or are stale Wave-0 reports that no
longer reproduce on current `develop`.

## Final state (2026-05-12 wrap-up)

All tests green across the full suite:

- **88/88 personality-bench TS tests** — was 0/6 before wave-6-g3 judge/bridge fixes.
- **122/122 core TS tests** (bench lib, cerebras-judge, action-retrieval, role-seeding,
  scope-mode, etc.) — all previously-documented pre-existing failures resolved.
- **1499+ Python lifeops-bench tests** — last remaining failure (hermes agent
  `sys.path` import in `conftest.py`) resolved in `a8849560d7`.
- **MILADY→ELIZA rename complete** — back-compat aliases active, migration runs on
  first boot, no user action required.
- **27B / 27B-1M Qwen weights verified** — on disk at
  `~/.eliza/local-inference/models/`, hardlinked (single 16.5 GB inode).
- **MIPRO retrain +14.3pp** — real-trajectory dataset, zero domain regressions,
  artifact promoted to `current`.
- **Retrieval funnel tightened** — RRF Top-3 0.89 / Top-5 0.98 (was 0 counted
  samples before wave-6-g2); topK defaults updated to measured Pareto values.

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

[`wave-5a-gap-list.md`](./wave-5a-gap-list.md) is the post-rebuild gap
inventory (committed 2026-05-11 after the rate-limit-delayed W5-A run
resumed). Headline: P0=0, P1=3 real fixes + 4 no-op confirmations,
P2=5 document-only, P3=6 follow-up tracked. The four items W5-B was
pre-assigned (`browser.ts`, `plugin-music` test, `test_hermes_agent`,
`action-retrieval` regex namespace) all confirmed green on `develop`
under `6ef80720a9`.

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
   `ELIZA_RETRIEVAL_MEASUREMENT=1` trajectories. First measured run
   should rerun `bun run lifeops:retrieval:funnel` +
   `lifeops:retrieval:pareto` and either update
   `retrieval-defaults.ts` constants or document the deltas.
3. Whether to land the Wave-3 P0 scorer name-aliasing layer before
   the next published benchmark — without it, the granular
   elizaOS-style agent path is structurally penalized vs. the
   umbrella-form Hermes path.
4. Whether to flip `ELIZA_BENCH_PRE_RELEASE` rules for the local
   Qwen tiers once a real (non-standin) training run lands. The
   current rule is correct (every bundle is `preRelease=true`) but
   conservative; once weights land, the aggregator should emit
   `preRelease=false` automatically without doc-edits.
