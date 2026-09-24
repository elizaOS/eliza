# Orchestrator Lifecycle Benchmark

> Distinct from [`suites/orchestrator`](../orchestrator/), which is the
> repo's meta-runner for executing all benchmarks. This suite is a benchmark
> *of the agent*: it scores multi-turn orchestration lifecycle behavior.

Evaluates the elizaOS agent's multi-turn orchestration behavior across
scripted lifecycle scenarios: clarifying underspecified requests, reporting
subagent status, acknowledging mid-flight scope changes, pause/resume/cancel
interruptions, and delivering stakeholder summaries. Each scenario is a
conversation defined in `scenarios/` with per-turn expected and forbidden
behavior tags. Positive lifecycle checks require the exact shared
`lifecycle_results` capture evidence for the matching operation (spawn / send /
pause / resume / cancel / status_query / share), never raw action labels or
keyword substrings in the reply prose. Spawn evidence additionally requires
`action=create|spawn_agent` and a non-empty task prompt. Scope-change evidence
requires a non-empty `send.input` or resume/reopen `instruction`; an empty
control call cannot claim that an update was applied.
Only strict bridge runs are scored. Simulate and `--no-strict` bridge runs are
diagnostic-marked (`scored: false`, `metrics.overall_score: null`) and cannot be
published as benchmark results.
The CLI enables the full-corpus strict publication contract by default;
`--no-strict` is reserved for explicitly non-publishable diagnostics.

Bridge runs expose the same single parent action, `TASKS`, to every harness.
Eliza starts a lifecycle-scoped `AgentRuntime`, derives a minimal capture-only
wrapper from the native orchestrator's `TASKS` action, and removes unrelated
planner actions while retaining its native dialogue services. Hermes and
OpenClaw receive the exact same schema through generated native tools. All
three bridges return `{captured: true, effect: "not_executed", sequence, tool:
"TASKS"}` and preserve multiple sequential calls in one turn. The shared
instruction defines that neutral capture as terminal for the current
turn unless another independent operation is genuinely required; agents must
not retry solely because no side effect ran and must report non-execution
truthfully. External
isolated turns receive the prior canonical user/assistant history explicitly;
opaque task IDs keep scenario names and expected behavior labels out of model
input.

The evaluator measures structurally grounded lifecycle intent, not whether a
synthetic task target existed, state changed, or a side effect succeeded. Every
report records `measurement_scope: lifecycle_intent_capture_only` and
`side_effects_executed: false`; the strict publisher rejects other claims.
Compatibility metric names such as `status_accuracy_rate` and
`completion_summary_quality` therefore mean captured status/share intent plus a
reply, not verified task-state accuracy or prose quality. Natural-language
truthfulness is not scored because doing so would require a separate model
judge or brittle keyword rules.

## Quick Start

```bash
# Real evaluation (bridge mode — routes turns through the elizaOS TS bench server)
python -m benchmarks.orchestrator_lifecycle.cli \
  --provider claude-subscription --model claude-sonnet-4-6 \
  --output ./benchmark_results/orchestrator-lifecycle

# Smoke test (no keys, no server — deterministic simulator)
python -m benchmarks.orchestrator_lifecycle.cli \
  --mode simulate --no-strict --max-scenarios 3 --output /tmp/olc-smoke

# Via the suite orchestrator
python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle --provider <p> --model <m>
```

## No-publication tri-harness canary

The canary plans one explicit transport-only delegation request from
`fixtures/canary-request.json` across Eliza, Hermes, and OpenClaw without
invoking the scored runner. Its default mode is read-only and prints the opaque
task IDs, request hash, artifact location, and exact expected gateway budget
(Eliza 3 + Hermes 2 + OpenClaw 2):

```bash
PYTHONPATH=packages /opt/miniconda3/bin/python -m \
  benchmarks.orchestrator_lifecycle.canary --model claude-sonnet-4-6
```

`--live` is an explicit seven-call operation. It starts one shared audited
Claude-subscription gateway and three spawned worker processes, waits for all
native managers to report ready, then releases exactly one outer dispatch per
harness. Once released, every lane reaches a terminal state even if a peer
fails, so one harness cannot destroy another harness's evidence. It preserves
health, response, telemetry, native-state, and gateway
audit artifacts under a unique `benchmark_results/canary_*` directory. The
canary never calls scoring, database, latest-snapshot, or viewer publication
code, and it fails if those production targets change during the run.

Every audited SDK request must apply `reasoning_effort=medium` across all three
lanes. The repository target path is transport/provenance metadata only and is
not added to model-visible prompts; each telemetry prompt must contain exactly
one copy of the canary user request. Eliza additionally verifies the exact
shared lifecycle system hint once on each final model input before calling the
provider. Its telemetry persists only the pinned SHA-256 and aggregate
call/type counts, cross-checks them against `MODEL_USED`, and the canary pins
the reviewed graph to one `ACTION_PLANNER` plus two `RESPONSE_HANDLER` calls.
Full publication requires one valid pinned attestation per Eliza lifecycle
turn. Failed runs still retain independently reduced runtime and gateway
summaries, allowlisted partial gateway stages, and any adapter-boundary partial
response/transcript evidence. Those partial artifacts remain explicitly
unvalidated, unscored, and nonpublishable.

See [AGENTS.md](AGENTS.md) for full layout, test commands, and scoring details.
