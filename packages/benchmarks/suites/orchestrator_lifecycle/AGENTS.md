# Orchestrator Lifecycle — Agent Guide

Multi-turn orchestration lifecycle benchmark: evaluates the elizaOS agent's
ability to handle clarification requests, status check-ins, scope changes,
pause/resume/cancel interruptions, and stakeholder summaries across scripted
scenario conversations. Registered in the suite as `orchestrator_lifecycle`.

## Run

```bash
# Direct (bridge mode — real elizaOS TS agent via bench server)
python -m benchmarks.orchestrator_lifecycle.cli \
  --provider openai --model gpt-4o \
  --output ./benchmark_results/orchestrator-lifecycle

# Through the suite orchestrator (manages provider/model, stores results)
python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle --provider <p> --model <m>
```

## Smoke test (no API keys, no TS server)

```bash
python -m benchmarks.orchestrator_lifecycle.cli \
  --mode simulate \
  --no-strict \
  --max-scenarios 3 \
  --output /tmp/olc-smoke
```

`--mode simulate` uses a deterministic simulator that emits typed lifecycle
events. It does not call any LLM or start the elizaOS bench server. Simulate
reports are smoke-marked (`scored: false`, `metrics.overall_score: null`) so
the suite registry refuses to publish them as benchmark results.

## Test the harness

```bash
# From the repo root (benchmarks package must be importable)
pytest suites/orchestrator_lifecycle/tests/ -v
```

The tri-harness canary is dry-run by default:

```bash
PYTHONPATH=packages /opt/miniconda3/bin/python -m \
  benchmarks.orchestrator_lifecycle.canary --model claude-sonnet-4-6
```

Do not add `--live` without explicit operator approval to spend exactly seven
Claude-subscription requests. Live mode uses three spawned workers and one
shared gateway, performs one outer dispatch per harness, writes only a unique
`benchmark_results/canary_*` evidence tree, and fails if any production SQLite,
`latest/`, or viewer target changes. It must never import or call the scored
runner, report writer, database, or publication builders.

The canary pins `reasoning_effort=medium` on every gateway request and requires
the exact canary user request once in each lane's telemetry prompt. Repository
paths are transport/provenance controls, never model-visible prompt content. A
failed cohort still records independently derived per-lane runtime/gateway
summaries, allowlisted partial gateway stages, and available adapter response or
transcript evidence; every partial artifact is explicitly unvalidated,
unscored, and nonpublishable.

Eliza lifecycle turns also attest the shared system hint at the final
`recordLlmCall` provider boundary. A missing or duplicate copy throws before
the provider callback can spend quota. Per-turn telemetry stores only the
pinned SHA-256 and call/type counts, and those counts must equal the captured
`MODEL_USED` call count. The canary further pins its reviewed three-call graph
to `ACTION_PLANNER: 1` and `RESPONSE_HANDLER: 2`; full publication requires one
valid pinned attestation for every lifecycle telemetry turn.

Full subscription publication segments requests by each telemetry turn's
native model-boundary count. Eliza permits one clarification
`RESPONSE_HANDLER` or `RESPONSE_HANDLER` → one or more
`ACTION_PLANNER`/`TASKS` calls → completion `RESPONSE_HANDLER`; all `TEXT_*`
routes are rejected. Hermes and OpenClaw permit only `TASKS` with `auto`, zero
or more tool rounds, then a terminal stop. Schemas, choices, calls/results,
message-role growth, `reasoning_effort=medium`, content proof, and
`parallel_tool_calls` must match; whole-request hashes need not match across
native scaffolds.

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | Argument parser + `main()` entrypoint |
| `contract.py` | Side-effect-free shared system hint + canonical TASKS loader |
| `fixtures/canary-request.json` | Explicit non-scored delegation probe for the transport canary |
| `runner.py` | `LifecycleRunner` — bridge and simulate execution modes |
| `evaluator.py` | Structural per-turn scoring of typed lifecycle events |
| `events.py` | Planner actions/params → typed lifecycle events |
| `dataset.py` | Loads scenario JSON files |
| `reporting.py` | Writes result JSON to output dir |
| `types.py` | `LifecycleConfig`, `ScenarioResult`, `LifecycleMetrics` |
| `scenarios/` | 12 JSON scenario definitions + schema |
| `tests/` | pytest suite (smoke + evaluator + dataset + schema) |

## Notes

- Results write to `./benchmark_results/orchestrator-lifecycle/` as
  `orchestrator-lifecycle-<timestamp>.json` (gitignored).
- CLI runs are strict by default. Only strict bridge mode is scored;
  `--no-strict` bridge and simulate reports set `scored: false`, withhold
  `metrics.overall_score`, and are rejected by the publisher.
- Scored by `_score_from_orchestrator_lifecycle_json` in `registry/scores.py`.
- Bridge mode (default for LLM providers) forwards each turn to the elizaOS TS
  bench server managed by `harnesses/eliza` (`ElizaServerManager`) via
  `ElizaClient.send_message`. Set `ELIZA_BENCH_URL` to reuse a running server.
- Lifecycle bridge runs expose one parent action named `TASKS` across all three
  harnesses. Eliza uses a dedicated `AgentRuntime` profile with a minimal
  capture-only wrapper derived from the native orchestrator action; the public
  action registry is pruned to exactly `TASKS` while native dialogue services
  remain. Hermes and OpenClaw use generated native tool bridges with the exact
  same schema and neutral `not_executed` result. Every sequential `TASKS` call
  is preserved in order.
- Capture-only native bridges expose the same `lifecycle_results` payload:
  `{name, arguments, result}`. The result must be exactly `{captured: true,
  effect: "not_executed", sequence, tool: "TASKS"}` and must be recorded by the
  handler before it is returned. Missing or mismatched results fail closed.
  The shared system instruction tells every harness that this neutral capture
  is terminal for the current user turn: it must not retry or substitute an
  operation solely because the benchmark deliberately executed no side effect,
  and its reply must state the non-execution truthfully.
- Hermes and OpenClaw turns are isolated, so the runner supplies prior
  canonical user/assistant messages explicitly. Eliza keeps its native room
  history. Task IDs are opaque and model context never contains scenario IDs,
  expected behavior tags, or other answer labels.
- Execution follows `LifecycleDataset.load()`: every base scenario first, then
  expanded edge variants. Sorted manifests verify corpus pins only and never
  reorder model execution.
- Every positive lifecycle check requires the exact shared `lifecycle_results`
  capture evidence for its operation; raw action/event labels do not score.
  Spawn additionally requires `action=create|spawn_agent` and a non-empty task.
  Scope changes require non-empty `send.input` or resume/reopen `instruction`.
- Reports declare `measurement_scope: lifecycle_intent_capture_only` and
  `side_effects_executed: false`, which the strict publisher enforces. Metric
  names such as `status_accuracy_rate` and `completion_summary_quality` are
  compatibility names for structurally grounded intent plus a reply, not proof
  of real task state, side effects, or prose quality.
- Simulate mode is kept only for offline CI smoke-testing; it does not measure
  the real agent.
- Full scenario schema: [scenarios/README.md](scenarios/README.md).
