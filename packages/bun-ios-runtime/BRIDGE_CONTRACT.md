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

int32_t eliza_bun_engine_start(
  const char *bundle_path,
  const char *argv_json,
  const char *env_json,
  const char *app_support_dir
);

int32_t eliza_bun_engine_stop(void);

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

The current `ios-bridge` implementation starts the existing API server on an
ephemeral loopback port inside the Bun process and proxies `http_request` to it.
That internal port is not exposed to the WebView. The next cleanup is to expose
the same backend as a direct fetch/Hono-style route kernel so the stdio bridge
can dispatch routes without even internal loopback.

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
