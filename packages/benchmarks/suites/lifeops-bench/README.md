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
|  (base cases +   |     |  Runner           |     |  (Eliza | Hermes |    |
|   language runs) |     |  (orchestrator)   |     |   OpenClaw |       |
+------------------+     +-------------------+     |   PerfectAgent | …)   |
        |                        |                 +----------------------+
        v                        v                          |
+------------------+     +-------------------+              |
|  Persona Library |     |  LifeWorld        |<-------------+ tool calls
|  (32 personas)   |     |  (in-memory state)|
+------------------+     +-------------------+
                                 |
                                 v
                         +-----------------+
                         |  Scorer         |
                         |  state_hash +   |
                         |  semantic judge |
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
cd suites/lifeops-bench
uv sync
# or
pip install -e .[anthropic,test]

# List all scenarios. Every base scenario is expanded under ten model-generated
# language challenges covering vague referents, corrections, colloquial/noisy
# language, code switching, underspecification, stress, relative time, and
# handoffs. `--count-scenarios` prints the current base-vs-run split.
python3 -m eliza_lifeops_bench --list-scenarios

# Run the real elizaOS adapter (the CLI default)
python3 -m eliza_lifeops_bench --agent eliza --domain calendar

# Check harness conformance explicitly; this is not agent evidence
python3 -m eliza_lifeops_bench --agent perfect \
  --scenario smoke_static_calendar_01 --offline-conformance
```

`LIFEOPS_PLANNER_PROMPT_FILE` is optional: when unset, adapters use the
built-in planner prompt. Once explicitly set, a missing, unreadable, empty, or
malformed artifact fails before any model call.

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
defaults to `--agent eliza`. Publishable STATIC and LIVE runs default to
Cerebras for the simulated user and Anthropic for the judge. The provider
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

A default or `--suite full` run includes LIVE scenarios, and semantic STATIC
also requires the evaluator/judge boundary. Both fail clearly when a selected
credential is unavailable. Use `--offline-conformance` only for an explicitly
non-publishable, deterministic harness check. The result JSON records both
provider names and both model IDs. Each semantically evaluated
`ScenarioResult` also carries a
scenario-local `evaluator_trace` with the exact simulated-user and judge
input messages, output text, token/latency/cost telemetry, and raw provider
response. Traces are isolated even when scenarios run concurrently.

An incomplete run still exits nonzero, but it is not discarded. The CLI writes
its available turns, evaluator trace, errors, workload hash, and acting-model
provenance beneath `<output-dir>/diagnostics/` with
`artifact_tier: diagnostic_nonpublishable` and `publishable: false`.
Publishable-result collectors scan only the output root, so a timeout or
provider failure remains inspectable evidence without entering benchmark
scores.

For STATIC runs, structural facts remain deterministic: state hashes and
action names/parameters prove what happened. Natural-language
`required_outputs` and `static_rubric` items are graded together in one
structured judge call. Equivalent paraphrases can pass; copied keywords with
wrong facts cannot. Every positive grade must cite a meaningful verbatim
fragment from an actual executor or eligible tool transcript line, and the
returned criterion IDs must match the requested set exactly. Missing,
malformed, duplicated, or extra coverage invalidates the judge trace and
blocks result publication.

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
elizaOS action connector and the production registry for all 53 contracts.
Every contract has two server-owned typed artifact schemas mapped to its exact
assertions. The signer accepts only a complete, content-addressed terminal
snapshot assembled by server-owned capture or a registered native evaluator
and tied to the action lineage; action-authored `terminalSnapshot` data is
discarded. Missing, altered, extra, stale, or cross-contract artifacts remain
nonterminal. Seven cases have native evaluators: G10, G15, G30, G34, G35, G36,
and G38.
The current runtime provenance schema is intentionally non-publishable:
`local_nonpublishable/not_applicable` and
`provider_backed/not_verified` both carry `release_evidence: false`. The Python
HTTP connector validates either exact shape but rejects it at the release gate
until a future server-owned provider readback is verified. Merely configuring a
provider, passing a local durable receipt, or returning action-authored
`terminalSnapshot` data cannot cross that gate. A `provider_accepted` receipt
must additionally bind its domain idempotency key to the authenticated outer
key.
Real-socket protocol tests and deterministic test connectors remain test
coverage, not provider evidence. See `PLAN.md` for the three-process deployment
and acceptance bar.

## Running with each backend

### Eliza (elizaOS runtime via TS bench server)

The TS bench server lives at `suites/lifeops-bench/runner/src/server.ts` in
this repo (see its README for setup). The adapter's `ElizaServerManager`
launches it automatically, preferring a legacy elizaOS monorepo checkout
(`ELIZA_MONOREPO_ROOT`) when one still bundles the server; alternatively set
`ELIZA_BENCH_URL`/`ELIZA_BENCH_TOKEN` to point at an already-running server.

```bash
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
  --judge-provider hermes --judge-model eliza-1-0_8b-trained:latest \
  --hermes-request-timeout-s 600 \
  --per-scenario-timeout-s 1800
