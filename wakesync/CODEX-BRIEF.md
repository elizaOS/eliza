# Codex brief: Eliza personal device, phase 1 (Pixel 11 Pro on stock, iPhone companion)

You are Codex running on Shadow's Mac (M5 Pro, 48GB) with computer use. Repo is `~/src/eliza`, branch `sol/main`. Read `wakesync/README.md` first: environment setup, branch model, and the list of areas owned by other people that you must not touch. This file is the work.

Goal of this phase: make the Eliza sideload/launcher build livable as the daily surface on a stock Pixel 11 Pro, with real notifications, real calendar, and a home screen, and get the same surfaces on the iPhone build where iOS allows. The AOSP flash comes later, from an existing image; nothing here blocks on it.

Read this whole file before doing anything. Then work top to bottom. Every phase ends with a receipt you write to disk. Never report a phase done without the receipt's evidence existing.

---

## 0. Ground rules (non-negotiable)

- Base branch is `sol/main`, not `develop`. Start every day with `git pull --rebase origin sol/main`. Cut `codex/<topic>-$(date +%Y%m%d)` from it, one per workstream. Rebase, don't merge, when `sol/main` moves.
- **You push topic branches. You never merge, never push to `sol/main` or `develop`, never open a PR against `develop`.** Sol merges into `sol/main` and cuts the upstream PRs.
- The real phone is `$ANDROID_SERIAL` (Shadow's Pixel 11 Pro, real Google account). Destructive specs (`lifecycle`, `lifecycle:reboot`, `-wipe-data`, calendar writes) run on the `eliza-pixel-clean` AVD only. Never clear app data or write to the calendar on the real phone unless a step says so.
- Off limits (owned and active elsewhere, see README §0): `build:android:cloud` / `android-cloud-debug` and the capability allowlist, `ConnectionMonitor`, pairing, `packages/cloud/**`, Blooio, SMS/dialer code, `plugins/plugin-calendar`, the calendar view in `packages/app`, `elizaOS/os`.
- Git identity for commits: `Shadow <shadow@shad0w.xyz>`. Never `wakesync.dev`. Verify with `git config user.email` in the checkout before the first commit.
- **No weakening or skipping CI checks. No production deploys. No Play Store or TestFlight uploads.**
- Do not touch Telegram adapter files (another contributor owns them). Do not touch `packages/cloud/**` unless a notification feature strictly needs a server-side endpoint, and then keep it to one small, tested change.
- The **Play Store thin client** (`build:android:cloud`) has a hard capability allowlist enforced at build time (see `packages/app-core/platforms/android/README.md`). Do not add permissions or components to that lane. Everything in this brief lands in the **sideload** and **launcher** lanes, gated behind the existing build-target split.
- Bug fixes need bidirectional proof: the new test fails on clean `sol/main`, passes with the fix. Feature work needs a device-visible proof (screenshot, screenrecord, or logcat excerpt) saved as an artifact.
- Prefer small commits with a one-line "why". Never rewrite history that has been pushed.
- When you are blocked on something only a human can do (a consent dialog on a physical device, a Play console, a secret), write the exact blocker in the receipt and stop that workstream. Do not fabricate.

---

## 1. Repo map (what already exists, so you don't rebuild it)

Most of the Android substrate already exists. Read these before writing code:

| Thing | Path |
|---|---|
| Android build targets doc (READ FIRST) | `packages/app-core/platforms/android/README.md` |
| Build orchestrator (all Android targets) | `packages/app-core/scripts/run-mobile-build.mjs` |
| Native Android app (Capacitor host + services) | `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/` |
| Manifest (all permissions + components, lane-stripped at build) | `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml` |
| Gradle versions | `packages/app-core/platforms/android/variables.gradle` (minSdk 26, compile/target 36, AGP 8.13, Gradle 9.5, Kotlin 2.2.20, **JDK 21 required**) |
| Device e2e harness (Playwright Android driver + adb) | `packages/app/test/android/` and `packages/app/test/android/README.md` |
| E2E orchestrator | `packages/app/scripts/android-e2e.mjs` |
| Computer-use constraints on Android | `plugins/plugin-computeruse/docs/ANDROID_CONSTRAINTS.md`, `AOSP_SYSTEM_APP.md` |
| AOSP track docs | `packages/docs/tracks/elizaos/aosp.mdx`, and the separate `elizaOS/os` repo |
| Play capability inventory | `packages/app-core/docs/android-play-capability-inventory.md` |
| iOS app (Xcode workspace, fastlane) | `packages/app-core/platforms/ios/App/` |
| iOS EventKit calendar plugin (the surface C4 mirrors) | `plugins/plugin-native-calendar` |
| System calendar intent router (exists, routes to `elizaos://calendar`) | `ai/elizaos/app/ElizaCalendarActivity.java` |

Existing native pieces relevant to this brief:

- `MainActivity` already declares the `MAIN + HOME + DEFAULT` intent filter, so **Eliza can already be selected as the Home app (ROLE_HOME)** via `bun run install:android:launcher`. The launcher workstream is about making the *home surface* good, not about registering the role.
- `ElizaNotificationListenerService` exists but is a **stub** (logs package name on post/remove, nothing else). This is your starting point for inbound notification awareness.
- `SafePushNotificationsPlugin`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `ElizaBootReceiver`, `ElizaAgentService` (foreground service), `ElizaVoiceTileService` (quick settings tile), `ElizaAssistActivity` + the `VoiceInteractionService` trio (assistant role, long-press power), `ElizaQuickActionsWidgetProvider` (home widget), `SYSTEM_ALERT_WINDOW`, `ElizaAccessibilityService`.
- Build targets: `build:android` (sideload, on-device Bun agent, ~95MB per ABI, AOSP-aimed permissions), `build:android:launcher` (cloud-safe surface + HOME role), `build:android:cloud` / `android-cloud-debug` (Play thin client, allowlisted), `build:android:system` (platform-signed for AOSP priv-app; needs `elizaOS/os` checkout).

Grep before building anything: `rg -n "showWhenLocked|KeyguardManager|FullScreenIntent|NotificationListener|ROLE_HOME|CalendarContract" packages/app-core packages/app plugins`. If something in this brief already exists on `sol/main`, extend it, don't duplicate it.

---

## 2. Phase A: environment (computer use allowed)

Follow `wakesync/README.md` §1 to §5 exactly (Mac toolchain, Gradle heap, SDK, repo on `sol/main`, Pixel hookup with OEM-unlock toggle, first sideload + launcher build, iOS sim build). Keep one AVD (`eliza-pixel-clean`, arm64-v8a, google_apis) for destructive runs.

Done when: `bun run build:android` and `bun run build:android:launcher` both succeed, the APK is on the Pixel, `adb shell cmd role get-role-holders --user 0 android.app.role.HOME` returns `ai.elizaos.app`, and `bun run --cwd packages/app build:ios:cloud:sim` boots in the simulator.

Backend: point onboarding at a remote agent first (sol-dev token comes from Sol in Discord) so you're debugging the phone, not inference. Switch to the on-device agent once the surfaces work.

Receipt `wakesync/receipts/A-env.md`: macOS + chip, Xcode/JDK/Gradle/AGP/bun/node versions, SDK packages, phone `adb shell getprop ro.product.model ro.build.version.release ro.build.version.sdk`, the `sol/main` SHA you started from, wall time of first `build:android`, and `adb exec-out screencap -p > wakesync/receipts/A-home.png`.

---

## 3. Phase B: baseline QA, no code changes yet

Run the suite from `wakesync/README.md` §4 against the phone; `lifecycle`, `lifecycle:reboot` and anything with `-wipe-data` against the AVD. Save per-spec pass/fail + reason to `wakesync/receipts/B-baseline/`.

Also verify the launcher loop on the phone: `bun run install:android:launcher`, complete the Home-role consent (via scrcpy), then:
```
adb shell cmd role get-role-holders --user 0 android.app.role.HOME
adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME
```
Record which specs fail on clean `sol/main` and why (device limitation vs real bug). Real bugs become their own small branch with a bidirectional test, separate from the workstreams.

---

## 4. Phase C: workstreams (each on its own `codex/<topic>-<yyyymmdd>` branch cut from `sol/main`, pushed, never merged by you)

Order: C1 notifications outbound, C2 notifications inbound, C3 launcher home surface, C4 calendar bridge, C5 lock screen, C6 iOS parity. C1, C3 and C4 are the demo-able wins on a real phone; C5 has the most Android policy landmines, do it after C4.

Design the feature flags so every one of these is **off in the Play lane** and **on in sideload/launcher/system lanes**. Use the existing lane-strip mechanism in `run-mobile-build.mjs` (`ANDROID_CLOUD_STRIPPED_JAVA_FILES` etc.) rather than runtime `if`s, so the Play artifact audit keeps passing.

### C1. Eliza posts real system notifications

What "done" looks like: the agent (local or cloud) can push a message that lands as a proper Android notification with a channel, an icon, an inline reply action, and (for urgent items) a full-screen intent that wakes the screen.

- Notification channels: `eliza.messages` (default importance, inline `RemoteInput` reply), `eliza.reminders` (high), `eliza.urgent` (high + full-screen intent + `setCategory(CATEGORY_CALL or ALARM)`), `eliza.ongoing` (low, for the foreground service). Register on `ElizaApplication.onCreate`.
- Runtime `POST_NOTIFICATIONS` prompt on API 33+ during onboarding, with a clear rationale screen in the WebView first.
- Bridge: extend `SafePushNotificationsPlugin` (or add a `NativeNotificationsPlugin` under `@elizaos/capacitor-system`) so JS can call `notify({channel, title, body, replyable, fullScreen})` and receive `onReply({notificationId, text})` events that route into the normal chat message path.
- Delivery source: for the local-agent lane, hook where the agent emits a proactive message (scheduler/LifeOps reminders already exist; find the emit point in `packages/app-core/src`). For the cloud lane use whatever push path exists; if none, ship the local-agent path and file the cloud gap in the receipt.
- Tests: JVM unit test for channel registration and reply-intent construction; one `*.android.spec.ts` that triggers a notification via the agent API, asserts it via `adb shell dumpsys notification --noredact | grep eliza`, taps it via `adb shell input`, and screenshots the result.
- Receipt: `wakesync/receipts/C1-notifications.md` with dumpsys excerpt, screenshot of the notification shade, screenrecord of an inline reply round-tripping to chat.

### C2. Eliza reads notifications (inbound awareness)

What "done" looks like: with the listener enabled, other apps' notifications become structured events the agent can see and summarize, with a per-app allowlist and no silent data hoarding.

- Flesh out `ElizaNotificationListenerService`: parse `title`, `text`, `bigText`, `subText`, `package`, `postTime`, `category`, `people`; drop anything from `ai.elizaos.app` itself; drop ongoing/system notifications by default.
- Per-package allowlist stored in app prefs, default empty, managed from a Device Settings screen in the WebView. Nothing is captured until the user allowlists a package. Log counts, never bodies, at info level.
- Forward events to the agent via the existing native bridge (`ElizaNativeBridge` / `AgentPlugin`) as a `notification_observed` event with a bounded queue (drop oldest past 200 pending).
- Onboarding flow into `Settings > Notification access` via `ACTION_NOTIFICATION_LISTENER_SETTINGS`, and detection of whether access is granted (`NotificationManagerCompat.getEnabledListenerPackages`). Surface state in the settings screen.
- Tests: JVM unit test for the parser + allowlist filter; device spec that posts a test notification from a helper (`adb shell cmd notification post -S bigtext -t 'Test' tag 'hello'`), allowlists `com.android.shell`, and asserts the event arrives at the agent.
- Play lane: this service and `BIND_NOTIFICATION_LISTENER_SERVICE` **must stay stripped**. Confirm `android-cloud-audit` still passes.
- Receipt: `wakesync/receipts/C2-notification-listener.md`.

### C3. Eliza as the home launcher (surface quality)

The role plumbing exists; the missing piece is a home surface that is actually livable as a launcher on a real phone.

- Audit what `MainActivity` shows when it is the HOME holder and the user presses Home: cold-start time, whether the WebView is already warm, whether back is swallowed correctly (a launcher must not exit on Back).
- Minimum launcher features to add, in this order:
  1. App drawer: query `PackageManager` for `LAUNCHER` activities, expose via a native plugin (`listApps`, `launchApp(package)`, app icons as cached PNG data URLs), render a simple searchable grid in the WebView. Handle `ACTION_PACKAGE_ADDED/REMOVED` to refresh.
  2. Handle `ACTION_MAIN + HOME` re-delivery (`onNewIntent`) to return to the chat/home view rather than whatever route was open.
  3. Wallpaper passthrough (`android:windowShowWallpaper="true"` on the launcher theme) so it feels native.
  4. Persist launcher mode so Boot -> Eliza home works without the app being opened first (BootReceiver exists).
- Keep the existing `launcher-gesture-loop.android.spec.ts` green and add one spec for the app drawer (list, search, launch Settings, come back Home).
- Receipt: `wakesync/receipts/C3-launcher.md` with screenrecord of: boot -> Eliza is home -> open drawer -> launch another app -> press Home -> back on Eliza.

### C4. Android calendar bridge (CalendarContract)

What "done" looks like: the agent can read and (behind a flag) write the phone's calendars through a native bridge with the same method surface as the iOS EventKit plugin, so `elizaos://calendar` shows real events on the Pixel.

- Mirror `plugins/plugin-native-calendar` (EventKit) exactly: `checkPermissions`, `requestPermissions`, `listCalendars`, `listEvents({timeMin,timeMax,calendarId?})`, `createEvent`, `updateEvent`, `deleteEvent`, same result shapes (`ok`, `error`, `message`). Read that plugin's `package.json` and Capacitor config first and follow its layout: either an Android platform branch inside it, or a sibling `@elizaos/capacitor-android-calendar`, whichever the existing pattern supports.
- Android side: `READ_CALENDAR` / `WRITE_CALENDAR` runtime permissions, `CalendarContract.Calendars` + `Events` + `Instances` for expanded recurrences. Attendees read-only (mirror the EventKit limitation note).
- `ELIZA_ANDROID_CALENDAR_WRITE=0` default: `createEvent`/`updateEvent`/`deleteEvent` return `error: "write_disabled"` until the flag is on. Flip it only after the write tests pass on the AVD.
- **Do not touch** `plugins/plugin-calendar` (agent planner/sync, under active development by others), the calendar view in `packages/app`, or sync destinations. This is the native data source only. If the agent side needs a one-line provider registration, keep it to that and call it out in the summary.
- Tests: JVM unit test for the cursor-to-event mapper; device spec that inserts an event on the `eliza-pixel-clean` AVD via `adb shell content insert --uri content://com.android.calendar/events ...`, then asserts `listEvents` returns it. Write tests on the AVD only, never on the real phone.
- Receipt: `wakesync/receipts/C4-calendar.md` with the real-phone read screenshot (redact event titles) and the AVD write proof.

### C5. Lock-screen presence (be honest about what a non-system APK can do)

A normal APK **cannot replace the keyguard**; that is SystemUI and only the AOSP system build can own it. What a sideload APK *can* do on a stock Pixel:

1. **Full-screen intent notifications** (`eliza.urgent`) that wake the screen and show Eliza over the lock screen, using an Activity with `setShowWhenLocked(true)` + `setTurnScreenOn(true)`. On API 34+ `USE_FULL_SCREEN_INTENT` is auto-granted only for call/alarm-style apps; otherwise the user must grant it in settings. Build the settings deep link.
2. **Show-when-locked activity** for a limited "talk to Eliza without unlocking" surface: a `LockScreenVoiceActivity` that is voice-only, shows no private data, and requests `KeyguardManager.requestDismissKeyguard` only when the user taps an action that needs the unlocked app. Treat everything on this surface as public.
3. **Assistant role** (already built: `ElizaVoiceInteractionService`): long-press power on a locked phone invokes the assistant session; verify the existing overlay voice bar works while locked and file gaps.
4. **Quick settings tile** (already built: `ElizaVoiceTileService`): verify it's reachable from the locked shade.
5. **Lock-screen widgets**: Android 15+ ships lock-screen widgets on tablets only; note as not applicable to Pixel phones in the receipt, don't build.

Do items 1 and 2. Verify 3 and 4. For each, prove on the real phone (AVD for the destructive parts) with `adb shell input keyevent KEYCODE_SLEEP`, then trigger, then `adb exec-out screencap`. The device spec should assert the activity is visible over keyguard via `adb shell dumpsys window | grep -E "mShowWhenLocked|mDreamingLockscreen|KeyguardController"`.

The real lock-screen takeover (replacing keyguard, boot-to-Eliza with no launcher chooser, pre-granted roles) is the **AOSP system lane** (`build:android:system` + `elizaOS/os`). Write a short `wakesync/receipts/C5-aosp-followups.md` listing exactly which behaviors need the system image; so the flash phase starts with a checklist.

### C6. iOS parity (after C1 to C4 are on the Pixel)

`bun run --cwd packages/app build:ios:cloud:sim`, then `build:ios:cloud:device` on the iPhone (personal Apple team for signing, no TestFlight). For each Android surface record what iOS allows:

- Notifications out: UNUserNotificationCenter with a reply category (grep the Capacitor push plugin first). No full-screen/lock-screen wake on iOS; Time Sensitive interruption level is the closest. Implement that.
- Notifications in: not possible on iOS. Record and skip.
- Calendar: `plugin-native-calendar` already does EventKit. Verify read on the device; write behind the same flag as Android.
- Launcher / lock screen: not possible. Record and skip. Siri App Intent ("ask Eliza") is the iOS-shaped equivalent; only if App Intents scaffolding already exists in the repo.
- Receipt: `wakesync/receipts/C6-ios.md` with the parity table.

---

## 5. QA loop you run on every change

Make this a script (`wakesync/scripts/android-dev-loop.sh` on the branch) and run it before every commit:

1. `bun run build:android` (or `:launcher` for C3), fail loudly on gradle warnings that are new.
2. `adb -s $ANDROID_SERIAL install -r <apk>` on the phone; on the `eliza-pixel-clean` AVD once per workstream do `emulator -avd eliza-pixel-clean -wipe-data` for a true first-install pass.
3. `adb logcat -c && adb logcat -s ElizaNotifications ElizaAgent ElizaStartupTrace Capacitor AndroidRuntime *:E` into `wakesync/receipts/<phase>/logcat-<ts>.txt` while you exercise the feature.
4. Focused device spec for the workstream, then the full baseline suite from Phase B before opening the PR.
5. `node packages/app-core/scripts/run-mobile-build.mjs android-cloud-audit <aab>` after any manifest/Java change, to prove the Play lane is still clean.
6. `bun run verify` (repo-wide) before the PR; if it's too slow locally, at minimum run the packages you touched and let CI run the rest.
7. Screenshot/screenrecord evidence: `adb shell screenrecord --time-limit 60 /sdcard/r.mp4 && adb pull /sdcard/r.mp4 wakesync/receipts/...`.

Computer-use is for: SDK installers, Android Studio AVD manager, consent dialogs on the emulator (Home role, notification access, full-screen intent), and reading the layout inspector. Do not use computer-use to bypass any grant that a user would have to give; the grant *is* the product surface, so document the flow instead.

---

## 6. Deliverables checklist

- [ ] `wakesync/receipts/A-env.md` + home screenshot
- [ ] `wakesync/receipts/B-baseline/` with per-spec pass/fail on clean develop
- [ ] Branch: C1 notifications outbound (channels, reply, full-screen intent, tests, evidence)
- [ ] Branch: C2 notification listener (parser, allowlist, settings, tests, Play audit green)
- [ ] Branch: C3 launcher app drawer + home re-entry + wallpaper (spec green)
- [ ] Branch: C4 Android calendar bridge (read on phone, write on AVD, flag default off)
- [ ] Branch: C5 show-when-locked voice surface + full-screen intent path (evidence over keyguard)
- [ ] `wakesync/receipts/C5-aosp-followups.md` (the Pixel-flash checklist)
- [ ] Branch: C6 iOS parity + `wakesync/receipts/C6-ios.md`
- [ ] One `wakesync/receipts/<Cn>-summary.md` per branch: what changed, why, how to verify in under 5 minutes, what is verified on the Pixel 11 Pro vs AVD-only. Sol turns these into the upstream PR descriptions.

