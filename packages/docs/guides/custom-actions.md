---
title: Custom Actions
sidebarTitle: Custom Actions
description: Define user-created agent capabilities with HTTP, shell, and code handlers that extend what the agent can do.
---

Actions are the primary way agents interact with the world. They represent discrete capabilities -- things the agent can do in response to conversation context. Eliza ships with built-in actions and provides a system for defining your own custom actions without writing plugin code.

## Action Interface

In the elizaOS runtime, an `Action` is an object with:

- **name** -- Unique identifier the runtime uses to select the action (e.g., `RESTART_AGENT`).
- **similes** -- Alternative names that help the agent match user intent (e.g., `REBOOT`, `RELOAD`).
- **description** -- Human-readable text the agent uses to decide when this action is appropriate.
- **validate** -- Async function returning whether the action can run in the current context.
- **handler** -- Async function that executes the action and returns results.
- **parameters** -- Array of parameter definitions describing accepted inputs.
- **examples** -- Optional conversation examples to help the agent learn when to use the action.

When a user sends a message, the runtime evaluates all registered actions. If the agent determines an action matches the user's intent, it extracts parameters from the conversation and calls the handler.

## Built-in Actions Reference

Eliza registers the following built-in actions automatically at runtime. Action source lives in the elizaOS submodule under `eliza/packages/app-core/src/actions/`.

### Agent Lifecycle

**RESTART_AGENT** -- Gracefully restarts the agent process. Stops the runtime, rebuilds if source files changed, and relaunches. Persists a "Restarting..." memory, returns the response, then schedules a restart after a 1.5-second delay so the response can flush. In CLI mode, exits with code 75 for the runner script; in desktop runtime mode, performs an in-process hot restart. Optional `reason` parameter is logged for diagnostics.

### Plugin Management

These actions provide a full plugin ejection workflow. "Ejecting" clones a plugin's source code locally so the runtime loads your local copy instead of the npm package.

| Action | Description | Key Parameters |
|--------|-------------|---------------|
| `EJECT_PLUGIN` | Clone a plugin's source locally so edits override the npm version. Triggers restart. | `pluginId` (required) |
| `SYNC_PLUGIN` | Fetch and merge upstream commits into an ejected plugin. Reports conflicts if any. | `pluginId` (required) |
| `REINJECT_PLUGIN` | Remove the ejected plugin copy so runtime falls back to npm. Triggers restart. | `pluginId` (required) |
| `LIST_EJECTED_PLUGINS` | List all ejected plugins with name, branch, and local path. | None |

### Core Ejection

Similar to plugin ejection but for the elizaOS core framework itself.

| Action | Description |
|--------|-------------|
| `EJECT_CORE` | Clone `@elizaos/core` source locally so edits override the npm package. Triggers restart. |
| `SYNC_CORE` | Sync an ejected core checkout with upstream and rebuild it. Reports upstream commit count or conflicts. |
| `REINJECT_CORE` | Remove ejected core source so runtime falls back to npm `@elizaos/core`. Triggers restart. |
| `CORE_STATUS` | Show whether `@elizaos/core` is running from npm or ejected source, with version and commit hash. |

### Communication

**MESSAGE** -- Send a message to a user or room on a specific platform/service. Requires `targetType` (`user` or `room`), `source` (service name like `telegram`), `target` (entity/room ID), and `text`. Looks up the service via `runtime.getService()` and calls the appropriate send method.

### Media Generation

| Action | Description | Required Parameters |
|--------|-------------|-------------------|
| `GENERATE_MEDIA` | Generate image, video, or audio from a text prompt. Supports image size/quality/style, video duration/aspect ratio/image-to-video, and audio duration/instrumental/genre options. Use `mediaType` to force `image`, `video`, or `audio`. | `prompt` |
| `ANALYZE_IMAGE` | Analyze an image using AI vision. Accepts `imageUrl` or `imageBase64` with an optional analysis `prompt`. | `imageUrl` or `imageBase64` |

