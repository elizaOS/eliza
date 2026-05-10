# LifeOpsBench

Multi-turn, tool-use benchmark for life-assistant agents. LifeOpsBench
evaluates whether an agent can complete real life-management tasks
(calendar, mail, messages, contacts, reminders, finance, travel,
health, sleep, focus) by emitting the correct tool calls against a
deterministic, hashable world state — and saying the right things to a
simulated user along the way.

Existing benchmarks evaluate either pure schema-only function calling
(BFCL), retail/airline ops (tau-bench), browser DOM manipulation
(ClawBench), or open-ended conversation quality (woobench). None of
them target the surface a personal life assistant actually lives on:
heterogeneous tool ecosystems, partial information, multi-turn
clarification, and verifiable end-state correctness.

## Architecture

```
+------------------+     +-------------------+     +----------------------+
|  Scenario Corpus |---->|  LifeOpsBench     |<----|  Agent Adapter        |
|  (53 static +    |     |  Runner           |     |  (Eliza | Hermes |    |
|   15 live)       |     |  (orchestrator)   |     |   Cerebras-direct |   |
+------------------+     +-------------------+     |   PerfectAgent | …)   |
        |                        |                 +----------------------+
        v                        v                          |
+------------------+     +-------------------+              |
|  Persona Library |     |  LifeWorld        |<-------------+ tool calls
|  (10 personas)   |     |  (in-memory state)|
+------------------+     +-------------------+
                                 |
                                 v
                         +-----------------+
                         |  Scorer         |
                         |  state_hash +   |
                         |  substring +    |
                         |  pass^k +       |
                         |  per-domain     |
                         +-----------------+
```

**Three swappable adapter backends** evaluate the same scenarios:

1. **elizaOS adapter** (`agents/__init__.py::build_eliza_agent`) — drives the elizaOS runtime via the existing TS bench server.
2. **Hermes adapter** (`agents/hermes.py`) — drives any model that speaks the Hermes XML `<tool_call>` template (local Hermes, llama-cpp servers, hosted endpoints).
3. **cerebras-direct adapter** (`agents/cerebras_direct.py`) — calls the eval/teacher model (gpt-oss-120b on Cerebras) directly with the OpenAI tool-call format. Used as the upper-bound reference.

Plus reference oracles for sanity:

- **PerfectAgent** — emits the scenario's ground-truth actions; should score ~1.0.
- **WrongAgent** — emits unrelated actions or refuses; should score ~0.0.

The OpenClaw adapter (`agents/openclaw.py`, Wave 2D) is still pending —
the upstream `openclaw-adapter` package is currently 404 in the
workspace and the wiring is blocked on its first published release.

## Quick start

```bash
cd packages/benchmarks/lifeops-bench
uv sync
# or
pip install -e .[anthropic,test]

# List all registered scenarios (68 total at time of writing)
python3 -m eliza_lifeops_bench --list-scenarios

# Run the calendar smoke scenario against the perfect oracle
python3 -m eliza_lifeops_bench --agent perfect --domain calendar
```

Expected output (truncated) for an adapter-conformance run:

```
============================================================
  LifeOpsBench Results Summary
============================================================
  Model:              gpt-oss-120b
  Judge:              claude-opus-4-7
  Seeds per scenario: 1
  Scenarios run:      N
  pass@1:             1.000
  pass@k:             1.000
  Total cost:         $0.0000
  Mean score per domain:
    calendar     1.000
    …
============================================================
```

Note: the `--agent perfect` CLI path currently requires the runner to
inject a scenario into the agent constructor, so the typical entry
point for hermetic verification is the test suite
(`tests/test_adapter_conformance.py`) rather than the CLI directly.
Live-LLM runs through `--agent hermes` / `--agent cerebras-direct`
work as documented below.

## Running with each backend

### Eliza (elizaOS runtime via TS bench server)

```bash
# Spawns the TS bench server automatically. Set ELIZA_BENCH_URL/_TOKEN
# to point at an already-running server instead.
python3 -m eliza_lifeops_bench --agent eliza --domain calendar
```

### Hermes-template models

