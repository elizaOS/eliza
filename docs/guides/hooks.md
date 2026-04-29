---
title: Event Hooks
sidebarTitle: Hooks
description: Extend the agent with event-driven handlers that respond to commands, sessions, agent lifecycle, and gateway events.
---

Hooks are event-driven handlers that extend the Milady agent by responding to system events. They are loaded from disk at startup, checked for eligibility, and registered into an event dispatch system. Hooks allow you to run custom logic when commands are issued, sessions change, the agent starts up, or gateway events occur.

## Hook Event Types

Hooks respond to four categories of events:

| Event Type | Description | Example Actions |
|-----------|-------------|-----------------|
| `command` | User-issued commands | `new`, `reset`, custom commands |
| `session` | Session lifecycle events | Session creation, termination |
| `agent` | Agent lifecycle events | `startup`, shutdown, state changes |
| `gateway` | Gateway-level events | Connection events, routing |

Each hook event carries:
- `type` -- the event category
- `action` -- specific action within the category (e.g., "new", "reset", "startup")
- `sessionKey` -- the session where the event occurred
- `timestamp` -- when the event was fired
- `messages` -- an array that handlers can push response messages into
- `context` -- additional key-value data

## Hook Metadata (HOOK.md Frontmatter)

Each hook is a directory containing a `HOOK.md` file with YAML frontmatter and a handler module. The frontmatter defines the hook's identity and requirements.

### Frontmatter Fields

```yaml
---
name: my-hook
description: Does something useful on session start
homepage: https://example.com/docs
metadata:
  milady:
    always: false
    hookKey: my-hook
    emoji: "🔧"
    events:
      - session:new
      - agent:startup
    export: default
    os:
      - darwin
      - linux
    requires:
      bins:
        - git
        - node
      anyBins:
        - bun
        - npm
      env:
        - GITHUB_TOKEN
      config:
        - hooks.entries.my-hook.apiKey
    install:
      - id: git
        kind: bundled
        bins:
          - git
---
```

### Milady Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `always` | `boolean` | If `true`, bypasses all eligibility checks except OS |
| `hookKey` | `string` | Config key override (defaults to hook name). Used to look up per-hook configuration in `hooks.entries.<hookKey>` |
| `emoji` | `string` | Display emoji for logging |
| `homepage` | `string` | Documentation URL |
| `events` | `string[]` | Event keys this hook handles (e.g., `"command:new"`, `"session"`, `"agent:startup"`) |
| `export` | `string` | Named export to use from the handler module (defaults to `"default"`) |
| `os` | `string[]` | Required platforms (`darwin`, `linux`, `win32`). Hook is skipped on non-matching platforms. |
| `requires.bins` | `string[]` | All listed binaries must exist on `$PATH` |
| `requires.anyBins` | `string[]` | At least one listed binary must exist on `$PATH` |
| `requires.env` | `string[]` | Required environment variables (checked in both process env and hook config env) |
| `requires.config` | `string[]` | Required config paths that must be truthy in the Milady config |
| `install` | `HookInstallSpec[]` | Installation methods for the macOS Skills UI |

## Hook Discovery

Hooks are discovered from multiple directory sources with a defined precedence order (later sources override earlier ones on name conflicts):

1. **Extra directories** (lowest precedence) -- additional directories specified in config `hooks.load.extraDirs` (must be under `~/.milady/`)
2. **Bundled directory** -- hooks shipped with Milady
3. **Managed directory** -- `~/.milady/hooks/` for user-installed hooks
4. **Workspace directory** (highest precedence) -- `<workspace>/hooks/` for project-specific hooks

Within each directory, the discovery system:
1. Scans for subdirectories
2. Looks for a `HOOK.md` file in each subdirectory
3. Parses the frontmatter for metadata
4. Locates the handler module (checks `handler.ts`, `handler`, `index.ts`, `index` in order)

## Eligibility Checks

Before a hook is loaded, it must pass eligibility checks based on its `requires` metadata:

### OS Check
If `os` is specified, the current platform must be in the list. This check always runs, even when `always: true`.

### Binary Check (`requires.bins`)
Every binary listed must be found on `$PATH`. If any are missing, the hook is marked ineligible with a "Binary missing: \<name\>" message.

### Any-Binary Check (`requires.anyBins`)
At least one binary from the list must be found on `$PATH`.

### Environment Variable Check (`requires.env`)
Each listed environment variable must be present in either `process.env` or in the hook's config entry `env` field.

### Config Path Check (`requires.config`)
Each dot-separated config path must resolve to a truthy value in the Milady config object.

### The `always` Flag
When `always: true`, the hook skips binary, environment, and config checks. Only the OS check still applies.

### Disabled vs. Ineligible
These are separate concepts. A hook can be eligible but disabled (`enabled: false` in hook config). The eligibility system does not check the `enabled` flag -- that is handled by the loader after eligibility is determined.

## Hook Registry

The hook registry dispatches events using a specific-then-general pattern:

1. **Specific handlers** fire first: `"command:new"` matches only the `/new` command
2. **General handlers** fire second: `"command"` matches all command events

When an event is triggered:
```
Event { type: "command", action: "new" }
  → dispatch to handlers registered for "command:new"
  → then dispatch to handlers registered for "command"
```

Multiple handlers can be registered for the same event key. All matching handlers execute in registration order. If a handler throws an error, it is logged but does not prevent other handlers from running.

### Registration

```typescript
registerHook("command:new", handler);  // Specific event
registerHook("session", handler);       // All session events
```

### Creating Events

```typescript
const event = createHookEvent(
  "command",           // type
  "new",               // action
  "session-key-123",   // session key
  { userId: "abc" }    // optional context
);
await triggerHook(event);
```

## Writing a Custom Hook

### 1. Create the Hook Directory

Create a new directory under `~/.milady/hooks/my-hook/` with two files:

**HOOK.md**
```yaml
---
name: my-hook
description: Logs a greeting when a new session starts
metadata:
  milady:
    events:
      - session:new
    requires:
      env: []
---

# My Hook

This hook logs a greeting when a new chat session begins.
```

**handler.ts**
```typescript
import type { HookEvent } from "milady/hooks/types";

export default async function handler(event: HookEvent): Promise<void> {
  console.log(`New session started: ${event.sessionKey}`);
  event.messages.push("Welcome to this session!");
}
```

### 2. Handler Requirements

- The handler module must export a function (default export or named export matching the `export` field)
- The function receives a `HookEvent` object
- It can be sync or async
- Push strings to `event.messages` to send responses back to the user
- Access `event.context` for additional data passed with the event

### 3. Loading

Hooks are loaded automatically at gateway startup via `loadHooks()`. The loader:
1. Checks if hooks are enabled in config
2. Clears any existing hooks (supporting hot reload)
3. Discovers hooks from all source directories
4. Checks eligibility for each hook
5. Loads the handler module via dynamic import (with cache-busting for dev mode)
6. Registers the handler for each configured event key

The loader returns a summary: total discovered, eligible, registered, skipped (with reasons), and failed.

### 4. Path Safety

Hook handler modules can only be loaded from allowed directories:
- `~/.milady/hooks/`
- The bundled hooks directory
- `<workspace>/hooks/`

Attempts to load modules from outside these directories are blocked to prevent arbitrary code execution.