All media actions use the configured provider (Eliza Cloud by default, or FAL/OpenAI/Google/Anthropic).

### System

| Action | Description |
|--------|-------------|
| `PLAY_EMOTE` | Play an emote animation on the avatar. Looks up the emote in the catalog and POSTs to the local API. |
| `INSTALL_PLUGIN` | Install a plugin from the registry via `POST /api/plugins/install`. Auto-restarts to load it. |
| `SHELL_COMMAND` | Execute a shell command via `POST /api/terminal/run`. Output is broadcast via WebSocket. |
| `LOG_LEVEL` | Set the per-room log level for the current session (`trace`, `debug`, `info`, `warn`, `error`). |

## Custom Actions

Custom actions are user-defined capabilities defined in your `eliza.json` configuration. They allow you to wire up external APIs, run shell commands, or execute inline JavaScript -- all surfaced as first-class actions the agent can invoke during conversations.

### Handler Types

Each custom action has a `handler` that specifies how it executes:

<CodeGroup>
```json http
{
  "type": "http",
  "method": "POST",
  "url": "https://api.example.com/data/{{query}}",
  "headers": {
    "Authorization": "Bearer sk-xxx",
    "Content-Type": "application/json"
  },
  "bodyTemplate": "{\"search\": \"{{query}}\"}"
}
```

```json shell
{
  "type": "shell",
  "command": "curl -s https://api.example.com/status?q={{query}}"
}
```

```json code
{
  "type": "code",
  "code": "const res = await fetch('https://api.example.com/data/' + params.id); return await res.text();"
}
```
</CodeGroup>

**`http`** -- Makes an HTTP request. Parameter placeholders (`{{paramName}}`) in the URL are URI-encoded; placeholders in the body template are left raw for JSON contexts. Fields: `method`, `url`, `headers`, `bodyTemplate`.

<Warning>
HTTP handlers include SSRF protection that blocks requests to private/internal network addresses (localhost, link-local, RFC-1918 ranges, cloud metadata endpoints). DNS resolution is checked to prevent alias bypasses. Redirects are blocked entirely.
</Warning>

**`shell`** -- Runs a shell command via the local terminal API. Parameter values are automatically shell-escaped to prevent injection. Executes through `POST /api/terminal/run`.

**`code`** -- Executes inline JavaScript in a sandboxed Node.js VM context (`vm.runInNewContext()`). Only `params` and `fetch` are exposed in the sandbox -- no `require`, `import`, `process`, or `global` access. 30-second timeout.

### CustomActionDef Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier for the action |
| `name` | `string` | Yes | Action name used by the agent to invoke it |
| `description` | `string` | Yes | Human-readable description of what the action does |
| `similes` | `string[]` | No | Alternative names/triggers for the action |
| `parameters` | `Array<{name, description, required}>` | Yes | Parameter definitions |
| `handler` | `CustomActionHandler` | Yes | One of `http`, `shell`, or `code` handler objects |
| `enabled` | `boolean` | Yes | Whether the action is active |
| `createdAt` | `string` | Yes | ISO timestamp of creation |
| `updatedAt` | `string` | Yes | ISO timestamp of last update |

### Defining Custom Actions

Add custom actions to the `customActions` array in your `eliza.json`:

