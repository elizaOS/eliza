# `@elizaos/plugin-background-runner` — Native Setup

This plugin owns the **JS side** of background execution: it registers a
`BgTaskSchedulerService` that toggles `runtime.serverless = true` and drives
core's `TaskService.runDueTasks()` from OS-level wake-ups.

The **native side** — iOS BGTaskScheduler entitlements, Android WorkManager
configuration, the runner JS file the OS re-enters on wake — lives in the host
Capacitor app (`apps/app/electrobun-mobile/` or wherever the mobile shell is
maintained).

## What this plugin ships

- `src/services/BgTaskSchedulerService.ts` — registered against the core
  `Service` API. On `start()` it sets `runtime.serverless = true`, picks an
  `IBgTaskScheduler` implementation, and schedules a single periodic wake at
  `minimumIntervalMinutes` (default `15`).
- `src/services/IntervalBgScheduler.ts` — `setInterval`-based fallback for
  hosts without `@capacitor/background-runner`.
- `src/capacitor/capacitor-scheduler.ts` + `src/capacitor/bridge.ts` — the
  Capacitor-backed implementation. Resolved at runtime via
  `resolveCapacitorEnvironment()`; the plugin works without the Capacitor
  modules installed.
- `RUNNER_LABEL = "eliza-tasks"` — the label the plugin schedules under. Must
  match the label declared in `capacitor.config.ts` (below).

## Prerequisites

```bash
bun add @capacitor/core @capacitor/background-runner
```

Both are **optional peers** of this plugin: server / desktop / web hosts that
never run the Capacitor branch don't need to install them. When they're
absent the plugin uses `IntervalBgScheduler`.

Host apps that still depend on `@capacitor-community/background-runner` may
keep a package alias to the official package, for example:

```jsonc
{
  "dependencies": {
    "@capacitor-community/background-runner": "npm:@capacitor/background-runner@^3.0.0"
  }
}
```

## `capacitor.config.ts`

Both iOS and Android consume the same plugin configuration block:

```ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.eliza.app",
  appName: "Eliza",
  webDir: "dist",
  plugins: {
    BackgroundRunner: {
      label: "eliza-tasks",
      // Path is resolved by @capacitor/background-runner from the platform
      // assets directory (ios/App/App/runners/, android/app/src/main/assets/runners/).
      src: "runners/eliza-tasks.js",
      event: "wake",
      repeat: true,
      // Floor on both platforms; see "Reality check" below.
      interval: 15,
      autoStart: true,
    },
  },
};

export default config;
```

The `label` field MUST be `eliza-tasks` — it matches `RUNNER_LABEL` in
`BgTaskSchedulerService.ts`. Changing it disconnects the plugin from the
native scheduler.

## Runner JS file

`@capacitor/background-runner` re-enters a dedicated JS context (NOT the
WebView) when the OS wakes the app. The runner script lives outside the
plugin and is written by the host app's build (Wave 3D in this repo's
delivery plan).

- iOS: `ios/App/App/runners/eliza-tasks.js`
- Android: `android/app/src/main/assets/runners/eliza-tasks.js`

Both files have the same contract: respond to the `wake` event by calling
back into the running app via the device-secret-authed loopback endpoint
(see "Wake authentication" below).

> Cross-wave: the runner JS files are scaffolded by Wave 3D
> (`plugin-background-runner` companion task in the host app). Until Wave 3D
> lands, manually copy a minimal stub that posts to
> `http://127.0.0.1:31337/api/internal/wake` with the device secret.

## iOS — `BGTaskScheduler`

1. In Xcode, add a **Background Modes** capability to the app target. Check
   **Background fetch** and **Background processing**.

2. Register the runner identifiers in `ios/App/App/Info.plist`:

   ```xml
   <key>BGTaskSchedulerPermittedIdentifiers</key>
   <array>
     <string>ai.eliza.tasks.refresh</string>
     <string>ai.eliza.tasks.processing</string>
   </array>
   ```

   - `ai.eliza.tasks.refresh` — `BGAppRefreshTaskRequest`, short opportunistic
     wakes (~30s budget). Used by `BgTaskSchedulerService` for the regular
     drain.
   - `ai.eliza.tasks.processing` — `BGProcessingTaskRequest`, longer
     opportunistic wakes for heavier work. Used when a task is tagged
     `bg-heavy-fgs` (see "Execution profiles" in `AGENTS.md`).

   > Cross-wave: native registration of these two identifiers is owned by
   > Wave 3A. The plist entries above match what 3A registers; if you build
   > the iOS shell before 3A lands you will get a runtime crash when the
   > plugin schedules an unregistered identifier.

