# ADHDBench — Agent Guide

Attention & context scaling benchmark for ElizaOS agents. Measures whether an
agent selects the correct action and context as cognitive load increases, producing
an attention scaling curve (accuracy vs. context load). Not registered in the
suite orchestrator registry — run directly via its own CLI.

## Run

```bash
# From this directory
cd packages/benchmarks/adhdbench
pip install -e .

# Quick run (L0 only, 2 scale points, ~5 min)
python scripts/run_benchmark.py run --quick --model openai/gpt-oss-120b --provider openai

# Full run (all levels, all scales, both configs)
python scripts/run_benchmark.py run --full --model gpt-4o --provider openai

# Route through the ElizaOS TypeScript benchmark bridge
python scripts/run_benchmark.py run --full --model gpt-4o --provider eliza

# List all scenarios
python scripts/run_benchmark.py list

# Compute baselines (no LLM needed)
python scripts/run_benchmark.py baselines
```

`--provider` is required (no default). Choices: `mock-passthrough`, `eliza`,
`openai`, `cerebras`, `groq`, `openrouter`, `vllm`.

## Smoke test (no API keys)

```bash
python scripts/run_benchmark.py run --quick --provider mock-passthrough
```

`mock-passthrough` is the deterministic local runner — always scores ~100% by
construction; useful only for harness smoke tests.

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `scripts/run_benchmark.py` | CLI entrypoint (`run`, `baselines`, `list` subcommands) |
| `elizaos_adhdbench/runner.py` | Orchestration loop (mock-passthrough path) |
| `elizaos_adhdbench/openai_runner.py` | OpenAI-compatible provider runner |
| `elizaos_adhdbench/scenarios.py` | 45 scenarios across L0/L1/L2 |
| `elizaos_adhdbench/distractor_plugin.py` | 50 distractor actions across 9 domains |
| `elizaos_adhdbench/evaluator.py` | 7 deterministic binary evaluators |
| `elizaos_adhdbench/config.py` | All tuneable axes (scale points, levels, configs) |
| `elizaos_adhdbench/types.py` | Frozen scenario/result types |
| `elizaos_adhdbench/reporting.py` | Markdown, JSON, ASCII scaling curve output |
| `tests/` | pytest suite (144 tests) |

## Notes

- Results write to `./adhdbench_results/` by default (override with `--output`).
- Not registered in `registry/commands.py` or `registry/scores.py` — no orchestrator invocation path.
- 45 scenarios across 3 levels: L0 (action dispatch), L1 (context tracking), L2 (complex execution).
- 5 scale points: 10–200 registered actions; 2 configurations: basic vs full (advancedMemory + advancedPlanning).
- Full background: [README.md](README.md).

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