```bash
HERMES_BASE_URL=http://localhost:8080/v1 \
HERMES_API_KEY=token \
HERMES_MODEL=NousResearch/Hermes-3-Llama-3.1-70B \
python3 -m eliza_lifeops_bench --agent hermes --domain mail
```

### Cerebras-direct (gpt-oss-120b reference)

```bash
CEREBRAS_API_KEY=... \
python3 -m eliza_lifeops_bench --agent cerebras-direct --seeds 3
```

### Cost / time discipline

```bash
python3 -m eliza_lifeops_bench \
    --agent hermes \
    --max-cost-usd 5.00 \
    --per-scenario-timeout-s 120 \
    --concurrency 4
```

`--max-cost-usd` is a cumulative cap across the whole run; once
exhausted, every still-pending scenario is marked
`terminated_reason="cost_exceeded"`.

## Directory layout

```
packages/benchmarks/lifeops-bench/
  eliza_lifeops_bench/
    __main__.py              CLI (argparse front-end)
    types.py                 Scenario / Action / MessageTurn / BenchmarkResult dataclasses
    runner.py                Orchestration + umbrella action executor
    evaluator.py             LIVE-mode simulated-user + judge wiring
    scorer.py                state_hash, output_substring, pass@k aggregation
    lifeworld/               In-memory hashable world (entities + snapshots)
    scenarios/               53 static + 15 live scenarios, organized by domain
      _personas.py           10 reusable personas
      _smoke_scenarios.py    Two original smoke scenarios (kept at front of list)
      _authoring/            Candidate-generator pipeline + spec
        spec.md              Authoring guide (also fed to Cerebras as a prompt)
        generate_candidates.py
        validate.py
        import_reviewed.py
      calendar.py mail.py messages.py contacts.py reminders.py
      finance.py travel.py health.py sleep.py focus.py
      live/                  LIVE-mode dual-agent scenarios
    agents/                  Adapters + reference agents
      perfect.py wrong.py
      hermes.py cerebras_direct.py
      _openai_compat.py      Shared scaffolding for OpenAI-compatible clients
    clients/                 BaseClient + Cerebras / Anthropic / Hermes wrappers
    ingest/                  Real-trajectory ingest with privacy filter (Wave 3D)
      privacy.py             Credential + geo redaction (Python port of TS source)
      trajectories.py        Disk loader; mandatory privacy filter; strict-mode raise
  tests/                     574 passing tests (3 live-gated skips)
  manifests/
    actions.manifest.json    JSON-Schema dump of every Eliza action
    actions.summary.md       Human-readable index
  data/
    snapshots/               Deterministic seeded LifeWorld snapshots
  PLAN.md                    Wave-by-wave roadmap and open questions
  SCENARIO_AUTHORING.md      How to add a scenario
  ADAPTER_AUTHORING.md       How to add a backend adapter
  LIFEOPS_BENCH_GAPS.md      Action-name + subaction gaps the executor doesn't cover
```

## Tests

```bash
python3 -m pytest tests/ -v
```

Current state: **574 tests passing, 3 skipped** (live-gated — they
require `CEREBRAS_API_KEY` + `ANTHROPIC_API_KEY` and run real LLM
calls). One pre-existing failure
(`test_every_action_name_exists_in_manifest`) is in scope for Wave 4C
and is intentionally left red.

## Known gaps

See [`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md) for the
canonical list of action names the runner's executor doesn't yet
support, plus subactions that no-op because LifeWorld lacks the
underlying entity (focus blocks, interaction logs, hotel bookings).
The adapter-conformance test (`tests/test_adapter_conformance.py`)
already filters scenarios to those whose ground-truth actions are all
in `runner.supported_actions()`; gaps therefore surface as skipped
scenarios rather than silent failures.

## Pointers

- [`PLAN.md`](./PLAN.md) — wave-by-wave roadmap, scoring methodology, status.
- [`SCENARIO_AUTHORING.md`](./SCENARIO_AUTHORING.md) — how to add a static or live scenario, including the candidate-generator pipeline.
- [`ADAPTER_AUTHORING.md`](./ADAPTER_AUTHORING.md) — how to wire a new backend into the `AgentFn` contract and pass adapter-conformance.
- [`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md) — currently supported action vocabulary + outstanding gaps.
