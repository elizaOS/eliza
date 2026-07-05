# @elizaos/plugin-worker-runtime

Compatibility package for the worker-side remote-plugin runtime. The implementation now lives in
`@elizaos/plugin-remote-manifest/worker-runtime`; this package keeps the historical
`@elizaos/plugin-worker-runtime` imports working.

## Purpose / role

This package is a thin wrapper around the **in-worker half** of the remote-plugin execution model in
`packages/plugin-remote-manifest/src/worker-runtime/`. A plugin author writes a normal elizaOS
`Plugin` object, then calls `bootstrap(plugin)` inside a Bun Worker or subprocess. The bootstrap
walks every surface (`actions`, `providers`, `services`, `models`, `events`, `evaluators`, `routes`),
serialises all functions as `{ rpc: true, id }` refs in a JSON descriptor, sends that descriptor to
the host, and then enters steady-state dispatch mode.

The complementary host-side runner lives in `packages/agent/src/services/remote-plugin-bridge.ts`. That file imports `@elizaos/plugin-remote-manifest/worker-runtime/error` for error rehydration.

The wire message types, worker runtime implementation, and consolidated exports are defined in
`@elizaos/plugin-remote-manifest`. Security primitives (HMAC verification, audit dispatch) come from
`@elizaos/security`.

## Layout

```
src/
  index.ts/runtime-proxy.ts/bootstrap.ts/... Compatibility re-exports from
    `@elizaos/plugin-remote-manifest/worker-runtime*`

packages/plugin-remote-manifest/src/worker-runtime/
  index.ts           Re-exports all public symbols; serves as the "." export
  bootstrap.ts       bootstrap() — the author-facing entrypoint
  descriptor.ts      buildAnnounceDescriptor(), HandlerRegistry, WorkerPluginShape
  dispatch.ts        createWorkerRpcDispatcher() — routes worker-rpc to live handlers
  envelope.ts        WorkerChannel contract + createWorkerChannel / createSubprocessChannel
  runtime-proxy.ts   RuntimeProxy class + buildRuntimeProxyApi() + SUPPORTED_RUNTIME_METHODS
  error.ts           toWireError / fromWireError / WireError — error serialisation
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
