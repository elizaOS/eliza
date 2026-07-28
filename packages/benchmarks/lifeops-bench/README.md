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
|  (744 static +   |     |  Runner           |     |  (Eliza | Hermes |    |
|   738 live)      |     |  (orchestrator)   |     |   OpenClaw |       |
+------------------+     +-------------------+     |   PerfectAgent | …)   |
        |                        |                 +----------------------+
        v                        v                          |
+------------------+     +-------------------+              |
|  Persona Library |     |  LifeWorld        |<-------------+ tool calls
|  (23 personas)   |     |  (in-memory state)|
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

**Four swappable adapter backends** evaluate the same scenarios:

1. **elizaOS adapter** (`agents/__init__.py::build_eliza_agent`) — drives the elizaOS runtime via the existing TS bench server.
2. **Hermes adapter** (`agents/hermes.py`) — drives any model that speaks the Hermes XML `<tool_call>` template (local Hermes, llama-cpp servers, hosted endpoints).
3. **OpenClaw adapter** (`agents/openclaw.py`) — translates LifeOpsBench history/tools into OpenClaw's text-embedded `<tool_call>{"tool": ..., "args": ...}</tool_call>` protocol.
4. **cerebras-direct adapter** (`agents/cerebras_direct.py`) — calls the eval/teacher model (gpt-oss-120b on Cerebras) directly with the OpenAI tool-call format. Used as the upper-bound reference.

Plus explicit reference oracles for harness sanity:

- **PerfectAgent** — replays scenario-authored actions; useful for conformance,
  but never a benchmark result or provider-evidence source.
- **WrongAgent** — emits unrelated actions or refuses; should score ~0.0.

## Quick start

```bash
cd packages/benchmarks/lifeops-bench
uv sync
# or
pip install -e .[anthropic,test]

# List all scenarios. 1482 base scenarios are expanded 10x under fixed
# prompt-prefix framings (polite/urgent/mobile/…) into 16302 robustness runs;
# each edge variant shares its base's ground-truth actions, required outputs
# and world seed — only the prompt wording differs. `--count-scenarios` prints
# the base-vs-variant split explicitly.
python3 -m eliza_lifeops_bench --list-scenarios

# Run the real elizaOS adapter (the CLI default)
python3 -m eliza_lifeops_bench --agent eliza --domain calendar

# Check harness conformance explicitly; this is not agent evidence
python3 -m eliza_lifeops_bench --agent perfect --scenario smoke_static_calendar_01
```

Expected output (truncated) for an adapter-conformance run:

```
============================================================
  LifeOpsBench Results Summary
============================================================
  Evaluator:          cerebras → zai-glm-4.7
  Judge:              cerebras → gpt-oss-120b
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

Note: `--agent perfect` and `--agent wrong` use per-scenario agent
factories and are limited to explicit harness-conformance checks. The CLI
defaults to `--agent eliza`. LIVE-mode runs default
to Cerebras for the simulated user and Anthropic for the judge. The provider
pair is configurable with `--evaluator-provider` / `--judge-provider` (or
`LIFEOPS_BENCH_EVALUATOR_PROVIDER` / `LIFEOPS_BENCH_JUDGE_PROVIDER`), and
each selected provider requires its own credential. Keep the two model IDs
different to prevent self-agreement bias. For example, a Cerebras-only run
with two distinct models is:

```bash
CEREBRAS_API_KEY=... python3 -m eliza_lifeops_bench \
  --agent cerebras-direct \
  --mode live \
  --evaluator-provider cerebras \
  --evaluator-model zai-glm-4.7 \
  --judge-provider cerebras \
  --judge-model gpt-oss-120b
