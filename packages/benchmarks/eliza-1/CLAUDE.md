# eliza-1 Bench — Agent Guide

Quality and performance benchmark for eliza-1 models. Evaluates three
structured-output tasks — response-handler (`should_respond`), action planner
(`planner`), and per-action parameter extraction (`action:<name>`) — across
four decoding modes: unguided, GBNF-guided, strict-guided, and Cerebras
(Llama-3.1-8B / GPT-OSS-120B as reference). Not registered in the suite
registry; run directly via Bun.

## Run

```bash
# From repo root — run all tasks, all modes, 10 generations each
bun run --cwd packages/benchmarks/eliza-1 start

# Specific task and mode
bun run --cwd packages/benchmarks/eliza-1 start \
  --task should_respond --mode guided --n 5

# Specific eliza-1 tier (GGUF must be on disk)
bun run --cwd packages/benchmarks/eliza-1 start \
  --tier eliza-1-9b --task all --mode unguided,guided

# Skip local engine modes when GGUF is unavailable (CI-safe)
bun run --cwd packages/benchmarks/eliza-1 start \
  --mode cerebras --allow-skip-local

# From inside this directory
bun run src/index.ts --task planner --mode guided --n 3
```

Available tiers: `eliza-1-2b` (smallest/entry), `eliza-1-4b` (first-run default),
`eliza-1-9b`, `eliza-1-27b`, `eliza-1-27b-256k`.

Env: `CEREBRAS_API_KEY` enables the cerebras mode. `ELIZA_BENCH_SKIP_ENGINE=1`
force-skips local engine modes.

## Smoke test (no API keys, no GGUF)

The test suite runs entirely with mock `ModeAdapter` instances and does not
require the local engine or `CEREBRAS_API_KEY`:

```bash
bun run --cwd packages/benchmarks/eliza-1 test
```

## Fixture derivation (dry-run)

```bash
bun run --cwd packages/benchmarks/eliza-1 fixtures:derive:dry-run
```

## Vision CUA e2e sub-harness (stub mode)

```bash
# Generate synthetic PNG fixtures (idempotent)
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e fixtures:generate

# Run the pipeline harness in stub mode (no inference, no OS mouse)
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test
```

## Test the harness

```bash
# Main bench unit tests (metrics, runner, report)
bun run --cwd packages/benchmarks/eliza-1 test

# Vision CUA e2e harness tests
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test
```

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | CLI entrypoint; flag parsing, mode selection |
| `src/runner.ts` | Task × mode orchestrator; `runBench()` |
| `src/metrics.ts` | Scoring helpers: parse, schema check, label match, percentiles |
| `src/report.ts` | Console table + JSON report writer |
| `src/types.ts` | Shared types: `BenchReport`, `CaseMetric`, `ModeAdapter` |
| `src/modes/` | `cerebras.ts`, `eliza-guided.ts`, `eliza-strict-guided.ts`, `eliza-unguided.ts` |
| `src/tasks/` | `should-respond.ts`, `planner.ts`, `action.ts` — fixture loaders + runners |
| `src/fixtures/` | JSON fixture files for all three tasks |
| `scripts/derive-fixtures.mjs` | Fixture derivation script (call via `fixtures:derive`) |
| `__tests__/runner.test.ts` | vitest suite (mock modes; no inference needed) |
| `vision-cua-e2e/` | Integration scaffold for the vision + CUA pipeline |

## Notes

- Results write to `./bench-results-<ISO>.json` by default; override with `--out <path>`.
- Not registered in the suite registry; there is no orchestrator invocation path.
- The vitest suite exercises all metric helpers and the runner's mock-mode path — safe to run on CI without keys or GGUF.
- Vision CUA e2e runs in stub mode by default; set `ELIZA_VISION_CUA_E2E_REAL=1` + wire real plugin adapters for live runs (see `vision-cua-e2e/README.md`).
- Vision CUA trace JSONs write to `vision-cua-e2e/reports/` (gitignored).
- Full background: [vision-cua-e2e/README.md](vision-cua-e2e/README.md).

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
