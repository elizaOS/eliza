# @elizaos/plugin-worker-runtime

Worker-side bootstrap for remote-mode elizaOS plugins.

## What it is

Remote-mode elizaOS plugins run in isolation — inside a Bun Worker thread or a separate subprocess — rather than in the main agent process. This package is the in-worker half of that system.

It handles three jobs:

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

Methods not in this list are absent by design. Accessing live-object properties of the runtime (e.g. `databaseAdapter`) is not supported in remote mode.

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

This package is part of the elizaOS monorepo. It is `private: true` and consumed from the workspace:

```json
"@elizaos/plugin-worker-runtime": "workspace:*"
```

## Known limitations (P1)

- **Action callbacks are no-ops.** Action handlers that write their reply via the `callback` argument have that callback silently dropped. Return the result value directly instead.
- **`runtime.registerEvent` is not supported.** Declare event handlers statically on the `Plugin.events` object.
- **Dynamic surface announcement is not implemented.** Surfaces must be present on the `Plugin` object before `bootstrap()` is called; anything added inside `init()` is not sent to the host.
