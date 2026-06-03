# @elizaos/capacitor-eliza-tasks

Capacitor plugin that bridges iOS `BGTaskScheduler` background-wake events into the elizaOS Capacitor runtime.

## Purpose / role

This is a **Capacitor native plugin** — not an elizaOS action/provider plugin. It gives the elizaOS iOS app access to two iOS background-execution modes (`BGAppRefreshTask` and `BGProcessingTask`) and silent APNs push wakes, surfacing all three as a single uniform `wake` event on the JS side. On web and non-iOS platforms the plugin resolves to an unsupported fallback (`supported: false`) so the runtime falls back to the `@capacitor/background-runner` repeat poll.

The plugin is **opt-in** — the consuming Capacitor app must declare the two task identifiers in `Info.plist`'s `BGTaskSchedulerPermittedIdentifiers` array and call `ElizaTasks.scheduleNext()` to arm the first wake. Silent-push (`remote-push` kind) is additionally gated on `ELIZA_APNS_ENABLED=1` in `Info.plist`.

## Plugin surface

This is a Capacitor plugin, not an elizaOS action/provider/service plugin. There are no elizaOS `actions`, `providers`, `evaluators`, or `services` registered. The Capacitor JS bridge exposes:

| JS method | What it does |
|---|---|
| `ElizaTasks.scheduleNext(opts?)` | Enqueues the next `BGAppRefreshTask`; optionally also a `BGProcessingTask`. Idempotent — replaces any pending request rather than stacking. |
| `ElizaTasks.getStatus()` | Returns a snapshot of `BGTaskScheduler` state (scheduled flags, last-wake timestamp/kind). Used to decide whether to fall back to BackgroundRunner polling. |
| `ElizaTasks.cancelAll()` | Cancels all pending refresh + processing requests. |
| `ElizaTasks.addListener("wake", fn)` | Registers a callback for `ElizaTasksWakeEvent` objects emitted by all three wake paths. |
| `ElizaTasks.removeAllListeners()` | Removes all `wake` listeners. |

**Wake event shape** (`ElizaTasksWakeEvent`):
- `kind`: `"refresh"` | `"processing"` | `"remote-push"`
- `identifier`: `"ai.eliza.tasks.refresh"` | `"ai.eliza.tasks.processing"` | `"ai.eliza.tasks.remote-push"`
- `deadlineSec`: budget the JS runner has before the OS kills the process (25s for refresh, 120s for processing)
- `firedAtMs`: epoch ms when the OS dispatched the wake
- `payload`: for `remote-push`, APNs `userInfo` minus `aps`; otherwise `{}`

## Layout

```
plugins/plugin-native-eliza-tasks/
  src/
    definitions.ts          TypeScript interface (ElizaTasksPlugin, all types/enums)
    index.ts                Capacitor registerPlugin call — exports ElizaTasks singleton
    web.ts                  Web/browser unsupported fallback (supported: false)
  ios/Sources/ElizaTasksPlugin/
    ElizaTasksPlugin.swift  Native Swift — BGTaskScheduler registration, handlers,
                            remote-push observer, JS event emission
  ElizaosCapacitorElizaTasks.podspec  CocoaPods spec (iOS 15+, Swift 5.9)
  rollup.config.mjs         Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js)
  tsconfig.json             Targets ESM output under dist/esm/
```

## Commands

```bash
bun run --cwd plugins/plugin-native-eliza-tasks build   # tsc + rollup
bun run --cwd plugins/plugin-native-eliza-tasks clean   # rm dist/
bun run --cwd plugins/plugin-native-eliza-tasks watch   # tsc --watch
bun run --cwd plugins/plugin-native-eliza-tasks test    # vitest run --passWithNoTests
```

## Config / env vars

These are iOS Info.plist keys, not JS env vars. The native Swift code reads them at OS level.

| Key | Required | Purpose |
|---|---|---|
| `BGTaskSchedulerPermittedIdentifiers` | Yes | Must include `ai.eliza.tasks.refresh` and `ai.eliza.tasks.processing`. If missing, `BGTaskScheduler.register()` returns false and no wake fires. |
| `ELIZA_APNS_ENABLED` | No (default off) | Set to `1` to activate the silent-push (`remote-push`) wake path via `ElizaCompanionRemotePush` `NSNotification`. |

The `scheduleNext` method accepts `earliestBeginSec` (default 900s / 15 min, floor 1s) and `alsoProcessing` (bool, default false).

## How to extend

**Add a new JS-callable method:**
1. Add the method signature to `src/definitions.ts` (`ElizaTasksPlugin` interface).
2. Implement it in `src/web.ts` (`ElizaTasksWeb` class, return a `supported: false` result or a clearly unsupported promise).
3. Add the Swift `@objc func` to `ios/Sources/ElizaTasksPlugin/ElizaTasksPlugin.swift`.
4. Register the method in `pluginMethods` array in the same Swift file.

**Add a new event kind:**
1. Extend `ElizaTaskKind` in `src/definitions.ts`.
2. Add the corresponding `ElizaTaskIdentifier` union if it has a new identifier string.
3. Emit via `notifyListeners("wake", data: [...])` in Swift using the shared `emitWake` helper.

## Conventions / gotchas

- **BGTaskScheduler registration must succeed before `didFinishLaunching` returns** in practice. The plugin's `load()` runs after that — this works on iOS 15+ because the OS queues the dispatch if the identifier is in `BGTaskSchedulerPermittedIdentifiers`, but the timing is subtle. Do not move registration logic out of `load()`.
- **Refresh tasks auto-reschedule themselves** in `handleRefreshTask` (next wake 15 min out). Processing tasks do not — the JS layer must call `scheduleNext({ alsoProcessing: true })` again when a warmup window is needed.
- **`getStatus()` reads `UserDefaults`** to surface wake events that fired before the webview was ready. The persistence keys are prefixed `ai.eliza.tasks.*` and are written by both `persistWake` (on every wake) and the schedule/cancel methods.
- **Android is not supported** — the `capacitor.android` key exists in `package.json` for future use; there is no `android/` source tree.
- **Web returns `supported: false`** for all three methods. The consuming app is expected to check `getStatus().supported` and fall back to `@capacitor/background-runner` polling on web/non-iOS.
- The podspec pod name is `ElizaosCapacitorElizaTasks` (matches `capacitor.ios.podName` in `package.json`). Keep these in sync if renaming.
- See root `AGENTS.md` for repo-wide conventions (logger rules, ESM, architecture commandments).
