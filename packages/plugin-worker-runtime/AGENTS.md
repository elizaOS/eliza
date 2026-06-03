# @elizaos/plugin-worker-runtime

Worker-side bootstrap for remote-mode elizaOS plugins: announces plugin surfaces over the wire, dispatches incoming `worker-rpc` invocations, and marshals runtime calls back to the host via `RuntimeProxy`.

## Purpose / role

This package is the **in-worker half** of the remote-plugin execution model. A plugin author writes a normal elizaOS `Plugin` object, then calls `bootstrap(plugin)` inside a Bun Worker or subprocess. The bootstrap walks every surface (`actions`, `providers`, `services`, `models`, `events`, `evaluators`, `routes`), serialises all functions as `{ rpc: true, id }` refs in a JSON descriptor, sends that descriptor to the host, and then enters steady-state dispatch mode.

The complementary host-side runner lives in `packages/agent/src/services/remote-plugin-bridge.ts`. That file imports `@elizaos/plugin-worker-runtime/error` for error rehydration.

The wire message types are defined in `@elizaos/plugin-remote-manifest`. Security primitives (HMAC verification, audit dispatch) come from `@elizaos/security`.

## Layout

```
src/
  index.ts           Re-exports all public symbols; serves as the "." export
  bootstrap.ts       bootstrap() — the author-facing entrypoint
  descriptor.ts      buildAnnounceDescriptor(), HandlerRegistry, WorkerPluginShape
  dispatch.ts        createWorkerRpcDispatcher() — routes worker-rpc to live handlers
  envelope.ts        WorkerChannel contract + createWorkerChannel / createSubprocessChannel
                       / createDefaultChannel / createRequestIdAllocator
  runtime-proxy.ts   RuntimeProxy class + buildRuntimeProxyApi() + SUPPORTED_RUNTIME_METHODS
  error.ts           toWireError / fromWireError / WireError — error serialisation
  dispatch.test.ts   Unit tests for the dispatcher
```

### Export subpaths

| Import path                               | What you get                                      |
|-------------------------------------------|---------------------------------------------------|
| `@elizaos/plugin-worker-runtime`          | Everything — all public types and functions       |
| `@elizaos/plugin-worker-runtime/bootstrap`| `bootstrap`, `BootstrapOptions` only              |
| `@elizaos/plugin-worker-runtime/runtime-proxy` | `RuntimeProxy`, `buildRuntimeProxyApi`, etc. |
| `@elizaos/plugin-worker-runtime/error`    | `toWireError`, `fromWireError`, `WireError`       |

## Key exports

### `bootstrap(plugin, options?)` — `src/bootstrap.ts`

The primary author-facing API.

```ts
import { bootstrap } from "@elizaos/plugin-worker-runtime";
import { myPlugin } from "./plugin";
bootstrap(myPlugin);
```

1. Creates (or accepts) a `WorkerChannel` transport.
2. Instantiates `RuntimeProxy` and wires it to the channel.
3. Calls `buildAnnounceDescriptor(plugin, registry)` and sends `worker-announce-plugin`.
4. Snapshots declared plugin surfaces, then calls `plugin.init(config, runtimeApi)` if present.
5. If `init()` appended new surfaces to the plugin object, sends a `worker-announce-dynamic` descriptor for just those additions.
6. Sends `init-complete`; the worker is now in dispatch mode.

**`BootstrapOptions`:**
- `channel?: WorkerChannel` — override transport (default: auto-detect Worker vs stdio).
- `runtimeRpcTimeoutMs?: number` — timeout for each host-rpc round-trip.
- `initConfig?: Record<string, string>` — forwarded to `plugin.init`.

### `WorkerChannel` — `src/envelope.ts`

Transport contract: `send(msg)`, `onMessage(handler) → unsubscribe`, `close()`.

- `createWorkerChannel()` — Bun Worker `postMessage`/`addEventListener`.
- `createSubprocessChannel()` — newline-delimited JSON over `process.stdin`/`process.stdout`.
- `createDefaultChannel()` — auto-selects based on `ELIZA_REMOTE_PLUGIN_CHANNEL=stdio`.

### `RuntimeProxy` / `buildRuntimeProxyApi()` — `src/runtime-proxy.ts`

What plugin handlers receive as their `runtime` argument. Each method issues a `host-rpc` message and awaits `host-rpc-result`.

**Supported methods (`SUPPORTED_RUNTIME_METHODS`):**
`getService`, `useModel`, `getMemory`, `createMemory`, `updateMemory`, `emitEvent`, `getSetting`, `setSetting`, `composeState`.

`runtime.registerEvent()` cannot serialize a live callback over host-RPC. Declare event handlers statically on the `Plugin.events` object so bootstrap can announce stable RPC handler ids.

### `buildAnnounceDescriptor(plugin, registry)` — `src/descriptor.ts`

Walks the plugin surfaces and replaces every function with `{ rpc: true, id: "<surface>:<target>:<n>" }`. The live function is stored in the `HandlerRegistry` under that id. The host uses the id as `target` in subsequent `worker-rpc` messages.

