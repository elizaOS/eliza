# @elizaos/plugin-background-runner

Background task runner plugin for elizaOS. Drives the core `TaskService.runDueTasks()` from OS-level wake-ups on Capacitor mobile builds (iOS `BGTaskScheduler`, Android `WorkManager`). Falls back to a `setInterval` poll on server, desktop, and web hosts where no native scheduler is available.

## What it does

When loaded, the plugin:

1. Registers a `BgTaskSchedulerService` against the runtime.
2. Sets `runtime.serverless = true` so core's `TaskService` skips its own internal timer.
3. Schedules a single periodic wake (label `"eliza-tasks"`, default 15-minute minimum interval).
4. On each OS wake-up, calls `TaskService.runDueTasks()` once, then returns — no long-lived process.

The plugin adds no chat actions, message providers, or evaluators. Its sole contribution is the background scheduler service.

## Capabilities added to an Eliza agent

- Periodic background task execution on mobile (iOS and Android) without requiring the app to be in the foreground.
- Uniform plugin interface across platforms: Capacitor mobile uses the native scheduler; server/desktop/web uses a `setInterval` fallback transparently.

## How to enable

Add the plugin to your agent's plugin array:

```ts
import backgroundRunnerPlugin from '@elizaos/plugin-background-runner';

export default {
  plugins: [backgroundRunnerPlugin],
  // ...
};
```

No configuration options are required. The plugin picks the right scheduler backend automatically based on whether `@capacitor/background-runner` is installed and whether the runtime is a Capacitor native platform.

## Required setup for mobile (Capacitor)

On mobile builds, the native side must be configured separately. The plugin handles only the JavaScript scheduling bridge. See [INSTALL.md](./INSTALL.md) for the complete setup:

- `@capacitor/background-runner` package installation.
- `capacitor.config.ts` plugin block with `label: "eliza-tasks"` (this label must match exactly).
- iOS: `BGTaskSchedulerPermittedIdentifiers` in `Info.plist`, Background Modes capability.
- Android: `flatDir` in `build.gradle`, WorkManager registration.
- Runner JS file (`runners/eliza-tasks.js`) in the host app that POSTs to the wake endpoint on each OS wake.

**Important:** if a Capacitor native platform is detected but `@capacitor/background-runner` is not installed, the plugin throws on startup rather than silently falling back to `setInterval`. Silent fallback on mobile would produce no real background execution.

## Platform behaviour

| Platform | Scheduler | Effective cadence |
|---|---|---|
| iOS | `BGAppRefreshTask` (opportunistic) | ~1–4 hours in practice; ~30s wake budget |
| iOS (heavy) | `BGProcessingTask` | Longer budget; OS prefers charging + Wi-Fi |
| Android | WorkManager periodic | 15-minute floor; Doze/App Standby may defer |
| Server / desktop / web | `setInterval` | Exact interval (default 15 min) |

The 15-minute `minimumIntervalMinutes` default matches the Android WorkManager floor. Setting a shorter interval in `capacitor.config.ts` will be clamped silently by Android.

## Peer dependencies (optional)

These are optional peer dependencies. They are only required on mobile Capacitor builds:

- `@capacitor/core`
- `@capacitor/background-runner` (or the alias `@capacitor-community/background-runner`)

Server, desktop, and web builds do not need them installed.

## Related

- `INSTALL.md` in this package — complete native setup guide for iOS and Android.
- `@elizaos/core` `TaskService` — the service this plugin drives on each wake.
- `runtime.serverless` flag in `@elizaos/core` — set to `true` by this plugin to disable the internal timer.
