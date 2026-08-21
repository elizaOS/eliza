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
hosting target. Produces a release AAB at
`packages/app-core/platforms/android/app/build/outputs/bundle/release/`.
For local Pixel smoke tests, `android-cloud-debug` produces a debug APK
under `packages/app-core/platforms/android/app/build/outputs/apk/debug/`.

### Play capability contract

The Play artifact is a standard consumer client. Its post-merge manifest and
package contents are checked against exact allowlists during every Cloud APK or
AAB build; an unexpected permission, component, query, native plugin, native
library, packaged credential, or local-development route fails the build.

Runtime permissions:

- `android.permission.RECORD_AUDIO` — requested only when the user starts a
  voice interaction.

Install-time normal permissions:

- `android.permission.INTERNET`
- `android.permission.ACCESS_NETWORK_STATE`
- AndroidX's app-scoped `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` signature
  permission.

Packaged Android components:

- Activities: `MainActivity`, `ElizaShareActivity`, and Capacitor Browser's
  `BrowserControllerActivity`.
- Providers: the non-exported Capacitor `FileProvider` and AndroidX Startup.
- Receiver: AndroidX Profile Installer's non-app-feature receiver.
- Services: none.
- Native libraries: none.

User-facing capabilities are limited to cloud chat, user-initiated microphone
voice, audio playback, secure private preferences/files, network-state
awareness, browser-based sign-in, ordinary Android sharing/`PROCESS_TEXT`, and
Eliza deep links/shortcuts. The application disables cleartext traffic and
backup, targets API 36, has no package-name query, and does not ship local Mac
routes, emulator/ADB assumptions, provider credentials, or an on-device agent.

The Play client does not declare or register accessibility/gesture control,
notification-listener access, device administration, overlay or usage access,
VPN, MediaProjection, Health Connect, camera/location/Bluetooth/contact/SMS/
call access, default Assistant/Browser/Dialer/SMS/Home roles, an IME, app
installation/update APIs, boot receivers, foreground/background services,
push/local notifications, native inference, or dynamically loadable code.

