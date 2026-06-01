# openclaw-adapter — Agent Guide

Python bridge that wraps the [OpenClaw](https://docs.openclaw.ai/) CLI agent as
a drop-in replacement for `eliza-adapter` and `hermes-adapter`. Benchmarks import
factory functions from this package; the adapter spawns `openclaw agent --local
--json` once per turn and maps the JSON output into a `MessageResponse`. Not
registered in the suite registry — consumed as a library by other benchmarks.

## Run

This package is a library adapter, not a standalone benchmark runner. Import it
from a benchmark that supports the openclaw agent:

```python
from openclaw_adapter import OpenClawClient

client = OpenClawClient(provider="cerebras", model="gpt-oss-120b")
client.wait_until_ready(timeout=60)
print(client.send_message("Reply with the single word: PONG").text)
```

The underlying CLI invocation it produces:

```bash
openclaw agent --local --json \
    --model cerebras/gpt-oss-120b \
    --thinking medium \
    --timeout 600 \
    --message "Reply with the single word: PONG"
```

## Test the harness

```bash
# From the adapter directory (tests are fully mocked — no API keys needed)
pip install -e .
pytest packages/benchmarks/openclaw-adapter/tests/ -v

# Or from the benchmarks root
pytest openclaw-adapter/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `openclaw_adapter/client.py` | `OpenClawClient` — spawns `openclaw agent --local --json` per turn |
| `openclaw_adapter/server_manager.py` | `OpenClawCLIManager` — lifecycle (start = validate binary; stop = no-op) |
| `openclaw_adapter/clawbench.py` | `build_clawbench_agent_fn` — ClawBench factory |
| `openclaw_adapter/bfcl.py` | `build_bfcl_agent_fn` — function-call benchmark factory |
| `openclaw_adapter/lifeops_bench.py` | `build_lifeops_bench_agent_fn` — LifeOpsBench factory |
| `openclaw_adapter/swe_bench.py` | `build_swe_bench_agent_fn` — SWE-bench factory |
| `openclaw_adapter/terminal_bench.py` | `OpenClawTerminalAgent`, `build_terminal_bench_agent_fn` |
| `openclaw_adapter/_retry.py` | Shared retry logic |
| `tests/` | pytest suite (all subprocess calls mocked) |
| `pyproject.toml` | Package definition; `pip install -e .` to develop |

## Notes

- Binary resolution order: `OPENCLAW_BIN` env → `~/.eliza/agents/openclaw/manifest.json` → `~/.eliza/agents/openclaw/v2026.5.7/node_modules/.bin/openclaw`.
- Set `OPENCLAW_DIRECT_OPENAI_COMPAT=1` (or pass `direct_openai_compatible=True`) to bypass the CLI for hermetic testing or native function-call benchmarks.
- Set `OPENCLAW_USE_CLI=1` to force the production CLI path even when a direct path is also configured.
- Native function-call benchmarks (BFCL etc.) must use the direct OpenAI-compatible path; the CLI path flattens `messages`/`tools` into a single `--message` string.
- No results are written by this package — results are the responsibility of the benchmark that consumes it.
- Full background: [README.md](README.md).
