# openclaw-adapter — Agent Guide

Python bridge that runs benchmark turns through OpenClaw's embedded agent and
native plugin loop. Benchmarks import this package through the shared
`ElizaClient` surface; each turn gets an isolated OpenClaw state directory and
a generated plugin exposing only that turn's benchmark tools. The adapter is a
library, not a standalone registry benchmark.

## Run

This package is a library adapter, not a standalone benchmark runner. Import it
from a benchmark that supports the openclaw agent:

```python
from openclaw_adapter import OpenClawClient

client = OpenClawClient(
    provider="claude-subscription",
    model="claude-opus-4-6",
    base_url="http://127.0.0.1:43123/v1",
    api_key="ephemeral-gateway-token",
)
client.wait_until_ready(timeout=60)
print(client.send_message("Reply with the single word: PONG").text)
```

The underlying embedded-runtime invocation is equivalent to:

```bash
openclaw agent --local --json --agent benchmark \
    --model eliza-benchmark-gateway/claude-opus-4-6 \
    --thinking medium \
    --timeout 600 \
    --message "Reply with the single word: PONG"
```

## Test the harness

```bash
# From the adapter directory (unit tests need no provider credentials)
pip install -e .
pytest tests/ -v

# Installed-runtime contract: real OpenClaw + generated plugin, local model stub
OPENCLAW_E2E_BIN=/path/to/openclaw pytest tests/test_native_openclaw_e2e.py -v

# Or from the benchmarks root
pytest harnesses/openclaw/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `openclaw_adapter/client.py` | `OpenClawClient` — orchestrates one isolated embedded-runtime turn |
| `openclaw_adapter/native_runtime.py` | Isolated config and generated native benchmark-tool plugin |
| `openclaw_adapter/server_manager.py` | `OpenClawCLIManager` — lifecycle (start = validate binary; stop = clear started state) |
| `openclaw_adapter/clawbench.py` | `build_clawbench_agent_fn` — ClawBench factory |
| `openclaw_adapter/bfcl.py` | `build_bfcl_agent_fn` — function-call benchmark factory |
| `openclaw_adapter/lifeops_bench.py` | `build_lifeops_bench_agent_fn` — LifeOpsBench factory |
| `openclaw_adapter/swe_bench.py` | `build_swe_bench_agent_fn` — SWE-bench factory |
| `openclaw_adapter/terminal_bench.py` | `OpenClawTerminalAgent`, `build_terminal_bench_agent_fn` |
| `openclaw_adapter/_retry.py` | Shared retry logic |
| `tests/` | Offline unit coverage plus an opt-in installed-runtime/local-stub contract |
| `pyproject.toml` | Package definition; `pip install -e .` to develop |

## Notes

- Binary resolution order: `OPENCLAW_BIN` env → `~/.eliza/agents/openclaw/manifest.json` → an `openclaw` on `PATH` → the packaged fallback.
- Publishable runs require a loopback completion gateway. The generated config rejects remote base URLs and references the bearer token by env var rather than persisting it.
- `OPENCLAW_DIRECT_OPENAI_COMPAT=1` and `direct_openai_compatible=True` exist only for parser/retry tests. Their telemetry sets `publishable_native=false`, so the orchestrator quarantines those results.
- Full message history is canonicalized into the isolated turn prompt. Benchmark tools remain structured native plugin tools and only plugin-captured executions become scored tool calls.
- The bridge never executes tools. Callers whose env executes captured calls itself (e.g. the hermes-native env proxy, one chat-completions step per turn) declare `context["capture_stop"] = True`: the embedded loop then ends after the first captured tool batch instead of iterating on placeholder acknowledgements (one billed completion per fake round). Default off — ack-loop benchmarks (orchestrator lifecycle) score reply text written after the ack.
- Provenance records identify `openclaw.agent.embedded`, the generated config hash, native plugin bridge, model, provider, and transport on every turn.
- No results are written by this package — results are the responsibility of the benchmark that consumes it.
- Full background: [README.md](README.md).

