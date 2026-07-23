# ClawBench

Deterministic, scenario-based evaluation of agent tool-use decisions across
multi-tool personal-assistant workflows: email, calendar, Slack, tasks, and
memory. Every scenario runs against fixture data served by a mock tools server,
and trajectories are scored by a regex rubric — no LLM judge, so scores are
directly comparable across runs, models, and prompt variants. Registered in the
suite registry as `clawbench`.

## What it measures

Unit tests check whether tools work; ClawBench checks whether the agent makes
the **right decisions** — picks the right tool at the right time, cross-references
sources, respects safety constraints (don't send that email, don't leak the
confidential finding), and stays within a tool-call budget. All scenarios share
one universe (Alex Chen, Tech Lead at TechCorp) with a realistic team, clients,
calendar, and workload.

| Scenario | Difficulty | Checks | Focus |
| --- | :---: | :---: | --- |
| `inbox_triage` | Easy | 6 | Review inbox, draft urgent replies (smoke test) |
| `morning_brief` | Medium | 12 | Synthesize calendar + inbox + tasks into a brief |
| `team_standup` | Medium | 11 | Cross-reference Slack against a deliberately stale sprint board |
| `inbox_to_action` | Hard | 14 | Turn 20 overnight emails into a deduplicated decision queue |
| `client_escalation` | Hard | 15 | P0 client issue: triage across email, Slack, tasks, calendar |

Rubric checks (`clawbench/scoring.py`) cover four categories — safety,
correctness, efficiency, structure — using check types like `tool_called`,
`tool_not_called`, `tool_count_max`, `tool_called_before`, `response_contains`,
and `response_excludes`. Scenario definitions live in `scenarios/*.yaml`;
per-scenario fixture data (inbox, calendar, tasks, Slack, memory files) lives in
`fixtures/`.

## Quick start

```bash
# Direct via the eliza adapter (auto-starts the benchmark server)
python eliza_adapter.py --scenario inbox_triage

# No-key offline layers: handler + scoring unit tests
python scripts/test_handlers.py && python scripts/test_scoring.py

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks clawbench --provider <p> --model <m>
```

## Integration

- Registry command builder: `_clawbench_cmd` in `registry/commands.py` — routes
  through `eliza_adapter.py` (or `clawbench.multi_harness_runner` for the
  eliza/hermes/openclaw/smithers harness matrix) and honors `--scenario` /
  `--variant` extras.
- Scored by `_score_from_clawbench_json` in `registry/scores.py`; results land
  in the orchestrator output dir as `trajectory_<scenario>_<timestamp>.json`.
- The mock tools server (`clawbench/mock_tools/server.py`, FastAPI) mirrors the
  real tool surface — `slack`, `exec` (email/tasks/calendar via command pattern
  matching), `memory_search`/`memory_get`, `web_search`/`web_fetch`, `read` —
  and returns deterministic fixture data, so episodes are reproducible.

## Adding a scenario

Create `scenarios/<name>.yaml` (prompt, tools, `AGENTS.md.baseline` /
`AGENTS.md.optimized` variants, scoring checks) plus a `fixtures/<name>/`
directory with the data the scenario needs, then validate with
`./scripts/test_full.sh --quick`. Good scenarios have clear right/wrong answers,
require cross-tool reasoning, and include safety traps.

See [AGENTS.md](AGENTS.md) for full run options (including the Docker
full-integration path against a live OpenClaw gateway), smoke paths, layout, and
test commands.
