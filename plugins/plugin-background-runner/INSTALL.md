# `@elizaos/plugin-background-runner` — Native Setup

This plugin only handles the **JS side** of background execution. The native
OS scheduling — iOS BGTaskScheduler entitlements, Android WorkManager
configuration, runner JS files — must be set up in the host Capacitor app.

## Prerequisites

```bash
bun add @capacitor/core @capacitor-community/background-runner
```

Both are declared as **optional peers** of this plugin: server / desktop / web
hosts that never run the Capacitor branch don't need to install them. When
they're absent the plugin falls back to a `setInterval` poll.

## iOS — `BGTaskScheduler`

1. Add a Background Modes capability to the app target in Xcode and check
   **Background fetch** and **Background processing**.

2. Register the runner identifier in `ios/App/App/Info.plist`:

   ```xml
   <key>BGTaskSchedulerPermittedIdentifiers</key>
   <array>
     <string>eliza-tasks</string>
   </array>
   ```

   The string must match the `RUNNER_LABEL` constant in
   `BgTaskSchedulerService` (`eliza-tasks`).

3. Create `ios/App/App/runners/eliza-tasks.js` with a handler that re-enters
   the JS context and dispatches the `wake` event back into the runtime. See
   the `@capacitor-community/background-runner` docs for the exact runner
   contract — the API surface is currently in flux across `2.x` releases, so
   pin a specific version in your app's `package.json`.

## Android — `WorkManager`

1. Add to `android/app/src/main/AndroidManifest.xml` inside `<application>`:

   ```xml
   <service
     android:name="com.capacitorjs.community.plugins.backgroundrunner.BackgroundRunnerService"
     android:permission="android.permission.BIND_JOB_SERVICE"
     android:exported="false" />
   ```

2. Create `android/app/src/main/assets/runners/eliza-tasks.js` mirroring the
   iOS runner.

3. WorkManager enforces a **15-minute floor** on periodic work. The plugin's
   default `minimumIntervalMinutes` is 15.

## `capacitor.config.ts`

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'os.eliza.app',
  appName: 'Eliza',
  webDir: 'dist',
  plugins: {
    BackgroundRunner: {
      label: 'eliza-tasks',
      src: 'runners/eliza-tasks.js',
      event: 'wake',
      repeat: true,
      interval: 15,
      autoStart: true,
    },
  },
};

export default config;
```

## What this plugin does NOT do

- It does **not** ship native runner JS templates. Different host apps need
  different boot logic (which agents to load, how to initialize storage,
  etc.).
- It does **not** patch `Info.plist` / `AndroidManifest.xml` — those are app
  concerns, not plugin concerns.
- It does **not** start a long-lived process. The serverless seam in core's
  `TaskService` (`runtime.serverless = true`) means each wake-up runs once
  and returns.
