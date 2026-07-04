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
| `mock-plugin.ts` | Deterministic mock benchmark plugin loaded when `ELIZA_BENCH_MOCK=true`. Diagnostic only; mock runs are not valid release evidence. |
| `sierra-style-fixtures.ts` | eliza-owned synthetic knowledge and voice-interruption fixture contracts inspired by Sierra tau-Knowledge / tau-Voice methodology, with no Sierra raw data. |
| `TESTING_PROTOCOL.md` | Benchmark action/testing protocol (required checks). |

The Python client side can live in a local adapter directory such as `benchmarks/eliza-adapter/`.

## Start the server

```bash
# from the eliza package root
npm run benchmark:server

# or directly
node --import tsx src/server.ts
```

The server prints `ELIZA_BENCH_READY port=<port>` when ready.

## Testing

```bash
# benchmark-focused unit tests
bunx vitest run --config vitest.config.ts

# watch a live benchmark smoke run end-to-end
bun run benchmark:watch

# see the full benchmark testing/checklist protocol
cat src/TESTING_PROTOCOL.md
```

## Sierra-Style Synthetic Fixtures

`sierra-style-fixtures.ts` defines two eliza-owned benchmark contracts:

- `createSierraStyleKnowledgeFixture()` returns a deterministic LifeWorld task
  where scoring is based on backend end state: a calendar event, draft email,
  and reminder must exist with exact target fields.
- `SIERRA_STYLE_VOICE_INTERRUPTION_FIXTURE` describes a synthetic voice task
  covering interruption recovery, background noise, dropped-frame windows,
  auth-code/email/name spelling, pass@1, and required report fields.

These fixtures borrow methodology shape only. They do not commit Sierra data,
and fixture smoke tests are not release-quality evidence. Publishable voice
results still need real model/voice runs with provider/model, STT/TTS/VAD
configuration, pass@1, recovery categories, and manually reviewed outputs.

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
| `COMPUTER_USE_ENABLED` | unset | Set to `1` to load local computeruse plugin |
| `ELIZA_BENCH_MOCK` | unset | Enables inline mock benchmark plugin |

## Notes

- `context` is attached to the prompt context for each benchmark step.
- Session reset creates isolated room/user context so task runs do not leak history.
- Responses include `actions` and `params` extracted from `responseContent` for runner-side evaluation.
