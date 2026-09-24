# lib — Agent Guide

Shared infrastructure imported by every harness and the orchestrator in the
LifeOpsBench suite — not a runnable benchmark and not registered in the suite
registry. Two parallel layers live here because the harnesses are polyglot:
TypeScript under `src/` (imported as `@elizaos-benchmarks/lib`) and Python at
the top level (imported as `benchmarks.lib` with the repo root registered as the `benchmarks` package).

## Run

There is nothing to run directly. Consumers import this package:

```ts
import { parseReport, resolveTier } from "@elizaos-benchmarks/lib";
```

```python
from lib import BaseBenchmarkClient, ResultsStore
from lib.pricing import compute_cost_usd
```

## Test

```bash
# TypeScript layer (vitest: metrics schema, model tiers, bundle reader,
# local-llama-cpp adapter, retrieval defaults)
cd lib
bun run test

# Typecheck + lint + format check
bun run check

# Python layer (pytest, from the suite root so `lib` resolves)
cd ..  # benchmarks repo root
pytest lib/ -v
```

No API keys, models, or network access required — every test here is
deterministic and CI-safe.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Public TS entry; re-exports everything under `src/` |
| `src/metrics-schema.ts` | Zod schemas for `report.json` / `delta.json` artifacts |
| `src/model-tiers.ts` | `DEFAULT_TIERS` registry + `resolveTier()` (`MODEL_TIER` + override env vars) |
| `src/local-llama-cpp.ts` | Spawn/probe adapter for the mtp llama-cpp fork |
| `src/eliza-1-bundle.ts` | eliza-1 GGUF bundle-directory reader |
| `src/retrieval-defaults.ts` | Per-tier `topK` / stage-weight retrieval profiles |
| `src/__tests__/` | vitest suite for the TS layer |
| `base_benchmark_client.py` | Abstract benchmark client (retry, auth, cost, telemetry) |
| `results_store.py` | SQLite trending store for the promotion gate/dashboard |
| `pricing.py` | Per-million-token pricing tables (Cerebras, Anthropic) |
| `trajectory_normalizer.py` | Native trajectory formats → canonical `eliza_native_v1` JSONL |
| `agent_install.py` | Installs/verifies OpenClaw + Hermes agents under `$ELIZA_AGENTS_ROOT` |
| `random_baseline.py` | Seedable random-choice floor agent (`agent_id=random_v1`) |
| `test_*.py` | pytest suite for the Python layer |

## Notes

- Model-tier facts (tier → provider/model/context-window) live in
  `src/model-tiers.ts` `DEFAULT_TIERS`; keep the README table in sync with it.
- `metrics-schema.ts` is the single source of truth for harness report
  artifacts — schema changes ripple into every harness that writes
  `report.json` / `delta.json`.
- Pricing changes go in `pricing.py` only, so cross-harness cost figures stay
  consistent.
- Full per-file overview: [README.md](README.md).

