# @elizaos/native-activity-tracker

macOS-only Swift helper that streams window/app focus and HID idle events to a typed TypeScript driver.

## Purpose / role

This package is a native helper library, not an elizaOS `Plugin` object. It provides a TypeScript API for spawning the compiled Swift `activity-collector` binary and receiving a real-time stream of macOS application-focus transitions and periodic HID idle samples. Consumers (services, plugins) call `startActivityCollector()` directly to get the event stream. It is **Darwin-only** (`elizaos.platforms: ["darwin"]`); callers must check `isSupportedPlatform()` before starting the collector.

## Plugin surface

This package exports a **library API**, not a registered elizaOS plugin. There are no actions, providers, evaluators, routes, or services registered in a plugin manifest. The public surface is:

| Export | Description |
|---|---|
| `isSupportedPlatform()` | Returns `true` on Darwin; callers must gate on this before calling `startActivityCollector`. |
| `startActivityCollector(options)` | Spawns the Swift binary, line-parses stdout, calls `onEvent` per focus transition and `onIdleSample` per HID idle reading. Returns an `ActivityCollectorHandle` with `.stop()` and `.pid`. |
| `ActivityCollectorEvent` | Focus event: `{ ts, event: "activate"|"deactivate", bundleId, appName, windowTitle? }` |
| `ActivityCollectorIdleSample` | HID idle sample: `{ ts, event: "hid_idle", idleSeconds }` — emitted every 30 s by the Swift timer. |
| `ActivityCollectorHandle` | Handle returned by `startActivityCollector`: `stop(): Promise<void>`, `pid: number | null`. |
| `ActivityCollectorOptions` | Options bag for `startActivityCollector`: `onEvent` (required), `onIdleSample`, `onExit`, `onFatal`, `binaryPath`. |
| `ActivityCollectorExit` | Exit descriptor: `{ code, signal, clean, reason }`. |
| `ActivityEventKind` | `"activate" | "deactivate"` |
| `__internal` | `{ parseEventLine, parseCollectorLine, describeCollectorExit }` — exposed for unit tests only, not stable API. |

## Layout

```
plugins/plugin-native-activity-tracker/
  src/
    index.ts                 Entire TypeScript driver: types, parseCollectorLine, startActivityCollector
  native/
    macos/
      activity-collector.swift   Swift source — NSWorkspace notifications + HID idle timer
      activity-collector         Compiled binary (Darwin arm64/x86_64; must be built via build:swift)
  dist/                      Compiled TypeScript output (built via build script)
  tsconfig.json
  package.json
```

## Commands

```bash
# Compile TypeScript (produces dist/)
bun run --cwd plugins/plugin-native-activity-tracker build

# Compile the Swift helper binary (Darwin only, requires Xcode command-line tools)
bun run --cwd plugins/plugin-native-activity-tracker build:swift
```

No test script is defined in this package's `package.json`.

## Config / env vars

No environment variables are read by this package. The `binaryPath` option to `startActivityCollector` defaults to `../native/macos/activity-collector` relative to `dist/index.js`. Override it if the binary is at a non-standard location.

macOS Accessibility permission is required at runtime for `windowTitle` to be populated (AX API). Without it, `windowTitle` is omitted from events; focus events still fire.

## How to extend

**Add a new event kind from the Swift side:**

1. Add the new event emission to `native/macos/activity-collector.swift` — emit a JSON object with a new `event` string value.
2. Add a corresponding TypeScript interface in `src/index.ts`.
3. Extend `ParsedCollectorLine` union and `parseCollectorLine()` to handle the new `event` value.
4. Add the new callback to `ActivityCollectorOptions` and call it in the `rl.on("line", ...)` handler in `startActivityCollector`.
5. Recompile both: `bun run build:swift` then `bun run build`.

**Add a new TypeScript-only option:**

Add the field to `ActivityCollectorOptions`, use it inside `startActivityCollector`, and rerun `bun run build`.

## Conventions / gotchas

- **Darwin only.** `startActivityCollector` throws immediately on non-Darwin. Always call `isSupportedPlatform()` before calling it.
- **Binary must be pre-compiled.** The compiled `activity-collector` binary is included in `files[]` but must be built with `build:swift` before first use in a fresh checkout. The `build:swift` step requires macOS with Xcode command-line tools (`swiftc`).
- **stdout line protocol.** The Swift binary writes one complete JSON object per line to stdout, unbuffered. Any line that fails to parse is silently dropped by the TypeScript driver (logged at `debug`). Stderr from the binary is logged at `warn`.
- **Fatal threshold.** The driver calls `onFatal` on any non-zero exit or spawn error. There is no auto-restart — the caller is responsible for restart logic.
- **HID idle cadence.** The Swift timer fires after 5 s initial delay then every 30 s. `onIdleSample` is optional and safe to ignore.
- **System sleep / lock.** The Swift collector emits a synthetic `deactivate` on `willSleep`, `screensDidSleep`, `sessionDidResignActive`, and `com.apple.screenIsLocked`, and a synthetic `activate` on wake/unlock. This prevents a stale frontmost app from appearing active across sleep boundaries.
- **Accessibility permission.** `windowTitle` requires macOS Accessibility permission granted to the host process. The collector proceeds without it; `windowTitle` is simply absent.
- **No plugin manifest.** This package does not export an elizaOS `Plugin` object and is not auto-loaded by the elizaOS plugin registry. It is a library dependency that other plugins or services import directly.
- See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture, logging, and naming rules.