```

A default or `--suite full` run includes LIVE scenarios and fails clearly
when a selected credential is unavailable; pass `--mode static` when a
deliberately static-only run is intended. The result JSON records both
provider names and both model IDs. Each LIVE `ScenarioResult` also carries a
scenario-local `evaluator_trace` with the exact simulated-user and judge
input messages, output text, token/latency/cost telemetry, and raw provider
response. Traces are isolated even when scenarios run concurrently.

### Authenticated execution for evidence-gated LIVE scenarios

Some LIVE suites require proof from a real production, sandbox, or native
execution boundary. They intentionally score zero when run only against the
deterministic LifeWorld, even if the model and judge both claim success.
Enable the external boundary explicitly:

```bash
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_URL=https://executor.example/execute
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_HMAC_KEY_B64="$(openssl rand -base64 32)"
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_HMAC_KEY_B64="$(openssl rand -base64 32)"
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_KEY_ID=request-key-v1
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_KEY_ID=receipt-key-v1
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_ALLOWED_PROVIDERS=calendar-sandbox
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_ALLOWED_BOUNDARIES=sandbox_connector
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_BEARER_TOKEN=...
python3 -m eliza_lifeops_bench --agent eliza --scenario <gated-scenario-id>
```

The executor receives a runner-signed request containing a unique run nonce,
scenario ID, seed, exact tool name and arguments, tool-call ID, and the
scenario's versioned contract ID and hash. Assertion IDs and definitions do
not cross this boundary: the independently controlled executor resolves the
contract and derives postconditions from provider state. It returns a
sanitized tool payload, an inspectable terminal artifact manifest, and an
HMAC-signed `lifeops.trusted-evidence.v3` receipt.

The runner validates the complete action batch against the scenario's
allowlist and a LifeWorld shadow before the first external dispatch. It then
recomputes request, payload, and artifact SHA-256 digests; pins the receipt key
to exact providers, boundaries, and contracts; enforces request-relative
freshness; rejects duplicate tool-call or receipt IDs; and retains the full
signed envelope and artifact for scoring and human review. A final terminal
postcondition artifact must cover the exact assertion set. Model-authored
prose, adapter metadata, deterministic results, and earlier state that a later
action undoes cannot satisfy the gate.

HTTP is accepted only on an explicit loopback host; remote executors must use
HTTPS. Request-authentication and receipt-signing keys must be distinct. The
CLI removes both keys, both key IDs, the provider/boundary allowlists, and the
bearer token from its environment before constructing the evaluated agent.
Treat the adapter implementation as harness code, not untrusted
model-generated code, and run any arbitrary-code agent in a separate process
that does not inherit executor credentials. Transport errors and unverifiable
responses are terminal because the provider outcome may be unknown and an
automatic retry could duplicate a real write.

The benchmark client does not make an executor trustworthy. The executor must
independently enforce the same contract action policy, consume nonces
durably, use provider idempotency keys for writes, preserve redacted source
artifacts, and keep its contract implementation and receipt key outside the
evaluated agent's process. A deterministic or in-process signing test is
protocol coverage, not production or sandbox connector evidence.

`eliza_lifeops_bench.trusted_executor_server` provides the reference boundary:
an exact contract registry, injected connector and server-owned evaluator
interfaces, durable SQLite replay/idempotency state, signed terminal artifacts,
and a bounded `ThreadingHTTPServer` handler.
`eliza_lifeops_bench.runtime_connector` supplies a separate-process native
elizaOS action connector and a structured evaluator for contract G10. The
production registry deliberately contains only that implemented contract; the
other 47 evidence contracts fail closed before dispatch. Real-socket protocol
tests and the deterministic test connector remain test coverage, not provider
evidence. See `PLAN.md` for the three-process deployment and acceptance bar.

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

`--agent hermes` uses the native source harness. To call an already-running
OpenAI-compatible endpoint directly—including a local Ollama, vLLM, or
llama.cpp server—use `--agent hermes-direct`:

```bash
HERMES_BASE_URL=http://127.0.0.1:11434/v1 \
MODEL_NAME_OVERRIDE=gemma3:latest \
python3 -m eliza_lifeops_bench --agent hermes-direct --mode live \
  --evaluator-provider hermes --evaluator-model llama3.2:3b \
  --judge-provider hermes --judge-model eliza-1-0_8b-trained:latest
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
    corpus_audit.py           Rebuilds the module/persona/no-effect inventory
    lifeworld/               In-memory hashable world (entities + snapshots)
    scenarios/               1482 base scenarios (744 static + 738 live) by domain;
                             __init__.py expands each 10x under fixed prompt-prefix
                             framings into 16302 robustness runs (variant shares its
                             base's ground-truth/required-outputs/world-seed)
      _personas.py           23 reusable personas
      _smoke_scenarios.py    Two original smoke scenarios (kept at front of list)
      _authoring/            Candidate-generator pipeline + spec
        spec.md              Authoring guide (also fed to Cerebras as a prompt)
        generate_candidates.py
        validate.py
        import_reviewed.py
      calendar.py mail.py messages.py contacts.py reminders.py
      finance.py travel.py health.py sleep.py focus.py
      live/                  LIVE-mode dual-agent scenarios
      expanded/              300 harder scenarios across 10 LifeOps capability areas
    agents/                  Adapters + reference agents
      perfect.py wrong.py
      hermes.py cerebras_direct.py
      _openai_compat.py      Shared scaffolding for OpenAI-compatible clients
    clients/                 BaseClient + Cerebras / Anthropic / Hermes wrappers
    ingest/                  Real-trajectory ingest with privacy filter (Wave 3D)
      privacy.py             Credential + geo redaction (Python port of TS source)
      trajectories.py        Disk loader; mandatory privacy filter; strict-mode raise
  tests/                     Hermetic, socket-boundary, and env-gated live tests
  corpus-audit.json          Generated base-corpus module/persona/no-effect inventory
  manifests/
    actions.manifest.json    Committed JSON-Schema dump of every Eliza action
    actions.summary.md       Human-readable index regenerated with the manifest
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
python3 -m eliza_lifeops_bench.corpus_audit --output corpus-audit.json
```

Regenerate `manifests/actions.manifest.json` and `manifests/actions.summary.md`
after changing LifeOps or todo action metadata:

```bash
bun run lifeops-bench:manifest
```

The command exports the live elizaOS plugin action registry, then applies the
bench-only umbrella augment from `eliza_lifeops_bench.manifest_export`.

The hermetic suite uses deterministic provider doubles for protocol and runner
coverage; those results are never labeled live evidence. Live network tests
remain env-gated because they require credentials for distinct simulated-user
and judge models and spend real inference budget.

## Known gaps

See [`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md) and
[`corpus-audit.json`](./corpus-audit.json). The current base corpus contains
346 action occurrences across 304 STATIC scenarios whose semantics are not
modeled by LifeWorld. Every such dispatch now returns an explicit non-success
result (`ok=false`, `status=unsupported`, `noEffect=true`); none can masquerade
as a successful empty result. The generated audit retains every affected
scenario, action, arguments, and reason, while modeled reads and conversational
terminals live in a separate exemption registry.

## Pointers

- [`PLAN.md`](./PLAN.md) — wave-by-wave roadmap, scoring methodology, status.
- [`SCENARIO_AUTHORING.md`](./SCENARIO_AUTHORING.md) — how to add a static or live scenario, including the candidate-generator pipeline.
- [`ADAPTER_AUTHORING.md`](./ADAPTER_AUTHORING.md) — how to wire a new backend into the `AgentFn` contract and pass adapter-conformance.
- [`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md) — currently supported action vocabulary + outstanding gaps.
