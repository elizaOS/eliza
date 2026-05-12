# Eliza Bun Engine iOS Contract

This is the contract between the iOS Capacitor host and the full Bun engine
framework produced from an iOS-capable Bun fork.

The framework is not a helper executable. iOS local mode must run the backend in
process from a signed framework inside the app bundle. The WebView talks to the
backend through Capacitor/native IPC, not by opening a TCP connection to a
backend port.

## Framework

Expected bundle:

```text
ElizaBunEngine.xcframework
```

Expected binary inside each slice:

```text
ElizaBunEngine.framework/ElizaBunEngine
```

The app loads the framework with `dlopen` and resolves the symbols below with
`dlsym`.

## ABI

All strings are UTF-8. JSON inputs are UTF-8 JSON strings. Functions return
zero on success unless otherwise stated.

```c
const char *eliza_bun_engine_abi_version(void);

const char *eliza_bun_engine_last_error(void);

typedef char *(*eliza_bun_engine_host_call_callback)(
  const char *method,
  const char *payload_json,
  int32_t timeout_ms
);

int32_t eliza_bun_engine_set_host_callback(
  eliza_bun_engine_host_call_callback callback
);

int32_t eliza_bun_engine_start(
  const char *bundle_path,
  const char *argv_json,
  const char *env_json,
  const char *app_support_dir
);

int32_t eliza_bun_engine_stop(void);

int32_t eliza_bun_engine_is_running(void);

char *eliza_bun_engine_call(
  const char *method,
  const char *payload_json
);

void eliza_bun_engine_free(void *ptr);
```

`eliza_bun_engine_start` boots Bun and runs the staged backend bundle,
normally:

```text
public/agent/agent-bundle.js ios-bridge --stdio
```

`eliza_bun_engine_call` is the UI/backend IPC entrypoint. Calls return JSON
objects with this envelope:

```json
{ "ok": true, "result": {} }
```

Error payloads must use this shape:

```json
{ "ok": false, "error": "message" }
```

The shim included in this package implements that envelope over newline
delimited JSON on stdio:

```json
{ "id": 1, "method": "http_request", "payload": {} }
{ "id": 1, "ok": true, "result": {} }
```

Bun can call back into native code over the same stdio protocol while a host
request is in flight. This is how full-Bun local inference reaches the linked
llama.cpp bridge without opening a WebSocket or TCP port:

```json
{ "type": "host_call", "id": "host-1", "method": "llama_generate", "payload": {}, "timeoutMs": 120000 }
{ "type": "host_result", "id": "host-1", "envelope": { "ok": true, "result": {} } }
```

Required native host-call methods today:

- `llama_hardware_info`
- `llama_load_model`
- `llama_generate`
- `llama_free`
- `llama_cancel`

Required methods today:

- `status` -> `{ "ready": true, "apiPort": number }`
- `http_request` / `http_fetch` with `{ method, path, headers, body,
  timeoutMs }` -> `{ status, statusText, headers, body }`
- `send_message` with `{ message, conversationId? }` -> `{ reply, text,
  conversationId, response }`

`path` must be a local path beginning with `/`; absolute URLs are rejected at
the Swift, C, and JS bridge layers.

## Required backend behavior

The full engine must support:

- `Bun.serve` or an equivalent Hono/fetch-compatible route kernel.
- `fetch`, `Request`, `Response`, `Headers`, streams, and buffered bodies.
- `Bun.file`, `node:fs`, `node:path`, `node:crypto`, `node:buffer`, and
  package/module resolution needed by `packages/agent/dist-mobile-ios`.
- PGlite WASM assets staged next to `agent-bundle.js`.
- The existing llama bridge surface for local inference.
- Enough Node stream/stdin/stdout compatibility for `ios-bridge --stdio`.

The current `ios-bridge` dispatches high-traffic foreground routes in process,
buffers legacy local-inference HTTP handlers when needed, and serves native
llama status/generation through Bun host-call IPC. It must not start an
internal HTTP server for iOS full-Bun local mode.

## Validation gates

The port is complete only when all of these pass:

1. `bun run --cwd packages/bun-ios-runtime build:sim` produces an
   `ElizaBunEngine.xcframework` with an iOS Simulator slice.
2. `ELIZA_IOS_FULL_BUN_ENGINE=1 bun run --cwd packages/app build:ios:local:sim`
   builds, installs, and launches in Simulator.
3. `bun run --cwd packages/bun-ios-runtime smoke:sim` boots
   `public/agent/agent-bundle.js ios-bridge --stdio` through the full engine
   ABI and invokes `status`, `http_request`, and `send_message`.
4. The same sequence passes for `build:device` on a developer-signed sideload.
