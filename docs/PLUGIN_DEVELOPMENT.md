# Plugin Development (ElizaOS)

## Overview

In ElizaOS, a **plugin** is a plain object implementing the `Plugin` interface (`packages/typescript/src/types/plugin.ts`). Plugins extend the runtime by registering:

- **Actions** (things the agent can do)
- **Providers** (context injected into prompts / state)
- **Services** (long-lived singletons for shared logic)
- **Model handlers** (LLM, embeddings, image description, etc.)
- **Evaluators** (post-response analysis)
- **Routes** (HTTP endpoints, namespaced by plugin name)
- **Events** (runtime lifecycle hooks)
- **Database adapter + schema** (optional; typically via `@elizaos/plugin-sql`)

## Minimal plugin skeleton (TypeScript)

```ts
import type { Plugin } from "@elizaos/core";

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Example plugin showing the main extension points.",
};
```

Register it by passing it to `new AgentRuntime({ plugins: [...] })` and calling `runtime.initialize()` (see `packages/elizaos/examples/chat/typescript/chat.ts` for a minimal “runtime + plugins” setup).

## Actions

Actions are registered via `plugin.actions` and are executed by `runtime.processActions(...)` after the model returns an action plan.

Key types:

- `Action`: `packages/typescript/src/types/components.ts`
- Handler signature: `(runtime, message, state, options, callback, responses) => Promise<ActionResult | undefined>`

Example:

```ts
import type { Action, Plugin } from "@elizaos/core";

const pingAction: Action = {
  name: "PING",
  description: "Respond with pong.",
  validate: async () => true,
  handler: async (_runtime, _message, _state, _options, callback) => {
    await callback?.({ text: "pong", actions: ["REPLY"], simple: true });
    return { success: true, text: "pong" };
  },
};

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Adds a PING action.",
  actions: [pingAction],
};
```

### Action parameters (structured inputs)

Actions can declare `parameters` (JSON-schema-like) to have the LLM extract validated values into `options.parameters`.

See: `ActionParameter`, `HandlerOptions` in `packages/typescript/src/types/components.ts`.

## Providers (state composition)

Providers contribute to `State` via `runtime.composeState(...)` (`packages/typescript/src/runtime.ts`).

Provider characteristics:

- `position`: ordering in the prompt/state aggregation (lower runs earlier)
- `private`: excluded from the default provider set; must be explicitly included
- `dynamic`: excluded from the default provider set; must be explicitly included

Example provider:

```ts
import type { Plugin, Provider } from "@elizaos/core";

const currentTimeProvider: Provider = {
  name: "CURRENT_TIME",
  position: 10,
  get: async () => ({
    text: `Current time: ${new Date().toISOString()}`,
    values: { nowIso: new Date().toISOString() },
  }),
};

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Adds a time provider.",
  providers: [currentTimeProvider],
};
```

## Services (singletons)

Services are long-lived objects (connections, caches, API clients). Plugins register service classes through `plugin.services`.

At registration time (`AgentRuntime.registerPlugin()`), services are registered asynchronously and can be retrieved via `runtime.getService("serviceType")` (see `packages/typescript/src/runtime.ts`).

## Model handlers

Plugins can register model handlers through `plugin.models`. The runtime selects the highest priority handler for a given model type.

This is how LLM providers (OpenAI, Anthropic, etc.) integrate: they implement a handler for `ModelType.TEXT_LARGE`, `ModelType.TEXT_SMALL`, etc.

Relevant types:

- `ModelParamsMap` / `ModelTypeName`: `packages/typescript/src/types/model.ts`
- Runtime API: `IAgentRuntime.useModel(...)` overloads in `packages/typescript/src/types/runtime.ts`

## Routes (HTTP endpoints)

Plugins can add HTTP routes via `plugin.routes`. When registered, the runtime namespaces the path under `/${plugin.name}` (see `AgentRuntime.registerPlugin()`).

Example:

```ts
import type { Plugin, Route } from "@elizaos/core";

const routes: Route[] = [
  {
    type: "GET",
    public: true,
    name: "health",
    path: "/health",
    handler: async (_req, res) => {
      res.status(200).json({ ok: true });
    },
  },
];

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Adds a /my-plugin/health route.",
  routes,
};
```

## Events (lifecycle hooks)

Plugins can register event handlers via `plugin.events` (a map of event name → handlers).

The message pipeline emits events such as `RUN_STARTED`, `RUN_TIMEOUT`, and `RUN_ENDED` (see `packages/typescript/src/services/message.ts`).

## Database schema + migrations

Plugins can optionally provide:

- `schema`: an object describing plugin-specific DB schema

At runtime initialization, plugin migrations can be executed (unless `skipMigrations: true` is passed to `runtime.initialize`).

## Dependencies and loading

Plugins can declare:

- `dependencies`: runtime dependencies
- `testDependencies`: extra dependencies only for test mode

The dependency resolver and Node/Bun auto-install logic live in `packages/typescript/src/plugin.ts`.

## Bootstrap plugin configuration (capabilities)

The built-in `bootstrap` plugin is auto-included by `AgentRuntime.initialize()` unless already provided. When registering it, `AgentRuntime.registerPlugin()` can replace it with a configured bootstrap plugin based on:

- Constructor flags like `disableBasicCapabilities`, `enableExtendedCapabilities`, `enableAutonomy`
- Character settings such as `DISABLE_BASIC_CAPABILITIES`, `ENABLE_EXTENDED_CAPABILITIES`, `ENABLE_AUTONOMY`

## Testing plugins

This repository contains TypeScript unit tests for the core runtime under:

- `packages/typescript/src/__tests__/`

For plugin tests, follow the patterns in the example plugin templates under:

- `packages/elizaos/examples/plugin/`

