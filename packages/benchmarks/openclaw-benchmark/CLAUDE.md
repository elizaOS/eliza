# OpenClaw-Bench — Agent Guide

AI coding assistant benchmark evaluating four task categories: environment setup,
feature implementation (weather CLI), refactoring (modular architecture), and testing
(unit + integration). Validates actual code execution and file creation in a sandbox —
not just keyword matching. Registered in the suite registry as `openclaw_bench`.

## Run

```bash
# Direct — single task, execution mode (from this directory)
python eliza_adapter.py --task setup --mode execution

# Direct — all tasks, execution mode, JSON output
python eliza_adapter.py --all --mode execution --json --output-dir ./outputs

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks openclaw_bench --provider <p> --model <m>

# Docker-isolated sandbox
python eliza_adapter.py --all --mode execution --docker

# Via the inner openclaw module directly (bypasses eliza_adapter)
python -m openclaw.runner --all --output-dir ./outputs
```

Available tasks: `setup`, `implementation`, `testing`, `cli_arguments`, `error_handling` (execution mode); `refactoring` is conceptual-mode only.

API key required: `OPENAI_API_KEY` (recommended), `CEREBRAS_API_KEY`, or `GROQ_API_KEY`.
Model override: `--model <name>` or `BENCHMARK_MODEL_NAME` env var (default: `moonshotai/kimi-k2-instruct`).
Base URL override: `OPENAI_BASE_URL` (default: `https://api.groq.com/openai/v1`).

## Smoke test (no API keys)

```bash
# Conceptual mode: keyword-match only, no real code execution, no key required
python eliza_adapter.py --task setup --mode conceptual
```

Note: conceptual-mode scores are not publishable — the scorer in `registry/scores.py`
rejects them. Use this path for harness/import readiness checks only.

## Test the harness

```bash
# From the benchmarks/ suite root (no separate install needed)
pytest openclaw-benchmark/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `eliza_adapter.py` | CLI entrypoint; routes to execution or conceptual runner |
| `openclaw/runner.py` | Execution-mode runner (LLM + sandbox tool loop, up to 15 steps) |
| `openclaw/scoring.py` | Per-check scoring logic (file exists, command output, YAML valid, etc.) |
| `openclaw/sandbox.py` | `SandboxExecutor` — subprocess or Docker isolation |
| `openclaw/scenarios/` | YAML scenario definitions (prompt + scoring rubric per task) |
| `openclaw/validators.py` | Scoring check validators |
| `tests/test_scoring.py` | pytest suite for scoring correctness |
| `benchmark/standard_tasks.md` | Human-readable task specifications |

## Notes

- Results write to `outputs/` (default) or `--output-dir`; filename pattern `openclaw_<task>_exec_<timestamp>.json`.
- Scored by `_score_from_openclaw_bench_json` in `registry/scores.py`. Conceptual-mode results are rejected by the scorer.
- Scenarios run in dependency order when `--all` is used; a shared sandbox is passed between prerequisites so downstream tasks see files left by earlier ones.
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