Policy basis: Google Play restricts sensitive permissions to documented core
uses, requires SMS/Call Log permissions to be removed when the app does not
qualify, imposes declarations and user-perceptibility requirements on foreground
services, and requires current target API levels. See the official
[permissions policy](https://support.google.com/googleplay/android-developer/answer/16558241),
[SMS and Call Log policy](https://support.google.com/googleplay/android-developer/answer/10208820),
[AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491),
[foreground-service requirements](https://support.google.com/googleplay/android-developer/answer/13392821),
[target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878),
and [Android cleartext guidance](https://developer.android.com/privacy-and-security/risks/cleartext-communications).

Release AAB auditing uses Google's standalone bundletool JAR. The canonical
build downloads bundletool 1.18.3 into a temporary cache and verifies its
pinned SHA-256 before execution. To supply a pre-provisioned official JAR
instead, point the build at it:

```bash
export ELIZA_ANDROID_BUNDLETOOL_JAR=/absolute/path/bundletool-all-1.18.3.jar
bun run build:android:cloud
```

The release build fails closed when bundletool cannot be downloaded, either
downloaded or configured JAR has the wrong checksum, the configured JAR is
missing, or bundletool cannot validate the bundle. The post-build audit decodes
the merged manifest for every AAB module and scans every
`<module>/dex/classes*.dex` entry. This keeps stripped permissions, components,
private LP3 actions, policy classes, and policy markers out of the Play
artifact. Every packaged `.dex` is scanned — including one smuggled outside a
module `dex/` directory — and cloud artifacts additionally reject any `.dex`
or banned native library under `assets/`. APK targets continue to use AAPT for
their badging and manifest checks. Every Cloud `bundleRelease` Gradle task
audits its exact final output, including the signed bundle produced by release
automation; the Gradle finalizer resolves the audit CLI from
`ELIZA_MOBILE_AUDIT_SCRIPT` (set by the orchestrator, so npm-packages /
white-label layouts work) and falls back to the repo-relative script path for
direct `./gradlew` runs from a source checkout. An already-built Cloud bundle
can be audited directly with:

```bash
node packages/app-core/scripts/run-mobile-build.mjs android-cloud-audit /absolute/path/app-release.aab
```

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
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `SYSTEM_ALERT_WINDOW`,
  `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `FOREGROUND_SERVICE_SPECIAL_USE`.

What this target still ships for Pixel/Google Android entry points:

- `res/xml/shortcuts.xml` registered from `MainActivity` with
  `android.app.shortcuts`.
- App Actions capabilities for the supported BIIs `OPEN_APP_FEATURE`,
  `CREATE_MESSAGE`, and `GET_THING`. These cover chat/ask, voice,
  LifeOps daily brief, LifeOps task creation, and LifeOps task lists by
  opening source-tagged deep links in the app.
- `OPEN_APP_FEATURE` uses inline inventory for known features and keeps a
  no-parameter fallback fulfillment, as required by the App Actions
  `shortcuts.xml` schema.
- Static launcher/Assistant shortcuts for chat, voice, daily brief, new
  task, and tasks.

Entry-point mapping:

| User flow | Android surface | Fulfillment |
|---|---|---|
| Ask or chat with Eliza | `CREATE_MESSAGE` for message text, `GET_THING` for search-style ask text, plus the chat static shortcut | `elizaos://chat?...` source-tagged deep links |
| Start voice chat | `OPEN_APP_FEATURE` inline inventory plus the voice static shortcut | `elizaos://voice?source=android-static-shortcut` |
| Open LifeOps daily brief | `OPEN_APP_FEATURE` inline inventory plus the daily-brief static shortcut | `elizaos://lifeops/daily-brief?source=android-static-shortcut` |
| Create a LifeOps task | `OPEN_APP_FEATURE` inline inventory plus the new-task static shortcut | `elizaos://lifeops/task/new?source=android-static-shortcut` deep link, then runtime confirmation/planning |
| View LifeOps tasks | `OPEN_APP_FEATURE` inline inventory plus the tasks static shortcut | `elizaos://lifeops/tasks?source=android-static-shortcut` |

There is no general third-party "be Gemini/default assistant" API for the
Play build. Current Android docs route normal app voice entry through
App Actions capabilities in `shortcuts.xml` and Android shortcuts; custom
Gemini/Assistant intent formats documented for navigation apps are
navigation-specific, not a general assistant surface for this app.

The Play build intentionally does not request default-assistant or
system-only powers. It has no `ACTION_ASSIST`, `VOICE_COMMAND`,
`ROLE_ASSISTANT`, `BIND_VOICE_INTERACTION`, usage-stats appop, SMS/call
default-role components, boot receiver, MediaProjection foreground
service, or special-use foreground service. Gemini/Assistant
interoperability for this target is through Google App Actions and
Android shortcuts, not by trying to become the device's default
assistant. Do not add unsupported BIIs such as `actions.intent.CREATE_THING`;
task creation is modeled as opening the LifeOps task feature.

Build-time flag set: `VITE_ELIZA_ANDROID_RUNTIME_MODE=cloud`. The
renderer reads this via
[`packages/ui/src/platform/android-runtime.ts`](../../../ui/src/platform/android-runtime.ts)
and the `RuntimeSettingsSection` hides the Local picker option so users
cannot try to provision an on-device agent that physically isn't there.

## `build:android:lp3-cloud:debug` — direct LP3 Cloud APK

```bash
bun run --cwd packages/app build:android:lp3-cloud:debug
```

This explicit direct-distribution variant keeps the Cloud-only renderer but
adds the Light Phone III display-color guard from issue #16888. It is not a
Play artifact: the build preserves a `specialUse` foreground service, boot
receiver, and `WRITE_SECURE_SETTINGS` solely when
`ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED=1`. Ordinary `android-cloud` and
`android-cloud-debug` builds strip the components, Java sources, and all three
direct-only policy permissions. The overlay also repeats the shared
`POST_NOTIFICATIONS` declaration because the color guard will not run without
a visible foreground notification on Android 13 and newer.

The build flag alone cannot activate the guard. On a Light/TLP301 device, the
operator must grant the declared privileged permission, then send the explicit
enable command as the debuggable app's own UID. The unexported receiver stores
the opt-in in device-protected private preferences:

```bash
adb shell pm grant ai.elizaos.app android.permission.WRITE_SECURE_SETTINGS
adb shell pm grant ai.elizaos.app android.permission.POST_NOTIFICATIONS
adb shell am start -W -n ai.elizaos.app/.MainActivity
adb shell dumpsys activity activities | grep topResumedActivity
adb shell run-as ai.elizaos.app am broadcast \
  -n ai.elizaos.app/ai.elizaos.app.Lp3ColorPolicyBootReceiver \
  -a ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY
```

Confirm that `topResumedActivity` names `ai.elizaos.app/.MainActivity` before
sending `ENABLE`. Android 12+ can deny a foreground-service start from a custom
background broadcast. If that happens, the receiver keeps the durable opt-in
but logcat records `foreground guard start failed`. A private process
initializer retries automatically when MainActivity resumes, where Android
permits the user-visible foreground-service start. If notification permission
was not pre-granted, that initializer requests it only after the build, LP3,
opt-in, and `WRITE_SECURE_SETTINGS` gates pass, then retries after consent.
The guard also requires notifications to remain enabled for the app and for the
`lp3_color_policy` channel. Android reports either block through protected
system broadcasts: the service cancels pending repairs and stops immediately,
then the process initializer retries after the operator unblocks notifications.
A channel/app block never triggers another `POST_NOTIFICATIONS` prompt.
Never treat the preference write alone as proof that the guard is running.

Verify the service, repair result, and final SettingsProvider state before
calling the device durable:

```bash
adb logcat -d -s ElizaLp3Color:I '*:S'
adb shell dumpsys activity services ai.elizaos.app | grep Lp3ColorPolicyService
adb shell dumpsys package ai.elizaos.app | grep -A2 POST_NOTIFICATIONS
adb shell dumpsys notification --noredact | grep -A8 -B4 lp3_color_policy
adb shell settings get secure accessibility_display_daltonizer_enabled
adb shell settings get secure accessibility_display_daltonizer
```

The final two values must be `0` and `-1`. Reboot the device and repeat those
checks; the boot receiver plus observer are what prove persistence beyond the
one-time repair. The package dump must show `POST_NOTIFICATIONS: granted=true`,
the app notification state must be enabled, and the `lp3_color_policy` channel
must have nonzero importance. The notification drawer must also show the
ongoing “Eliza display color” notification; otherwise the service is not
allowed to claim a durable, user-visible guard. Exercise app-level block,
channel-level block, and unblock before release: both block paths must stop the
service without changing either daltonizer value, while unblock plus returning
to Eliza must restore the visible service without a permission-prompt loop.

To disable it cleanly, send the matching same-UID command:

```bash
adb shell run-as ai.elizaos.app am broadcast \
  -n ai.elizaos.app/ai.elizaos.app.Lp3ColorPolicyBootReceiver \
  -a ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY
```

`SYNC_LP3_COLOR_POLICY` re-evaluates the existing private opt-in without
changing it. `run-as` requires a debuggable direct build and makes the sender
the app UID; ordinary apps cannot reach the unexported receiver. The private
state survives reboot and in-place update, but correctly disappears on app
data clear or uninstall. Unknown actions are ignored.

The direct debug APK can also use an adb-reversed Mac runtime without weakening
the Cloud/Play network policy. Its isolated debug source set permits cleartext
only for `127.0.0.1` and `localhost`; the base policy remains deny-by-default.
Use a phone-side port other than `31337`, because that port is the canonical
identity of the bundled Android agent:

```bash
adb reverse tcp:31338 tcp:31337
adb shell am start -W -a android.intent.action.VIEW \
  -d 'elizaos://first-run/runtime/remote?api=http%3A%2F%2F127.0.0.1%3A31338' \
  ai.elizaos.app
```

When all gates pass, a low-importance ongoing notification makes the lifecycle
honest and lets the service observe only Android's two daltonizer keys. It
writes `accessibility_display_daltonizer_enabled=0` and
`accessibility_display_daltonizer=-1` only when either value is wrong.
`BOOT_COMPLETED` and package-replacement delivery reapply the same gate; a
force-stopped Android app cannot receive boot broadcasts until the user
launches it again, by platform design. The unexported process initializer closes
that gap on the first normal relaunch and performs the same device, opt-in,
secure-settings, and notification-permission checks before restarting the
guard. App-level and channel-level notification disclosure are separate gates;
the service rechecks them immediately after first creating its channel so a
restored user-blocked channel can never leave an invisible guard running.

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

For the retail digital-assistant integration the sideload/AOSP builds also
ship a `VoiceInteractionService` trio — `ElizaVoiceInteractionService`
(the assistant), `ElizaVoiceInteractionSessionService` +
`ElizaVoiceInteractionSession` (the ChatGPT-style overlay voice bar that
hands off via `elizaos://voice?source=android-assistant-session`), and
`ElizaRecognitionService` (required by the VIS contract) — declared with
`BIND_VOICE_INTERACTION` and wired through
[`res/xml/eliza_voice_interaction_service.xml`](app/src/main/res/xml/eliza_voice_interaction_service.xml).
This is what surfaces Eliza under Settings → Apps → Default apps → Digital
assistant app and lets the assist gesture / long-press-power invoke it.
Users request the role at runtime through the `@elizaos/capacitor-system`
bridge (`System.requestRole({ role: "assistant" })`, surfaced in the
Device Settings overlay). The Play build strips all four components. The
matching AOSP ROM glue that pre-grants the role for the VIS is follow-up
sub-issue 6 of #12185.

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
input control, and the AOSP-only accessibility and notification-listener
service declarations.

The release APK is staged into the `elizaOS/os` checkout at
`$ELIZAOS_OS_REPO_ROOT/packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk`
(or the brand-aware vendor dir resolved from `app.config.ts > aosp:`). When the
environment variable is unset, the build uses a sibling `../os` checkout.

## Pinned debug signing key

Debug APKs use one repository-managed, non-production signing key so `adb install -r` works across CI and local rebuilds. Debug keystores are public development credentials, not release secrets. The release signing path remains separate and secret-backed.

CI restores the key from the `ELIZA_ANDROID_DEBUG_KEYSTORE_BASE64` repository variable. For a local build, install the same key once with GitHub CLI access:

```bash
mkdir -p "$HOME/.android"
gh variable get ELIZA_ANDROID_DEBUG_KEYSTORE_BASE64 -R elizaOS/eliza \
  | base64 -d > "$HOME/.android/eliza-debug.keystore"
chmod 600 "$HOME/.android/eliza-debug.keystore"
```

To keep it elsewhere, set `ELIZAOS_DEBUG_KEYSTORE_PATH` to the decoded keystore path. The fixed debug alias is `androiddebugkey`; store and key passwords are the conventional Android debug password, `android`. When the pinned file is absent, Gradle warns and falls back to its machine-local debug identity so unrelated Android workflows remain usable; those APKs are not guaranteed to upgrade CI artifacts in place.
