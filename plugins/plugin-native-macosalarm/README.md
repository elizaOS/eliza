# @elizaos/macosalarm

macOS native alarm scheduling for Eliza agents via `UNUserNotificationCenter`.

## What it does

This plugin adds the `ALARM` action to an Eliza agent, enabling it to:

- **Set** calendar-trigger alarms that fire as macOS system notifications (with sound).
- **Cancel** pending alarms by ID.
- **List** all pending alarms registered by the agent.

Alarms are delivered through macOS's native `UNUserNotificationCenter` API. A self-contained Swift CLI (`swift-helper/main.swift`) is compiled to a binary at `bin/macosalarm-helper` during the build step. The Eliza runtime spawns this binary via stdin/stdout JSON IPC — no network calls, no third-party services.

## Platform support

**macOS (darwin) only.** The plugin is auto-enabled on darwin (`"autoEnable": "darwin"`). On any other platform the action's validate hook returns `false` and no alarms are attempted.

## Requirements

- macOS with `swiftc` available (Xcode Command Line Tools).
- Node.js >= 24.
- The package must be built before use: `bun run build` compiles both the TypeScript and the Swift helper binary.

## Installation

The plugin is part of the elizaOS monorepo. In your agent character config, reference the package name `@elizaos/macosalarm` (it auto-enables on darwin). For manual loading:

```ts
import macosAlarmPlugin from "@elizaos/macosalarm";
// add to your runtime's plugins array
```

## Build

```bash
bun run --cwd plugins/plugin-native-macosalarm build
```

This runs `tsc --noCheck` and then `swiftc swift-helper/main.swift -O -o bin/macosalarm-helper`.

## Configuration

| Env variable | Default | Purpose |
|-------------|---------|---------|
| `ELIZA_MACOSALARM_HELPER_BIN` | `bin/macosalarm-helper` (relative to package root) | Override the path to the compiled Swift binary |

No other configuration is required.

## Capabilities

### ALARM action

The `ALARM` action has three subactions. The subaction is inferred from the message text when not explicitly provided.

| Subaction | Required params | Description |
|-----------|----------------|-------------|
| `set` | `timeIso`, `title` | Schedule a new alarm. `timeIso` must be an ISO-8601 timestamp. `body`, `sound`, and `id` are optional. |
| `cancel` | `id` | Remove a pending alarm by its ID (returned from a prior `set`). |
| `list` | — | Return all pending macOS alarms. |

Example interactions:

- "Set an alarm for 7am tomorrow" — schedules via `set`.
- "Cancel alarm alarm-abc123" — cancels via `cancel`.
- "List my pending alarms" — lists via `list`.

Keyword matching covers English and several other languages (Spanish, French, German, Chinese, Japanese, Korean, Vietnamese).

### Permissions

On first use of `set`, macOS will prompt the user to allow notifications from the process. If the user denies this permission, alarm scheduling will fail with a `permission-denied` error.

### Role gate

The `ALARM` action requires the agent's user to have at minimum the `ADMIN` role.

## Limitations

- macOS only — no Windows or Linux support.
- The Swift binary must be compiled locally; pre-built binaries are not bundled in the npm package.
- `UNUserNotificationCenter` requires the helper to run from a signed app bundle. Invoked as a bare CLI it throws an `NSInternalInconsistencyException` (`bundleProxyForCurrentProcess is nil`); packaging/signing is owned downstream.
