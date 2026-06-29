# @elizaos/plugin-worker-runtime

Compatibility package for the worker-side bootstrap used by remote-mode elizaOS plugins.

## What it is

Remote-mode elizaOS plugins run in isolation - inside a Bun Worker thread or a separate subprocess - rather than in the main agent process. The implementation now lives in `@elizaos/plugin-remote-manifest/worker-runtime`; this package keeps the historical `@elizaos/plugin-worker-runtime` imports working.

The worker runtime handles three jobs:

1. **Announce** — walks the plugin's surfaces (actions, providers, services, models, events, evaluators, routes), serialises all function references as stable RPC ids, and sends a JSON descriptor to the host.
2. **Dispatch** — receives `worker-rpc` messages from the host and routes them to the correct live handler.
3. **Proxy** — gives plugin handlers a `RuntimeProxy` object that looks like a subset of `IAgentRuntime`; each method round-trips to the real runtime in the host process over the message channel.

## Usage

A remote-mode plugin is a normal elizaOS `Plugin` object. The only change is the worker entrypoint:

```ts
// worker.ts
import { bootstrap } from "@elizaos/plugin-worker-runtime";
import { myPlugin } from "./plugin";

bootstrap(myPlugin);
```

`bootstrap()` returns a `Promise<void>` that resolves when the worker has announced its surfaces and called `plugin.init` (if present). The worker stays alive in dispatch mode afterwards.

### Transport selection

By default the channel auto-detects:
- **Bun Worker** (`postMessage` / `addEventListener`) — default.
- **Subprocess** (newline-delimited JSON over stdin/stdout) — activated by setting `ELIZA_REMOTE_PLUGIN_CHANNEL=stdio` in the worker environment.

You can also inject a custom `WorkerChannel` implementation via `bootstrap(plugin, { channel })` for testing.

### RuntimeProxy API

Plugin handlers receive a `runtime` argument that is a `RuntimeProxyApi` — a serialisable subset of `IAgentRuntime`. Supported methods:

- `getService(serviceType)`
- `useModel(modelType, params)`
- `getMemory(memoryId)` / `createMemory(memory, tableName?)` / `updateMemory(memory)`
- `emitEvent(name, payload)`
- `getSetting(key)` / `setSetting(key, value)`
- `composeState(message, options?)`
- `actionCallback(callbackId, response, actionName)`

Methods not in this list are absent by design. Accessing live-object properties of the runtime (e.g. `databaseAdapter`) is not supported in remote mode.
Event handlers are declared statically on `Plugin.events`, where bootstrap can
announce stable RPC handler ids to the host. Dynamic `runtime.registerEvent`
callbacks cannot cross the worker boundary because function values are not
serialisable host-RPC payloads.

### Services

Services in a remote-mode plugin must expose an explicit allowlist of host-reachable methods:

```ts
class MyService {
  static serviceType = "MY_SERVICE";
  static rpcMethods = ["doSomething"] as const;

  static async start(runtime: RuntimeProxyApi): Promise<MyService> {
    return new MyService();
  }

  async doSomething(arg: string): Promise<string> {
    return `done: ${arg}`;
  }
}
```

The service instance is created lazily on the first host invocation and reused for the worker's lifetime.

## Installation

This package is part of the elizaOS monorepo. It is `private: true`, consumed from the workspace, and depends on `@elizaos/plugin-remote-manifest` for the real implementation:

```json
"@elizaos/plugin-worker-runtime": "workspace:*"
```

## Boundary rules

- **Init-time dynamic additions are append-only.** Surfaces appended to the plugin object during `init()` are announced with `worker-announce-dynamic`; replacements, removals, and later runtime mutations are not announced.
- **Implementation changes belong in `packages/plugin-remote-manifest/src/worker-runtime/`.** Keep this package limited to compatibility re-exports unless the public compatibility surface itself changes.
