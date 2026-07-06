# ClawBench — Agent Guide

Deterministic, scenario-based evaluation for OpenClaw agents. Evaluates tool-use
decisions (email, calendar, Slack, tasks) across 5 scenarios using regex-scored
rubrics — no LLM judge, fully reproducible. Registered in the suite registry as
`clawbench`.

## Run

```bash
# Direct via eliza adapter (from clawbench/ dir), auto-starts benchmark server
python eliza_adapter.py --scenario inbox_triage

# Run all scenarios in batch
python scripts/run_batch.py

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks clawbench --provider <p> --model <m>

# With Docker (full integration — real OpenClaw + mock tools server)
SCENARIO=client_escalation VARIANT=optimized docker compose up --build
python scripts/run_episode.py --scenario client_escalation --wait
```

## Smoke test (no API key, no Docker)

```bash
# Start the mock tools server
FIXTURES_PATH=./fixtures SCENARIO=client_escalation \
  python -m clawbench.mock_tools.server

# Layer 1+2: handler and scoring unit tests (no server, no API key)
python scripts/test_handlers.py
python scripts/test_scoring.py

# Layers 1-3: all offline tests
./scripts/test_full.sh --quick
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `eliza_adapter.py` | Canonical entrypoint (registry-invoked); routes to elizaOS benchmark server |
| `clawbench/cli.py` | Typer CLI (`clawbench run <scenario>`) for direct use |
| `clawbench/scoring.py` | Regex-based scoring engine (no LLM) |
| `clawbench/mock_tools/server.py` | FastAPI mock server returning deterministic fixture data |
| `clawbench/multi_harness_runner.py` | Multi-harness runner (eliza/hermes/openclaw/smithers) |
| `scenarios/*.yaml` | Scenario definitions with rubric checks |
| `fixtures/` | Deterministic per-scenario data (inbox, calendar, tasks, Slack, memory) |
| `scripts/run_episode.py` | Run one episode against a live OpenClaw gateway |
| `scripts/run_batch.py` | Run all scenarios |
| `tests/test_scoring_intent.py` | pytest suite for scoring engine |

## Scenarios

| Scenario | Difficulty | Checks |
| --- | --- | --- |
| `inbox_triage` | Easy | 6 |
| `morning_brief` | Medium | 12 |
| `team_standup` | Medium | 11 |
| `inbox_to_action` | Hard | 14 |
| `client_escalation` | Hard | 15 |

## Notes

- Results write to `outputs/trajectory_<scenario>_<timestamp>.json` (gitignored via `.gitkeep`).
- Scored by `_score_from_clawbench_json` in `registry/scores.py`.
- Registry command builder: `_clawbench_cmd` in `registry/commands.py`.
- `CLAWBENCH_MODEL` env var sets the LLM (default: `anthropic/claude-sonnet-4.6`).
- Full background and scenario authoring guide: [README.md](README.md).

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
