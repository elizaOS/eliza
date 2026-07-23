# lib — Agent Guide

Shared infrastructure imported by every harness and the orchestrator in the
LifeOpsBench suite — not a runnable benchmark and not registered in the suite
registry. Two parallel layers live here because the harnesses are polyglot:
TypeScript under `src/` (imported as `@elizaos-benchmarks/lib`) and Python at
the top level (imported as `lib` with `packages/benchmarks` on `PYTHONPATH`).

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
cd packages/benchmarks/lib
bun run test

# Typecheck + lint + format check
bun run check

# Python layer (pytest, from the suite root so `lib` resolves)
cd packages/benchmarks
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
