# openclaw-adapter

Python bridge that connects benchmark runners to the [OpenClaw](https://docs.openclaw.ai/)
embedded agent runtime. It implements the same small client surface as
`eliza-adapter` and `hermes-adapter`, while retaining OpenClaw's own planning
and tool-execution loop.

## Architecture

```
Python Benchmark Runner
    |  (imports adapter)
openclaw-adapter
    |  (isolated state + generated native benchmark plugin)
openclaw agent --local --json --agent benchmark
    |  (loopback OpenAI-compatible completion request)
Claude subscription gateway
```

Each turn receives a fresh state directory. `native_runtime.py` writes a
key-free config for the custom loopback provider and a native plugin containing
only the supplied benchmark tools. The plugin records actual executions to an
isolated JSONL capture; those executions, rather than model text that resembles
a call, become `MessageResponse.tool_calls`.

The adapter canonicalizes complete benchmark history into the isolated turn
prompt because the embedded command owns its conversation. Tool schemas remain
native OpenClaw plugin tools. This gives text and tool benchmarks one common
runtime path without leaking developer configuration, memories, skills, or
unrelated tools into the score.

For `orchestrator_lifecycle`, the generated catalog contains one `TASKS` parent
tool. The capture file retains every sequential execution in a turn, including
patterns such as spawn-then-status or resume-then-send, and the adapter returns
them in execution order. Prior benchmark turns are rendered into the isolated
turn prompt exactly once. The synthetic lifecycle target is not dispatched;
each call receives the shared neutral `{captured: true, effect:
"not_executed", sequence, tool: "TASKS"}` result.

Publishable runs must use a loopback completion URL. The token appears only as
an environment reference in generated config. Per-turn telemetry proves the
runtime, transport, native plugin bridge, config hash, provider, and model; the
orchestrator quarantines missing or inconsistent proof. A zero CLI exit or
OpenClaw summary status is not sufficient: the adapter hashes the native
session transcript and rejects a terminal assistant error. Missing transcript
evidence makes the response explicitly non-publishable.

`direct_openai_compatible=True` and `OPENCLAW_DIRECT_OPENAI_COMPAT=1` remain for
hermetic parser/retry tests. They set `publishable_native=false` and cannot
enter published benchmark results.

## Layout

```
openclaw_adapter/
  __init__.py          re-exports OpenClawClient, OpenClawCLIManager, MessageResponse
  client.py            OpenClawClient — orchestrates each isolated native turn
  native_runtime.py    generated config, native tool plugin, and capture parser
  server_manager.py    OpenClawCLIManager — lifecycle (start = validate binary; stop = clear started state)
  clawbench.py         build_clawbench_agent_fn — runs an openclaw scenario via CLI
  bfcl.py              build_bfcl_agent_fn — function-call-style benchmark factory
  lifeops_bench.py     build_lifeops_bench_agent_fn — LifeOpsBench compatible
```

## Quick example

```python
from openclaw_adapter import OpenClawClient

client = OpenClawClient(
    provider="claude-subscription",
    model="claude-opus-4-6",
    api_key_env="CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN",
    base_url_env="CLAUDE_SUBSCRIPTION_GATEWAY_URL",
    thinking_level="medium",
)
client.wait_until_ready(timeout=60)
print(client.send_message("Reply with the single word: PONG").text)
```

The client spawns:

```bash
openclaw agent --local --json --agent benchmark \
    --model eliza-benchmark-gateway/claude-opus-4-6 \
    --thinking medium \
    --timeout 600 \
    --message "Reply with the single word: PONG"
```

The generated provider config points that model at the loopback gateway. It
disables bootstrap/skills and denies every non-benchmark tool.

## Configuration

| Constructor arg | Default | Description |
|---|---|---|
| `binary_path` | resolved from `OPENCLAW_BIN`, the install manifest, or `PATH` | path to the `openclaw` Node binary |
| `provider` | `"cerebras"` | provider prefix injected as `<provider>/<model>` when `model` has no slash |
| `model` | `"gpt-oss-120b"` | model id passed via `--model` |
| `api_key_env` | `"CEREBRAS_API_KEY"` | env var read for the OpenAI-compatible API key |
| `base_url` | `None` | loopback OpenAI-compatible gateway URL required by the native publication path |
| `base_url_env` | `"CEREBRAS_BASE_URL"` | env var read for the OpenAI-compatible base URL |
| `thinking_level` | `"medium"` | one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max` |
| `timeout_s` | `600.0` | seconds before the CLI subprocess is killed |
| `direct_openai_compatible` | `False` | non-publishable bypass used only by hermetic retry/parser tests |

`context={"session_id": "..."}` passes `--session-id` to the CLI;
`context={"agent_id": "..."}` passes `--agent`.

## Per-benchmark factories

| Factory | Returns | Used by |
|---|---|---|
| `build_clawbench_agent_fn` | async `(history, tools) -> dict` | ClawBench |
| `build_bfcl_agent_fn` | async `(prompt, tools) -> dict` with `name` + `arguments` | BFCL |
| `build_lifeops_bench_agent_fn` | async `(history, tools) -> MessageTurn` | LifeOpsBench |

## OpenClaw install

The benchmark harness expects OpenClaw at `~/.eliza/agents/openclaw/`. If you
already have it installed elsewhere, set `OPENCLAW_BIN=/path/to/openclaw`.
