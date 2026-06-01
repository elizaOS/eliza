# @elizaos/native-activity-tracker

macOS-only Swift helper that streams real-time window/app focus transitions and periodic HID idle samples to a TypeScript driver.

## What it does

This package provides a TypeScript API that spawns a compiled Swift helper (`native/macos/activity-collector`) and delivers a typed event stream to your callback:

- **Focus events** — one `activate` or `deactivate` event per app-focus change, including `bundleId`, `appName`, and optionally `windowTitle` (when Accessibility permission is granted).
- **HID idle samples** — a periodic `hid_idle` reading (every 30 s) reporting seconds since the last mouse/keyboard input for the active console session. Useful for distinguishing passive media use from away-from-keyboard.
- **System sleep / lock synthetic events** — a synthetic `deactivate` is emitted on system sleep, screen lock, or session resign so downstream consumers do not see a stale frontmost app across sleep boundaries. A synthetic `activate` fires on wake/unlock.

## Platform support

**Darwin (macOS) only.** The Swift helper uses `NSWorkspace`, `CGEventSource`, and optionally the AX API. It will not run on Linux or Windows. Always call `isSupportedPlatform()` before starting the collector.

## Prerequisites

- macOS with Xcode command-line tools (`swiftc`) for the build step.
- The compiled binary `native/macos/activity-collector` must exist before calling `startActivityCollector`. Build it with:

```bash
bun run --cwd plugins/plugin-native-activity-tracker build:swift
```

- **Accessibility permission** (optional): grant it to the host process in System Settings > Privacy & Security > Accessibility to enable `windowTitle` in focus events. The collector works without it; `windowTitle` is simply omitted.

## Installation

This package is part of the elizaOS monorepo. It is not an auto-loaded elizaOS plugin — import it directly from whichever plugin or service needs activity tracking:

```ts
import { isSupportedPlatform, startActivityCollector } from "@elizaos/native-activity-tracker";
```

## Usage

```ts
import { isSupportedPlatform, startActivityCollector } from "@elizaos/native-activity-tracker";

if (!isSupportedPlatform()) {
  // Not macOS — skip or degrade gracefully
  process.exit(0);
}

const handle = startActivityCollector({
  onEvent(event) {
    // event: { ts, event: "activate"|"deactivate", bundleId, appName, windowTitle? }
    console.log(event);
  },
  onIdleSample(sample) {
    // sample: { ts, event: "hid_idle", idleSeconds }
    console.log("idle seconds:", sample.idleSeconds);
  },
  onFatal(reason) {
    console.error("collector died:", reason);
    // restart logic here if needed
  },
});

// Later, to stop:
await handle.stop();
```

### Options

| Option | Required | Description |
|---|---|---|
| `onEvent` | yes | Called once per focus event (`activate` or `deactivate`). |
| `onIdleSample` | no | Called every ~30 s with an HID idle reading. Safe to omit. |
| `onExit` | no | Called when the collector exits cleanly (code 0). |
| `onFatal` | no | Called on non-zero exit or spawn failure. No auto-restart. |
| `binaryPath` | no | Override path to the compiled binary. Defaults to `native/macos/activity-collector` next to `dist/`. |

## Building

```bash
# TypeScript (produces dist/)
bun run --cwd plugins/plugin-native-activity-tracker build

# Swift binary (requires macOS + swiftc)
bun run --cwd plugins/plugin-native-activity-tracker build:swift
```

## Event format

```jsonc
// Focus event
{ "ts": 1714000000000, "event": "activate", "bundleId": "com.apple.Safari", "appName": "Safari", "windowTitle": "Example" }
{ "ts": 1714000003000, "event": "deactivate", "bundleId": "com.apple.Safari", "appName": "Safari" }

// HID idle sample
{ "ts": 1714000030000, "event": "hid_idle", "idleSeconds": 45 }
```

`ts` is Unix milliseconds. `windowTitle` is present only on `activate` events and only when Accessibility permission is granted.
