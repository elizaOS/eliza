# `@elizaos/plugin-background-runner` — Native Setup

This plugin only handles the **JS side** of background execution. The native
OS scheduling — iOS BGTaskScheduler entitlements, Android WorkManager
configuration, runner JS files — must be set up in the host Capacitor app.

## Prerequisites

```bash
bun add @capacitor/core @capacitor/background-runner
```

Both are declared as **optional peers** of this plugin: server / desktop / web
hosts that never run the Capacitor branch don't need to install them. When
they're absent the plugin falls back to a `setInterval` poll.

Host apps that still import `@capacitor-community/background-runner` may keep a
package alias to the official package, for example
`"@capacitor-community/background-runner": "npm:@capacitor/background-runner@^3.0.0"`.

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
   the `@capacitor/background-runner` docs for the exact runner contract, and
   pin a specific version in your app's `package.json`.

## Android — `WorkManager`

1. Follow the official `@capacitor/background-runner` Android setup, including
   the `android/app/build.gradle` `flatDir` entry for
   `node_modules/@capacitor/background-runner/android/src/main/libs`.

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