3. The bundle identifier `ai.eliza.app` in `capacitor.config.ts` must match
   the iOS app's bundle ID. The task identifiers above are prefixed with
   that bundle ID by Apple convention.

## Android — `WorkManager`

1. Follow the official `@capacitor/background-runner` Android setup. The
   relevant step is the `flatDir` entry in `android/app/build.gradle`:

   ```gradle
   repositories {
     flatDir {
       dirs "$rootDir/../node_modules/@capacitor/background-runner/android/src/main/libs"
     }
   }
   ```

2. The plugin schedules a single periodic work item under the unique work
   name `eliza.tasks.refresh`. WorkManager dedupes by name — the
   `ExistingPeriodicWorkPolicy.UPDATE` policy is used so config changes
   replace the existing schedule rather than fan out.

   > Cross-wave: the native WorkManager registration is owned by Wave 3B.
   > Before 3B lands, `@capacitor/background-runner` falls back to a
   > best-effort foreground service.

3. WorkManager enforces a **15-minute floor** on periodic work. The plugin's
   default `minimumIntervalMinutes` is `15`. Setting a smaller interval in
   `capacitor.config.ts` will be clamped by Android — the plugin does NOT
   pre-clamp.

## Wake authentication

The runner JS file calls back into the running app process. To prevent any
non-app process from triggering a wake, the runner POSTs to a loopback
endpoint guarded by a device secret:

```
POST http://127.0.0.1:31337/api/internal/wake
Content-Type: application/json
X-Eliza-Device-Secret: <secret>

{}
```

- The endpoint is bound to `127.0.0.1` only — not reachable from the network.
- The device secret is provisioned at first launch and stored in the OS
  keychain (Keychain on iOS, EncryptedSharedPreferences on Android). The
  runner reads it from the keychain on each wake.
- Unknown / missing secret returns `401`; the endpoint never accepts
  unauthenticated calls.

> Cross-wave: the `/api/internal/wake` endpoint and the device-secret
> handshake are owned by Wave 3D. The runner JS files in Wave 3D will be
> wired to read the secret from the platform-specific keychain.

## Reality check

The 15-minute cadence is a **ceiling, not a floor**. What the OS actually
delivers:

- **iOS `BGAppRefreshTask`**: opportunistic. Apple's scheduler decides when
  to wake your app based on usage patterns, battery, network, and how many
  other apps want time. Typical cadence on a healthy device is once per
  ~1-4 hours. Wake budget is **~30 seconds**; the system kills the process
  if you exceed it. Apps that have been force-quit by the user receive no
  background wakes until the user reopens them.
- **iOS `BGProcessingTask`**: also opportunistic, but the budget is longer
  (typically a few minutes) and the system prefers to schedule it while
  the device is charging on Wi-Fi.
- **Android WorkManager (periodic)**: 15-minute floor, no ceiling. Doze
  mode and App Standby can defer execution by hours. Force-stopped apps
  do not receive WorkManager events.
- **Android foreground service (FGS)**: a persistent notification keeps
  the process alive indefinitely, at the cost of a visible "running"
  notification. This is the only way to guarantee execution on Android
  short of the user opening the app. Used selectively for the
  `bg-heavy-fgs` execution profile.

**Implication for product**: a 1-minute interval trigger on a mobile build
will fire at most every 15 minutes, and often less frequently. The
`HeartbeatForm` UI surfaces a warning when the user picks an interval
shorter than 15 minutes on a Capacitor host
(see `packages/ui/src/components/pages/HeartbeatForm.tsx`).

## What this plugin does NOT do

- It does **not** ship the runner JS files. Different host apps need
  different boot logic (which agents to load, how to initialize storage,
  how to read the device secret). Wave 3D owns the canonical runner
  contents for this monorepo's mobile build.
- It does **not** patch `Info.plist` / `AndroidManifest.xml`. Those are
  host-app concerns — Wave 3A and 3B own those edits respectively.
- It does **not** define `/api/internal/wake`. That endpoint lives in the
  API package and is wired by Wave 3D.
- It does **not** start a long-lived process. The serverless seam in core's
  `TaskService` (`runtime.serverless = true`) means each wake runs once and
  returns.

## Related

- `packages/core/src/services/task-scheduler.ts` — the core scheduler this
  plugin drives.
- `packages/core/src/types/runtime.ts` — `runtime.serverless` flag.
- `plugins/plugin-workflow/src/utils/host-capabilities.ts` — host capability
  detection used by the workflow engine to refuse activation of nodes the
  host can't satisfy.
- `packages/ui/src/utils/host-capabilities.ts` — UI-side mirror used to
  surface warnings in the Heartbeats editor.
- `docs/background-execution.md` — user-facing one-pager on what scheduled
  tasks do when the app is closed.
