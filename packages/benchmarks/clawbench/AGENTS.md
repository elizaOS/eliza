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
