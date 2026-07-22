# hermes-adapter

Benchmark adapter for the [hermes-agent](https://github.com/NousResearch/hermes-agent)
tool-calling LLM agent. Drop-in equivalent of the `eliza-adapter` API surface,
swapping the eliza TypeScript bench server for Hermes' native
`run_agent.AIAgent` manager and `run_conversation` loop.

The publishable deployment model is **native subprocess**. A short-lived runner
executes inside the pinned Hermes venv
(`~/.eliza/agents/hermes-agent-src/.venv`), creates `run_agent.AIAgent`, invokes
`run_conversation`, and exchanges JSON on stdout. It points AIAgent at the
suite's loopback OpenAI-compatible subscription gateway; it never calls a model
provider directly.

The Hermes checkout is only the import source. The runner separately pins its
process cwd and `TERMINAL_CWD` to the benchmark workspace, which is the path
Hermes exposes to the model and uses for workspace-relative instructions.

Every client owns a temporary `HERMES_HOME`. Before importing Hermes, the
adapter generates one `eliza-benchmark-tools` user plugin whose tools mirror
the benchmark schemas and whose handlers capture executed arguments. The
profile enables only its `eliza_benchmark_scoped` toolset, disables Tool Search,
and fails if AIAgent exposes any unrelated tool. `health()` proves the pinned
`run_agent.py` source, AIAgent instantiation, exact plugin surface, transport,
and `publishable_native` status.

For `orchestrator_lifecycle`, the scoped catalog contains one `TASKS` parent
tool and the turn budget permits a mutation, a follow-up status operation, and
a terminal response. Every executed call is tied back to native AIAgent
messages and returned in capture order; explicit benchmark history is passed as
`conversation_history`. Because lifecycle targets are synthetic, the handler
records intent without dispatching a real task and returns the shared neutral
`{captured: true, effect: "not_executed", sequence, tool: "TASKS"}` result.
The shared lifecycle instruction defines that capture as terminal for the
current user turn unless another independent operation is genuinely required,
so the native loop can produce a truthful final reply instead of retrying the
same unexecuted intent until its iteration limit.

`mode="in_process"`, a non-loopback base URL, an unverified subprocess result,
or a raw OpenAI SDK/direct-provider proxy is explicitly **nonpublishable** and
fails closed. Those legacy shapes must never be used as Hermes benchmark
evidence.

## Layout

```
hermes_adapter/
  __init__.py          re-exports
  client.py            HermesClient — drop-in equivalent of ElizaClient
  native_runtime.py    AIAgent runner + generated scoped plugin bridge
  server_manager.py    HermesAgentManager — lifecycle owner
  env_runner.py        runs hermes-agent's `evaluate` for a native env
  lifeops_bench.py     per-benchmark agent_fn factory (LifeOpsBench)
  bfcl.py              per-benchmark agent_fn factory (BFCL)
  clawbench.py         per-benchmark agent_fn factory (clawbench)
```

## Quick example

```python
from hermes_adapter import HermesClient

client = HermesClient(
    provider="claude-subscription",
    base_url="http://127.0.0.1:9411/v1",
)
client.wait_until_ready(timeout=60)
print(client.send_message("say PONG").text)
client.close()
```

The orchestrator normally supplies the loopback URL through
`CLAUDE_SUBSCRIPTION_GATEWAY_URL` / `OPENAI_BASE_URL` and the gateway token
through `CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN` / `OPENAI_API_KEY`.

## Running hermes-agent's NATIVE benchmark environments

```python
from pathlib import Path
from hermes_adapter import run_hermes_env

result = run_hermes_env(
    env_id="tblite",
    output_dir=Path("/tmp/tblite-out"),
    max_tasks=2,
)
print(result.score, result.samples_path)
```

The four native env_ids: `hermes_swe_env`, `tblite`, `terminalbench_2`, `yc_bench`.

## Verification

```bash
python -m pytest -q
ruff check hermes_adapter tests
```

Unit tests use fake upstream `run_agent` modules and never spend model credits.
A publishable live run additionally requires a real gateway-backed turn and
manual review of its telemetry/trajectory fields, including
`agent_runtime=hermes`, `native_runtime_class=run_agent.AIAgent`,
`tool_bridge_plugin=eliza-benchmark-tools`,
`transport=subprocess_loopback_openai_compatible`, and
`publishable_native=true`.