```json
{
  "customActions": [
    {
      "id": "weather-check",
      "name": "CHECK_WEATHER",
      "description": "Check the current weather for a given city",
      "similes": ["WEATHER", "GET_WEATHER", "FORECAST"],
      "parameters": [
        {
          "name": "city",
          "description": "The city name to check weather for",
          "required": true
        }
      ],
      "handler": {
        "type": "http",
        "method": "GET",
        "url": "https://wttr.in/{{city}}?format=3"
      },
      "enabled": true,
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

### Action Discovery and Registration

**Startup loading:** At plugin initialization, `loadCustomActions()` reads `eliza.json`, filters to only `enabled` definitions, and converts each into an elizaOS `Action` via `defToAction()`. The conversion builds an async handler based on the handler type, maps parameters to elizaOS format (all typed as `string`), and sets `validate: async () => true`.

**Live registration:** Register new actions at runtime without restarting using `registerCustomActionLive(def)`. This converts the definition using the same `defToAction()` pipeline and calls `runtime.registerAction()` to make it immediately available. Returns the created `Action` or `null` if no runtime is available.

**Testing:** The `buildTestHandler(def)` function creates a temporary handler for testing without registering. Returns a function that accepts parameters and returns `{ ok: boolean; output: string }`.

```typescript
import { buildTestHandler } from './runtime/custom-actions';

const testHandler = buildTestHandler(myActionDef);
const result = await testHandler({ city: 'London' });
// result: { ok: true, output: 'London: +12°C' }
```

## Creating Actions in Plugins

Beyond config-defined custom actions, you can create actions as part of a plugin by implementing the `Action` interface directly.

<Steps>

### Define the Action

```typescript
import type { Action, HandlerOptions } from '@elizaos/core';

export const myAction: Action = {
  name: 'MY_CUSTOM_ACTION',
  similes: ['MY_ACTION', 'DO_THING'],
  description: 'Describe what this action does so the agent knows when to use it.',

  validate: async (runtime, message, state) => {
    // Return true if this action can run in the current context.
    return true;
  },

  handler: async (runtime, message, state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const input = typeof params?.input === 'string' ? params.input.trim() : '';

    if (!input) {
      return { text: 'I need an input parameter.', success: false };
    }

    const result = await doSomething(input);
    return {
      text: `Done: ${result}`,
      success: true,
      data: { input, result },
    };
  },

  parameters: [
    {
      name: 'input',
      description: 'The input value for this action',
      required: true,
      schema: { type: 'string' as const },
    },
  ],
};
```

### Write the Validation Function

Common validation patterns:

```typescript
// Always available
validate: async () => true,

// Only when a specific service is loaded
validate: async (runtime) => {
  return runtime.getService('myservice') !== null;
},

// Only for certain users
validate: async (runtime, message) => {
  const adminIds = ['user-123', 'user-456'];
  return adminIds.includes(message.entityId);
},
```

### Write the Handler Function

The handler receives `runtime` (IAgentRuntime), `message` (Memory), `state` (State | undefined), and `options` (cast to `HandlerOptions` for parameter access). It must return an object with `text` (string) and `success` (boolean). Optional fields: `data` (metadata) and `attachments` (media files).

### Register in a Plugin

```typescript
import type { Plugin } from '@elizaos/core';
import { myAction } from './actions/my-action';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom plugin',
  actions: [myAction],
};
```

</Steps>

## Action Execution Flow

When the agent processes a message, actions are evaluated in this order:

1. **Intent matching** -- The runtime evaluates all registered actions' names, similes, and descriptions against conversation context.
2. **Validation** -- The selected action's `validate()` function is called. If it returns `false`, the action is skipped.
3. **Parameter extraction** -- The runtime extracts parameter values from the conversation based on the action's `parameters` definitions.
4. **Handler execution** -- The action's `handler()` runs with the extracted parameters.
5. **Response delivery** -- The handler's return value (text, attachments, data) is delivered back to the user.

## Best Practices

<Info>

**Naming:** Use SCREAMING_SNAKE_CASE for action names. Keep names short and add relevant similes to improve intent matching.

**Descriptions:** The agent uses the description to decide when to invoke your action. Write clear, specific descriptions that explain both what the action does and when it should be used.

**Validate defensively:** Always check required parameters in the handler and return a helpful error message if they are missing, even if `validate()` returns `true`.

**Keep handlers fast:** For long-running operations, return a status message immediately and use WebSocket or polling for progress updates.

**Structured returns:** Always include `success: boolean`. Use `data` for machine-readable metadata that other actions or the UI can consume.

</Info>
