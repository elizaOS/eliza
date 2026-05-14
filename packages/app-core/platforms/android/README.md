# elizaOS Android build targets

The build orchestrator at
[`packages/app-core/scripts/run-mobile-build.mjs`](../../scripts/run-mobile-build.mjs)
ships three Android targets. They are deliberately separate because their
manifests, embedded native artifacts, and signing models differ in ways
that make a single APK unviable.

## `build:android:cloud` — Play-Store thin client

```bash
bun run build:android:cloud
```

A Play-Store-compliant Capacitor APK backed by Eliza Cloud as the only
hosting target. Produces a debug APK at
`packages/app/android/app/build/outputs/apk/debug/`.

What this target deliberately does **not** ship:

- No on-device agent runtime — `assets/agent/` is not staged, and no
  `libeliza_*.so` is copied into `jniLibs/`.
- No `ElizaAgentService` declaration.
- No default-role activities (`ElizaDialActivity`, `ElizaSmsReceiver`,
  `ElizaBrowserActivity`, `ElizaContactsActivity`, `ElizaCameraActivity`,
  `ElizaCalendarActivity`, `ElizaClockActivity`, `ElizaAssistActivity`,
  `ElizaInCallService`, `ElizaMmsReceiver`,
  `ElizaRespondViaMessageService`, `ElizaSmsComposeActivity`).
- No `ElizaBootReceiver`.
- No screen-capture native plugin or MediaProjection foreground-service
  declaration.
- No system-only or Play-Store-restricted permissions:
  `MANAGE_APP_OPS_MODES`, `PACKAGE_USAGE_STATS`, `BIND_DEVICE_ADMIN`,
  `READ_FRAME_BUFFER`, `INJECT_EVENTS`, `REAL_GET_TASKS`,
  `READ_SMS` / `SEND_SMS` / `RECEIVE_SMS` / `RECEIVE_MMS` /
  `RECEIVE_WAP_PUSH`, `CALL_PHONE` / `READ_PHONE_STATE` /
  `ANSWER_PHONE_CALLS` / `MANAGE_OWN_CALLS` / `READ_CALL_LOG` /
  `WRITE_CALL_LOG`, `READ_CONTACTS` / `WRITE_CONTACTS`,
  `ACCESS_BACKGROUND_LOCATION`, `RECEIVE_BOOT_COMPLETED`,
  `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`,
  `FOREGROUND_SERVICE_SPECIAL_USE`.

What this target still ships for Pixel/Google Android entry points:

- `res/xml/shortcuts.xml` registered from `MainActivity` with
  `android.app.shortcuts`.
- App Actions capabilities for `OPEN_APP_FEATURE`, `CREATE_MESSAGE`,
  `CREATE_THING`, and `GET_THING`. These cover chat/ask, voice, LifeOps
  daily brief, and LifeOps tasks by opening source-tagged deep links in
  the app.
- Static launcher/Assistant shortcuts for chat, voice, daily brief, and
  tasks.

The Play build intentionally does not request default-assistant or
system-only powers. It has no `ACTION_ASSIST`, `VOICE_COMMAND`,
`ROLE_ASSISTANT`, `BIND_VOICE_INTERACTION`, usage-stats appop, SMS/call
default-role components, boot receiver, MediaProjection foreground
service, or special-use foreground service. Gemini/Assistant
interoperability for this target is through Google App Actions and
Android shortcuts, not by trying to become the device's default
assistant.

Build-time flag set: `VITE_ELIZA_ANDROID_RUNTIME_MODE=cloud`. The
renderer reads this via
[`packages/ui/src/platform/android-runtime.ts`](../../../../ui/src/platform/android-runtime.ts)
and the `RuntimeSettingsSection` hides the Local picker option so users
cannot try to provision an on-device agent that physically isn't there.

## `build:android` — sideload-only debug

```bash
bun run build:android
```

> **WARNING** — this target embeds the Bun-based on-device agent runtime
> as `libeliza_bun.so` (≈95–96 MB per ABI) inside `jniLibs/`, declares
> `FOREGROUND_SERVICE_SPECIAL_USE local-agent-runtime`, and requests
> system-only permissions (`MANAGE_APP_OPS_MODES`, `PACKAGE_USAGE_STATS`,
> `BIND_DEVICE_ADMIN`). It will be **rejected by the Play Store**. Use
> only for sideload installs and developer iteration, or migrate to
> `build:android:cloud` for distribution.

What it does ship: full default-role activities, BootReceiver, the
on-device agent staged via
[`stage-android-agent.mjs`](../../scripts/lib/stage-android-agent.mjs),
the AOSP-aimed permission set, and the same App Actions/static shortcuts
metadata used by the Play build. `ElizaAssistActivity` handles
`android.intent.action.ASSIST` for sideload/AOSP assistant-role testing;
the Play build strips that activity.

## `build:android:system` — AOSP privileged platform-signed APK

```bash
bun run build:android:system
```

Release APK signed by Soong's platform key for Eliza OS / ElizaOS
device builds. The privileged `MANAGE_APP_OPS_MODES`,
`PACKAGE_USAGE_STATS`, `READ_FRAME_BUFFER`, `INJECT_EVENTS`, and
`REAL_GET_TASKS` permissions are granted via the
`privapp-permissions-ai.elizaos.app.xml` whitelist baked into the vendor
tree, so this APK is intended for `priv-app/` placement on
Eliza-flavored AOSP devices, **not** for Play Store distribution.

The matching system image also copies
`/product/etc/eliza/aosp-assistant-full-control.json`, which records the
AOSP-only assistant/full-control contract: `ROLE_ASSISTANT`,
`ACTION_ASSIST`, `VOICE_COMMAND`, boot/direct-boot, foreground services,
usage stats, MediaProjection/SurfaceControl screen capture, Accessibility
input control, and notification-listener capability status.

The release APK is staged at
`<repoRoot>/packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk` (or
the brand-aware vendor dir resolved from `app.config.ts > aosp:`).
