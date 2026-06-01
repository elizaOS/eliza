# eliza-adapter — Agent Guide

Python bridge that connects benchmark runners (Python) to the elizaOS agent
runtime (TypeScript) over HTTP. Not a standalone benchmark — imported as a
library by every benchmark that needs to talk to the eliza benchmark server.
Not registered in the orchestrator registry; consumers depend on it directly.

## Install (one-time)

```bash
pip install -e packages/benchmarks/eliza-adapter/
```

Or from within this directory:

```bash
pip install -e .
```

## Use as a library

```python
from eliza_adapter import ElizaServerManager

mgr = ElizaServerManager()
mgr.start()          # spawns node --import tsx packages/app-core/src/benchmark/server.ts
client = mgr.client  # ready-to-use ElizaClient (HTTP to localhost:3939)

resp = client.send_message("hello", context={"benchmark": "agentbench", "task_id": "1"})
print(resp.text, resp.params)

mgr.stop()
```

Or point `ElizaClient` at an already-running server:

```bash
# Start the TypeScript server manually (in the repo root)
node --import tsx packages/app-core/src/benchmark/server.ts
```

```python
from eliza_adapter import ElizaClient
client = ElizaClient("http://localhost:3939")
client.wait_until_ready()
```

## Smoke / mock mode

`run_osworld_mock.py` drives a single-turn OSWorld-style mock session using a
real server subprocess (requires Node.js and compiled TS dependencies):

```bash
python run_osworld_mock.py
```

To suppress API calls server-side, set `ELIZA_BENCH_MOCK=true` before starting
`ElizaServerManager` — the manager will blank all provider API keys in the
subprocess environment.

## Test the harness

```bash
pip install -e .
pytest packages/benchmarks/eliza-adapter/tests/ -v
```

Tests are pure-Python (no Node.js, no live server) — they monkeypatch HTTP and
subprocess calls.

## Layout

| Path | Role |
| --- | --- |
| `eliza_adapter/client.py` | `ElizaClient` — HTTP client for `/api/benchmark/*` endpoints; telemetry writer |
| `eliza_adapter/server_manager.py` | `ElizaServerManager` — spawns and manages the Node.js benchmark server subprocess |
| `eliza_adapter/agentbench.py` | AgentBench harness adapter |
| `eliza_adapter/context_bench.py` | context-bench LLM query adapter |
| `eliza_adapter/mind2web.py` | Mind2Web agent adapter |
| `eliza_adapter/tau_bench.py` | tau-bench agent adapter |
| `eliza_adapter/replay_eval.py` | Offline scorer for normalized Eliza replay artifacts |
| `eliza_adapter/vllm_provider.py` | vLLM provider bridge |
| `eliza_adapter/*.py` | One module per benchmark; loaded lazily or on-demand |
| `fixtures/replay/smoke.replay.json` | Fixture used by replay_eval tests |
| `run_osworld_mock.py` | Single-turn OSWorld mock smoke driver |
| `tests/` | pytest suite (pure-Python, no live server) |
| `conftest.py` | Adds `packages/benchmarks/` to `sys.path` for `benchmarks.*` imports |

## Notes

- The TypeScript server lives at `packages/app-core/src/benchmark/server.ts`.
  `ElizaServerManager` auto-locates it by walking up from `__file__`.
- Default port is `3939`; override with `ELIZA_BENCH_PORT`.
- `BENCHMARK_HARNESS` / `ELIZA_BENCH_HARNESS` routes `ElizaClient` through
  Hermes, Smithers, or OpenClaw backends instead of the eliza HTTP server.
- Per-turn telemetry writes to `BENCHMARK_TELEMETRY_JSONL` or
  `$BENCHMARK_RUN_DIR/telemetry.jsonl` (auto-fallback to a tmp dir).
- This package is not registered in `registry/commands.py`; no orchestrator
  `run_command` applies — see consumers in `agentbench/`, `context-bench/`,
  `mind2web/`, and `tau-bench/`.
- Full architecture: [README.md](README.md).
