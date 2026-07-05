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
`stop()` clears the manager's local started state for interface compatibility.

For hermetic adapter tests and lightweight smoke checks, `OpenClawClient` also
supports a direct OpenAI-compatible path when constructed with
`direct_openai_compatible=True` or when `OPENCLAW_DIRECT_OPENAI_COMPAT=1` is
set. `base_url=...` by itself only configures the CLI environment. Set
`OPENCLAW_USE_CLI=1` to force the production CLI path (it overrides
`OPENCLAW_DIRECT_OPENAI_COMPAT`).

The CLI path accepts a flattened `--message` string; benchmark `messages` and
`tools` are not preserved as OpenAI chat/tool payloads — instead the real
`openclaw agent` tool-loop discovers world state through its own tool calls
(the LifeOpsBench factory relies on this). The direct-compat path is the one
to use only when you specifically need to send a pre-built OpenAI
`messages`/`tools` payload verbatim (e.g. BFCL native function-call rows).

## CLI-native provider registration (Cerebras / gpt-oss-120b)

The `openclaw` CLI does **not** hard-reject `gpt-oss-120b`. The
`FailoverError: Unknown model` (older revisions of this README implied this was
a wall) only means the model is absent from the built-in catalog — which
OpenClaw resolves through **custom OpenAI-compatible provider registration**
(`models.providers.<id>` with `baseUrl` + `api: openai-completions` + a
`models[]` entry). The error message itself points at
[`docs.openclaw.ai/concepts/model-providers`](https://docs.openclaw.ai/concepts/model-providers);
this is documented, not a dead end.

Register the provider into an **isolated benchmark profile** so a developer's
real `~/.openclaw/openclaw.json` is never touched, then point the adapter at
it:

```bash
# 1. Apply the committed key-free config into an isolated profile.
openclaw --profile bench-cerebras config patch \
    --file packages/benchmarks/openclaw-adapter/config/cerebras.openclaw.json5

# 2. Verify the model now resolves (no FailoverError).
openclaw --profile bench-cerebras models list --provider cerebras
#   cerebras/gpt-oss-120b   text   125k   no   yes   default

# 3. Point the adapter's spawned CLI at that profile via env + force CLI mode.
export CEREBRAS_API_KEY=...            # never printed/committed; a SecretRef
export OPENAI_API_KEY="$CEREBRAS_API_KEY"
export OPENAI_BASE_URL="https://api.cerebras.ai/v1"
export OPENCLAW_CONFIG_PATH="$HOME/.openclaw-bench-cerebras/openclaw.json"
export OPENCLAW_STATE_DIR="$HOME/.openclaw-bench-cerebras"
export OPENCLAW_USE_CLI=1
```

`--profile bench-cerebras` and the `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR`
env pair are equivalent — the adapter's `OpenClawClient` has no `--profile`
flag, so the env pair is how the isolated config reaches the spawned CLI. With
this in place, `openclaw agent --local --json --model cerebras/gpt-oss-120b`
runs a genuine CLI-native turn (real `provider-transport-fetch` POST to
`https://api.cerebras.ai/v1/chat/completions`, `status=200`, `reasoningTokens`
populated). See `config/cerebras.openclaw.json5` for the exact, key-free config
and `.github/issue-evidence/13777-multitask-live/openclaw-cli-native/` for the
live transcript.

The one catalog nuance: set `reasoning: true` on the model entry, else OpenClaw
gates the model to `--thinking off` only (the adapter defaults to
`--thinking medium`).

### CLI-native runs, but does not *score* on tool-execution benchmarks

Provider registration makes the CLI path fully live — but the `openclaw agent`
command **owns its own tool execution** and returns natural-language
`payloads`. It has no mode to accept a benchmark-injected tool catalog and hand
back *unexecuted* structured `tool_calls` for the harness to run against a
benchmark-owned world (LifeWorld). On the CLI path the benchmark tools are
flattened into `--message` as context-only, so the model emits its intended
call as **JSON text inside the assistant message** rather than a structured
`tool_calls` array, and multi-turn scenarios hit `Context overflow` from
re-flattening the whole conversation. The multitask-bench openclaw lane run
CLI-native therefore completes every task but scores `mean_score=0.000`
(`turns=1`, `tokens=0`) — see the N=1 report + trajectory in the evidence dir.

**Consequence:** for tool-execution benchmarks (LifeOpsBench, BFCL native
function-call), the **direct OpenAI-compatible path is the transport that
yields the structured `tool_calls` the scorer executes**, and it stays
disclosed as *partial*. This is an architectural boundary of the CLI as of
`2026.6.11`, not a config gap. The `FailoverError: Unknown model` / "custom
registration is undocumented" story is what was wrong (busted above); the
scoring limitation is real and is what the "partial" label durably denotes.

## Layout

```
openclaw_adapter/
  __init__.py          re-exports OpenClawClient, OpenClawCLIManager, MessageResponse
  client.py            OpenClawClient — spawns `openclaw agent --local --json` per turn
  server_manager.py    OpenClawCLIManager — lifecycle (start = validate binary; stop = clear started state)
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
| `binary_path` | resolved from `OPENCLAW_BIN` env, `~/.eliza/agents/openclaw/manifest.json`, an `openclaw` on `PATH`, or `~/.eliza/agents/openclaw/v2026.5.7/node_modules/.bin/openclaw` | path to the `openclaw` Node binary |
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