```

Direct Hermes agent and Hermes evaluator/judge HTTP calls default to a
300-second per-request timeout. Set
`LIFEOPS_BENCH_HERMES_REQUEST_TIMEOUT_S` or
`--hermes-request-timeout-s` (CLI wins) for slower local inference; accepted
values are 1–3,600 seconds. The scenario timeout is still the outer deadline
across every agent, evaluator, and judge call, so raise it separately when a
single local completion may exceed the default five-minute scenario budget.
Rate-limit and server responses receive one retry. A transport timeout is not
retried because the local server may still be generating the first request;
the scenario records an error rather than treating an incomplete response as
model output.

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
suites/lifeops-bench/
  eliza_lifeops_bench/
    __main__.py              CLI (argparse front-end)
    types.py                 Scenario / Action / MessageTurn / BenchmarkResult dataclasses
    runner.py                Orchestration + umbrella action executor
    evaluator.py             simulated-user + independent semantic judge wiring
    scorer.py                state/action/semantic-response + pass@k aggregation
    corpus_audit.py           Rebuilds the module/persona/no-effect inventory
    lifeworld/               In-memory hashable world (entities + snapshots)
    scenarios/               base scenarios by domain; __init__.py expands each
                             under ten model-generated language challenges while
                             preserving hidden goals, ground truth, and world seeds
      _personas.py           32 reusable personas
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

`pytest tests/` collects 25,967 tests across 44 files and takes 70+ minutes of CPU, so
it looks hung long before it is. Of those, 24,589 come from
`test_conformance.py` alone, which parameterizes one PerfectAgent-scores-1.0
and two WrongAgent-scores-0 invariants across `ALL_SCENARIOS` — a registry of
16,511 scenarios. The count is expected, not a runaway.

For local work, run the files covering what you changed; the full sweep belongs
in CI rather than in an edit loop:

```bash
python3 -m pytest tests/test_hermes_agent.py tests/test_budget.py -q
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
[`corpus-audit.json`](./corpus-audit.json). The generated audit replays every
base scenario in authored action order and records unsupported operations,
execution errors, mutations, and modeled no-mutation projections. Missing
scheduled-task mutation targets fail rather than being invented by the
executor.

## Pointers

- [`PLAN.md`](./PLAN.md) — wave-by-wave roadmap, scoring methodology, status.
- [`SCENARIO_AUTHORING.md`](./SCENARIO_AUTHORING.md) — how to add a static or live scenario, including the candidate-generator pipeline.
- [`ADAPTER_AUTHORING.md`](./ADAPTER_AUTHORING.md) — how to wire a new backend into the `AgentFn` contract and pass adapter-conformance.
- [`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md) — currently supported action vocabulary + outstanding gaps.