**`WorkerPluginShape`** is the loose plugin type the bootstrap accepts (no hard dependency on `@elizaos/core` internals).

**`RemoteServiceClass`** is the shape a service must expose:
- `serviceType: string` — key for `runtime.getService()`.
- `rpcMethods: readonly string[]` — explicit allowlist; only these methods are host-reachable.
- `start(runtime): Promise<RemoteServiceInstance>` — factory; lazy-called on first method invocation.

### `createWorkerRpcDispatcher()` — `src/dispatch.ts`

Routes incoming `worker-rpc` messages to registered handlers by surface kind:

| Surface       | Handler signature                                          |
|---------------|------------------------------------------------------------|
| `action`      | `(runtime, message, state, options, callback, responses)`  |
| `provider`    | `(runtime, message, state)`                                |
| `evaluator`   | `(runtime, message, state)`                                |
| `model`       | `(runtime, params)`                                        |
| `event`       | `(payload)`                                                |
| `route`       | `(ctx)`                                                    |
| `service`     | trampolined via `RemoteServiceClass.start` then method call|

**Security hooks in `DispatchContext`:**
- `rpcAuth?: { kms, keyId }` — SOC2 A-4: HMAC-verify every inbound `worker-rpc` via `canonicalRpcBytes` from `@elizaos/plugin-remote-manifest/rpc-mac`. Messages without a valid MAC are rejected.
- `permissions?: { granted, pluginId, auditDispatcher? }` — SOC2 A-5: gate surface invocations against `RemotePluginPermissionGrant`; emits a `plugin.denied` audit event on denial.

### `toWireError` / `fromWireError` — `src/error.ts`

Serialise and rehydrate `Error` objects across the worker boundary. The rehydrated error preserves remote stack frames with a clearly-labelled boundary frame.

## Commands

```bash
bun run --cwd packages/plugin-worker-runtime build        # tsc --noCheck
bun run --cwd packages/plugin-worker-runtime typecheck    # tsgo --noEmit
bun run --cwd packages/plugin-worker-runtime test         # bun test src/
bun run --cwd packages/plugin-worker-runtime lint         # biome check
bun run --cwd packages/plugin-worker-runtime lint:fix     # biome check --write
bun run --cwd packages/plugin-worker-runtime clean        # rm -rf dist
```

## Config / env vars

| Variable                         | Where used                  | Effect                                              |
|----------------------------------|-----------------------------|-----------------------------------------------------|
| `ELIZA_REMOTE_PLUGIN_CHANNEL`    | `createDefaultChannel()`    | Set to `"stdio"` to use newline-delimited JSON over stdin/stdout instead of Bun Worker postMessage |

No runtime env vars are read for auth or permissions — those are injected by the host via `DispatchContext`.

## How to extend

### Add a new runtime proxy method

1. Add the method name to `SUPPORTED_RUNTIME_METHODS` in `src/runtime-proxy.ts`.
2. Add the typed method signature to `RuntimeProxyApi`.
3. Implement the method in `buildRuntimeProxyApi()` calling `proxy.call(methodName, args)`.
4. The host-side must handle the new `method` in its `host-rpc` router.

### Add a new surface kind

1. Add the surface name to the `PluginSurfaceKind` union in `@elizaos/plugin-remote-manifest`.
2. Add the surface field to `WorkerPluginShape` in `src/descriptor.ts`.
3. Add a mapping branch in `buildAnnounceDescriptor()`.
4. Add a `case` in `invokeBySurface()` in `src/dispatch.ts` with the correct handler shape.
5. Add a permission mapping in `checkPermission()` if the surface requires a gate.

### Add a new transport

Implement `WorkerChannel` in `src/envelope.ts` (or a separate file), export it, and pass it as `options.channel` to `bootstrap()`.

## Conventions / gotchas

- **Init-time dynamic surfaces are supported.** `bootstrap()` announces the static surfaces first, then snapshots any plugin surfaces appended by `init()` and sends them as `worker-announce-dynamic` before `init-complete`. Later runtime mutation after `bootstrap()` completes is still not announced.
- **Action callbacks are proxied.** If the host provides an action callback, the bridge assigns a callback id and routes worker callback payloads back over `worker-action-callback`.
- **Service instances are lazy and per-worker.** The `serviceInstances` WeakMap in `descriptor.ts` caches the `Promise<RemoteServiceInstance>` for each `RemoteServiceClass`. The first host invocation of any method on a service triggers `service.start(runtime)`. Subsequent calls reuse the cached instance for the worker's lifetime.
- **Remote event registration is static.** Calling `runtime.registerEvent` inside a remote handler throws because function callbacks cannot cross host-RPC. Declare event handlers in the static `Plugin.events` object.
- **`"tests"` surface is not host-RPC reachable.** The dispatcher explicitly rejects it with a clear error.
- **HMAC auth is opt-in.** Pass `rpcAuth` in `DispatchContext` to require MAC verification; omitting it disables the check entirely (appropriate for local workers).
