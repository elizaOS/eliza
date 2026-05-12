---
title: "Events"
sidebarTitle: "Events"
description: "The Eliza hooks event system, lifecycle events, handler registration, and event flow."
---

Eliza provides an event-driven hooks system that lets external code react to agent lifecycle events. Hooks are TypeScript/JavaScript modules that export handler functions, registered against named event keys.

## Event System Architecture

The hooks system lives in `eliza/packages/agent/src/hooks/` and follows a three-stage pipeline:

```
Discovery → Eligibility → Registration → Dispatch
```

1. **Discovery** — `discoverHooks()` scans the hooks directories for `HOOK.md` files
2. **Eligibility** — `checkEligibility()` validates platform requirements, required binaries, env vars, and config paths
3. **Registration** — `registerHook(eventKey, handler)` stores handlers in an in-memory registry keyed by event key
4. **Dispatch** — `triggerHook(event)` dispatches to all matching handlers

## Event Types

```typescript
export type HookEventType = "command" | "session" | "agent" | "gateway";
```

| Type | Description |
|---|---|
| `"command"` | Agent command events (e.g., `/new`, `/reset`) |
| `"session"` | Session lifecycle events (start, end) |
| `"agent"` | Agent lifecycle events (startup, shutdown) |
| `"gateway"` | Gateway-level events |

## HookEvent Interface

```typescript
export interface HookEvent {
  type: HookEventType;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];          // Handlers push to this to reply to the user
  context: Record<string, unknown>;
}
```

## Event Key Matching

Event keys use the format `"type:action"` for specific events or just `"type"` for all events of a given type:

```
"command"       matches all command events
"command:new"   matches only the /new command
"session:start" matches only session start events
"agent"         matches all agent lifecycle events
```

Dispatch calls specific handlers first, then general category handlers:

```typescript
// In eliza/packages/agent/src/hooks/registry.ts
const specificKey = `${event.type}:${event.action}`;
const generalKey = event.type;
// specificKey handlers run before generalKey handlers
```

## Hook Handler Signature

```typescript
export type HookHandler = (event: HookEvent) => Promise<void> | void;
```

A minimal handler:

```typescript
// ~/.eliza/hooks/my-hook/handler.ts
export default async function handler(event: HookEvent): Promise<void> {
  if (event.action === "new") {
    event.messages.push("Welcome! A new session has started.");
  }
}
```

## Programmatic Hook Registration

Use `registerHook` to register handlers in code:

```typescript
import { registerHook } from "../hooks/registry";
import { createHookEvent, triggerHook } from "../hooks/index";

// Register a handler for all command events
registerHook("command", async (event) => {
  console.log(`Command: ${event.action} in session ${event.sessionKey}`);
});

// Register a handler for a specific event
registerHook("command:new", async (event) => {
  event.messages.push("Starting fresh!");
});
```

## Creating and Dispatching Events

```typescript
import { createHookEvent, triggerHook } from "../hooks/index";

const event = createHookEvent(
  "command",      // type
  "new",          // action
  "my-session",   // sessionKey
  { userId: "abc" }  // context
);

await triggerHook(event);
// event.messages now contains any responses from handlers
```

## loadHooks

`loadHooks()` is the main entry point called during gateway startup. It orchestrates the full pipeline.

> **Note:** `clearHooks()` is called at the start of each `loadHooks()` invocation, which means all previously registered hooks are cleared on reload. This is important for hot-reload semantics — calling `loadHooks()` again gives you a fresh hook registry.

```typescript
import { loadHooks } from "../hooks/index";

const result = await loadHooks({
  workspacePath: "~/.eliza/workspace",
  bundledDir: "/path/to/bundled-hooks",
  extraDirs: [],
  internalConfig: config.hooks?.internal,
  elizaConfig: config,
});

console.log(`Registered: ${result.registered}/${result.discovered}`);
console.log(`Skipped: ${result.skipped}`);
console.log(`Failed: ${result.failed}`);
```

### LoadHooksResult

| Field | Type | Description |
|---|---|---|
| `discovered` | number | Total hooks found in all scanned directories |
| `eligible` | number | Hooks that passed eligibility checks |
| `registered` | number | Hooks successfully loaded and registered |
| `skipped` | string[] | Names of hooks that were skipped (with reason) |
| `failed` | string[] | Names of hooks that failed to load |

## Hook Discovery

Hooks are discovered from four directory categories. Directories processed later override earlier ones on name collision (highest precedence wins):

```
1. Extra dirs:        hooks.internal.load.extraDirs (lowest precedence)
2. Bundled hooks:     <bundledDir>/ (from config or package)
3. Managed hooks:     ~/.eliza/hooks/
4. Workspace hooks:   <workspaceDir>/hooks/ (highest precedence)
```

Each hook directory should contain a `HOOK.md` file with frontmatter metadata.

## HOOK.md Frontmatter

```yaml
---
name: my-hook
description: Does something useful on session start
metadata:
  eliza:
    events:
      - "session:start"
    requires:
      bins: ["jq"]
      env: ["MY_API_KEY"]
    os: ["darwin", "linux"]
    emoji: "🔔"
---
```

### Eligibility Fields

| Field | Type | Description |
|---|---|---|
| `events` | `string[]` | Event keys this hook handles (required) |
| `requires.bins` | `string[]` | All listed binaries must be on PATH |
| `requires.anyBins` | `string[]` | At least one listed binary must be on PATH |
| `requires.env` | `string[]` | Required environment variables |
| `requires.config` | `string[]` | Required config paths (must be truthy) |
| `os` | `string[]` | Allowed platforms (`darwin`, `linux`, `win32`) |
| `always` | `boolean` | Bypass eligibility checks entirely |
| `export` | `string` | Named export to use (default: `"default"`) |
| `hookKey` | `string` | Config key override (defaults to hook name) |

## Internal Hook Config

Hooks can be enabled/disabled via `eliza.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": false
        }
      },
      "load": {
        "extraDirs": ["~/.eliza/custom-hooks"]
      }
    }
  }
}
```

## Legacy Handler Config

Older-style handlers can be registered directly in config (still supported):

```json
{
  "hooks": {
    "internal": {
      "handlers": [
        {
          "event": "command:new",
          "module": "~/.eliza/hooks/my-handler/index.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

Module paths for legacy handlers must resolve to a file under `~/.eliza/` to prevent arbitrary code execution via config injection.

## Error Handling

Handler errors are caught, logged, and do not prevent other handlers from running:

```typescript
for (const { key, handler } of handlers) {
  try {
    await handler(event);
  } catch (err) {
    logger.error(`[hooks] Handler error for "${key}": ${error.message}`);
  }
}
```

## Related Pages

- [Runtime and Lifecycle](/agents/runtime-and-lifecycle) — when hooks are loaded in the startup sequence
- [Hooks Guide](/guides/hooks) — end-to-end guide to creating and deploying hooks
