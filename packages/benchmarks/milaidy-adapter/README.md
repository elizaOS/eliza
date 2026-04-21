# milady-adapter

Python bridge that connects benchmark runners to the TypeScript [milady](../../milady/) agent via HTTP.

## Architecture

```
Python Benchmark Runner
    |  (imports adapter)
milady-adapter  (this package)
    |  (HTTP requests)
Milady Benchmark Server  (TypeScript / Node.js)
    |  (runs agent)
ElizaOS AgentRuntime
```

The **server side** lives in the milady repo at [`src/benchmark/`](../../milady/src/benchmark/):

- `server.ts` -- lightweight HTTP server wrapping the full agent runtime
- `plugin.ts` -- provider + action that inject task context and capture agent decisions

This package provides the **client side**: an HTTP client, subprocess manager, and benchmark-specific adapters.

## Modules

| Module | Purpose |
|---|---|
| `client.py` | `MiladyClient` -- HTTP client for `/api/benchmark/*` endpoints |
| `server_manager.py` | `MiladyServerManager` -- spawns and manages the Node.js benchmark server subprocess |
| `agentbench.py` | AgentBench harness adapter |
| `context_bench.py` | context-bench LLM query adapter |
| `mind2web.py` | Mind2Web agent adapter |
| `tau_bench.py` | tau-bench agent adapter |
| `replay_eval.py` | Offline scorer for normalized Milady replay artifacts |

## Quick start

```python
from milady_adapter import MiladyServerManager

mgr = MiladyServerManager()
mgr.start()          # spawns the TS server, waits until healthy
client = mgr.client  # ready-to-use MiladyClient

# send a benchmark message
resp = client.send_message("hello", context={"benchmark": "agentbench", "taskId": "1"})
print(resp.text, resp.params)

mgr.stop()
```

Or start the server manually and point the client at it:

```bash
# in the milady repo root
npm run benchmark:server
# or: node --import tsx src/benchmark/server.ts
```

```python
from milady_adapter import MiladyClient

client = MiladyClient("http://localhost:3939")
client.wait_until_ready()
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `MILADY_BENCH_PORT` | `3939` | Port the benchmark server listens on |

The server auto-detects model provider plugins from API key env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).

## Used by

- [`benchmarks/agentbench/`](../agentbench/) -- `run_benchmark.py`
- [`benchmarks/context-bench/`](../context-bench/) -- `run_benchmark.py`
- [`benchmarks/mind2web/`](../mind2web/) -- `runner.py`
- [`benchmarks/tau-bench/`](../tau-bench/) -- `elizaos_tau_bench/runner.py`

## Server-side reference

The TypeScript benchmark server and plugin that this adapter communicates with are maintained in the milady package:

- **Server:** [`milady/src/benchmark/server.ts`](../../milady/src/benchmark/server.ts)
- **Plugin:** [`milady/src/benchmark/plugin.ts`](../../milady/src/benchmark/plugin.ts)
- **npm script:** `npm run benchmark:server` (in the milady package)

See the [benchmark server README](../../milady/src/benchmark/README.md) for endpoint documentation and plugin details.
