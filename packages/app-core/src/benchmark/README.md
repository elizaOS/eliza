# Eliza Benchmark Server

HTTP bridge exposing the Eliza runtime to Python benchmark runners.

## Architecture

```
Python Benchmark Runner
    |  (imports eliza-adapter)
eliza-adapter (Python client)
    |  (HTTP requests)
server.ts (this directory)
    |  (canonical message pipeline)
elizaOS AgentRuntime
```

This directory contains:

| File | Purpose |
|---|---|
| `server.ts` | HTTP server for benchmark traffic. Initializes `AgentRuntime`, handles benchmark sessions, and routes each message through `runtime.messageService.handleMessage(...)`. |
| `mock-plugin-base.ts` | Tracked deterministic mock plugin used by benchmark unit tests and CI smoke checks. |
| `mock-plugin.ts` | Optional local override (gitignored) loaded first when `ELIZA_BENCH_MOCK=true`. |
| `TESTING_PROTOCOL.md` | Benchmark action/testing protocol (required checks + CUA-bench compatibility commands). |

The Python client side can live in a local adapter directory such as `benchmarks/eliza-adapter/`.

## Start the server

```bash
# from the eliza package root
npm run benchmark:server

# or directly
node --import tsx src/benchmark/server.ts
```

The server prints `ELIZA_BENCH_READY port=<port>` when ready.

## Testing

```bash
# benchmark-focused unit tests
bunx vitest run src/benchmark/*.test.ts

# watch a live benchmark smoke run end-to-end
bun run benchmark:watch

# watch live CUA execution in LUME VM (requires CUA_HOST + model credentials)
CUA_HOST=localhost:8000 OPENAI_API_KEY=sk-... CUA_COMPUTER_USE_MODEL=computer-use-preview bun run benchmark:cua:watch

# see the full benchmark testing/checklist protocol
cat src/benchmark/TESTING_PROTOCOL.md
```

## HTTP API

### `GET /api/benchmark/health`

Returns readiness + runtime metadata.

```json
{ "status": "ready", "agent_name": "Kira", "plugins": 3 }
```

### `POST /api/benchmark/reset`

Starts a fresh benchmark session (new room/user context).

Request:

```json
{ "task_id": "webshop-42", "benchmark": "agentbench" }
```

Response:

```json
{ "status": "ok", "room_id": "<uuid>", "task_id": "webshop-42", "benchmark": "agentbench" }
```

### `GET /api/benchmark/cua/status`

Returns CUA service status when CUA benchmark mode is enabled (`ELIZA_ENABLE_CUA=1`).

### `POST /api/benchmark/cua/run`

Runs a live CUA task in the configured LUME/cloud sandbox.

Request:

```json
{
  "goal": "Open ChatGPT and close extra tabs",
  "room_id": "optional-room-id",
  "auto_approve": true,
  "include_screenshots": false
}
```

### `GET /api/benchmark/cua/screenshot`

Captures the current sandbox screenshot (`base64 png`) via the CUA service.

### `POST /api/benchmark/message`

Sends benchmark input through the canonical message pipeline.

Request:

```json
{
  "text": "Find a laptop under $500",
  "context": {
    "benchmark": "agentbench",
    "task_id": "webshop-42",
    "goal": "Buy a laptop under $500",
    "observation": { "page": "search results" },
    "action_space": ["search[query]", "click[id]", "buy[id]"]
  }
}
```

Response:

```json
{
  "text": "Searching for options under $500...",
  "thought": "I should issue a search action first",
  "actions": ["BENCHMARK_ACTION"],
  "params": { "command": "search[laptop under $500]" }
}
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `ELIZA_BENCH_PORT` | `3939` | Port to listen on |
| `ELIZA_ENABLE_COMPUTERUSE` | unset | If set, loads local computeruse plugin |
| `ELIZA_ENABLE_CUA` | unset | If set (or CUA env is configured), loads `@elizaos/plugin-cua` |
| `CUA_HOST` | unset | Local CUA/LUME host (e.g. `localhost:8000`) |
| `CUA_API_KEY` + `CUA_SANDBOX_NAME` | unset | Cloud CUA mode alternative to `CUA_HOST` |
| `CUA_COMPUTER_USE_MODEL` | `auto` | Set `computer-use-preview` to force OpenAI computer-use runner |
| `ELIZA_BENCH_MOCK` | unset | Enables inline mock benchmark plugin |

## Notes

- `context` is attached to the prompt context for each benchmark step.
- Session reset creates isolated room/user context so task runs do not leak history.
- Responses include `actions` and `params` extracted from `responseContent` for runner-side evaluation.
