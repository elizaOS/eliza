# @elizaos/capacitor-eliza-tasks

Capacitor plugin that bridges iOS `BGTaskScheduler` background-wake events into the elizaOS Capacitor runtime.

## What it does

iOS suspends apps when they leave the foreground. This plugin registers two background task identifiers with `BGTaskScheduler` so the elizaOS iOS app can be woken by the OS on a schedule:

- **`BGAppRefreshTask`** (`ai.eliza.tasks.refresh`) — short wake (~25s budget), network available. Used for polling the agent's loopback `/api/internal/wake` route.
- **`BGProcessingTask`** (`ai.eliza.tasks.processing`) — long-running wake (~120s budget), requires device to be charging and idle. Used for local-LLM warmup passes.
- **Silent APNs push** (`remote-push`) — optional; gated on `ELIZA_APNS_ENABLED` in `Info.plist`. Forwarded through `AppDelegate` via `ElizaCompanionRemotePush` `NSNotification`.

All three wake paths emit the same `wake` event to the JS layer, so a single handler can drain them:

```ts
import { ElizaTasks } from "@elizaos/capacitor-eliza-tasks";

await ElizaTasks.addListener("wake", (event) => {
  console.log(event.kind, event.deadlineSec, event.firedAtMs);
  // event.kind: "refresh" | "processing" | "remote-push"
});

// Arm the first wake
await ElizaTasks.scheduleNext({ earliestBeginSec: 900 });
```

On web and non-iOS platforms the plugin returns `supported: false`; scheduling reports no iOS wake path, and cancellation reports that no web wake requests were cancelled. The app should call `getStatus()` and fall back to `@capacitor/background-runner` polling when `supported` is false.

## Installation

```bash
npm install @elizaos/capacitor-eliza-tasks
npx cap sync
```

### iOS setup

Add both identifiers to `Info.plist`:

```xml
<key>BGTaskSchedulerPermittedIdentifiers</key>
<array>
  <string>ai.eliza.tasks.refresh</string>
  <string>ai.eliza.tasks.processing</string>
</array>
```

For silent-push support also add:

```xml
<key>ELIZA_APNS_ENABLED</key>
<string>1</string>
```

And enable the **Background Modes** capability in Xcode: check `Background fetch` and `Remote notifications`.

## API

### `scheduleNext(options?)`

Enqueues the next `BGAppRefreshTask`. Idempotent — replaces any pending request.

```ts
interface ElizaTasksScheduleOptions {
  earliestBeginSec?: number;  // default 900 (15 min), floor 1
  alsoProcessing?: boolean;   // also schedule a BGProcessingTask
}
```

Returns `ElizaTasksScheduleResult` with `{ scheduled, identifier, earliestBeginAtMs, reason }`.

### `getStatus()`

Returns the plugin's view of `BGTaskScheduler` state:

```ts
interface ElizaTasksStatus {
  supported: boolean;
  platform: "ios" | "android" | "web";
  refreshScheduled: boolean;
  processingScheduled: boolean;
  lastWakeFiredAtMs: number | null;
  lastWakeKind: ElizaTaskKind | null;
  reason: string | null;
}
```

### `cancelAll()`

Cancels all pending refresh and processing task requests.

### `addListener("wake", fn)`

Registers a listener for `ElizaTasksWakeEvent`:

```ts
interface ElizaTasksWakeEvent {
  kind: "refresh" | "processing" | "remote-push";
  identifier: string;
  deadlineSec: number;
  firedAtMs: number;
  payload: Record<string, unknown>;
}
```

### `removeAllListeners()`

Removes all `wake` listeners.

## Platform support

| Platform | Support |
|---|---|
| iOS 15+ | Full — `BGTaskScheduler` + optional APNs |
| Android | Unsupported in this iOS BGTaskScheduler bridge |
| Web / Electron | Unsupported fallback (`supported: false`) |
