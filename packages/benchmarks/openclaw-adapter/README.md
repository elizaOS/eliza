# openclaw-adapter

Python bridge that connects benchmark runners to the [OpenClaw](https://docs.openclaw.ai/)
CLI agent. Drop-in equivalent of the `eliza-adapter` / `hermes-adapter` API
surfaces, swapping the eliza TypeScript bench server for one-shot
`openclaw agent --local --json` invocations.

## Architecture

```
Python Benchmark Runner
    |  (imports adapter)
openclaw-adapter  (this package)
    |  (subprocess.run per turn)
openclaw agent --local --json --message <text>
    |  (OpenAI-compatible HTTPS call)
Cerebras / OpenAI / other provider
```

OpenClaw is a one-shot CLI per turn — there is no long-running daemon to
manage. The `OpenClawCLIManager` is intentionally thin: `start()` validates
the binary exists and warms up the Node compile cache by running `--version`;
`stop()` is a no-op.

For hermetic adapter tests and lightweight smoke checks, `OpenClawClient` also
supports a direct OpenAI-compatible path when constructed with
`direct_openai_compatible=True` or when `OPENCLAW_DIRECT_OPENAI_COMPAT=1` is
set. `base_url=...` by itself only configures the CLI environment. Set
`OPENCLAW_USE_CLI=1` to force the production CLI path.

## Layout

```
openclaw_adapter/
  __init__.py          re-exports OpenClawClient, OpenClawCLIManager, MessageResponse
  client.py            OpenClawClient — spawns `openclaw agent --local --json` per turn
  server_manager.py    OpenClawCLIManager — lifecycle (start = validate binary; stop = no-op)
  clawbench.py         build_clawbench_agent_fn — runs an openclaw scenario via CLI
  bfcl.py              build_bfcl_agent_fn — function-call-style benchmark factory
  lifeops_bench.py     build_lifeops_bench_agent_fn — LifeOpsBench compatible
```

## Quick example

```python
from openclaw_adapter import OpenClawClient

client = OpenClawClient(
    provider="openai",                # Cerebras routes via OpenAI-compatible provider
    model="gpt-oss-120b",
    api_key_env="CEREBRAS_API_KEY",   # which env var holds the key
    base_url_env="CEREBRAS_BASE_URL", # which env var holds the base URL
    thinking_level="medium",
)
client.wait_until_ready(timeout=60)
print(client.send_message("Reply with the single word: PONG").text)
```

The client spawns:

```bash
openclaw agent --local --json \
    --model openai/gpt-oss-120b \
    --thinking medium \
    --timeout 600 \
    --message "Reply with the single word: PONG"
```

…with `CEREBRAS_API_KEY` / `CEREBRAS_BASE_URL` mirrored into
`OPENAI_API_KEY` / `OPENAI_BASE_URL` so OpenClaw's provider routing works
regardless of which env var the operator set.

## Configuration

| Constructor arg | Default | Description |
|---|---|---|
| `binary_path` | resolved from `OPENCLAW_BIN` env, `~/.eliza/agents/openclaw/manifest.json`, or `~/.eliza/agents/openclaw/v2026.5.7/node_modules/.bin/openclaw` | path to the `openclaw` Node binary |
| `provider` | `"cerebras"` | provider prefix injected as `<provider>/<model>` when `model` has no slash |
| `model` | `"gpt-oss-120b"` | model id passed via `--model` |
| `api_key_env` | `"CEREBRAS_API_KEY"` | env var read for the OpenAI-compatible API key |
| `base_url` | `None` | optional OpenAI-compatible base URL mirrored into CLI env |
| `base_url_env` | `"CEREBRAS_BASE_URL"` | env var read for the OpenAI-compatible base URL |
| `thinking_level` | `"medium"` | one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max` |
| `timeout_s` | `600.0` | seconds before the CLI subprocess is killed |
| `direct_openai_compatible` | `False` | bypass the CLI for hermetic retry/parser tests |

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
