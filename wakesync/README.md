# wakesync personal device lane

Branch: `sol/main` on `elizaOS/eliza`. Base: `develop`, rebased daily. Tracking issue: elizaOS/eliza#31339.
Goal: Eliza as the daily driver on a second phone (Pixel 11 Pro) and a companion iOS build, developed locally on the new Mac with the Codex Mac app. No SSH into the Mac, no VPS agent access to it. Sync is git + Discord only.

This folder holds the lane docs and receipts. Nothing in `wakesync/` is upstream-bound; it is deleted from any PR cut for `develop`.

---

## 0. Not stepping on toes (read before touching anything)

The Alpha Phone program owns the mainline Android/AOSP work right now. Their open issues, owners and dates:

| Issue | Owner | Window | Scope |
|---|---|---|---|
| #31018 Nitro deployment | Nubs | Sep 14-17 | Alpha enclave agent deployment |
| #31021 Phone pairing | Nubs | 2d after #31018 | cloud-only APK profile, pairing, auth contract |
| #31022 Assistant routines | Nubs | 1d after #31021 | scheduler routines, offline delivery |
| #31023 Pixel AOSP | Shaw | Sep 18-24 | AOSP image on Pixel 10 (11 only if validated) |
| #31024 SMS and calls | Nubs | 5d | Blooio gateway + native SMS/calls |
| #31025 Four-phone rollout | Nubs | 2d | provisioning 4 devices |
| #30844 Android fixes + final build | Nubs | Sep 18, 21 | Cloud APK stability, ConnectionMonitor |
| #31034 Alpha design and branding | Shaw | | |
| #31037 Final Alpha Phone QA | Shaw + Nubs | Oct 13-14 | |

Rules that follow from that:

1. **Do not touch** `build:android:cloud` / `android-cloud-debug` (the Play/Alpha thin client), its capability allowlist, `ConnectionMonitor`, pairing, `packages/cloud/**`, Blooio, SMS/dialer code, or anything under `elizaOS/os`. That is all theirs and mid-flight.
2. **Our lanes are `build:android` (sideload) and `build:android:launcher`** on a stock Pixel. Everything we add is stripped from the Play lane by the existing lane-strip mechanism in `run-mobile-build.mjs`. `android-cloud-audit` must stay green after every manifest/Java change.
3. **No flashing until Shaw's #31023 image exists or Graphene posts Pixel 11 support.** We stay on stock + unlocked bootloader. Their AOSP image is what we flash later, not our own.
4. **Calendar:** Shaw has been in `plugin-calendar` and the calendar UI every day for two weeks (#31003 open). Our calendar work is the **Android native bridge only** (CalendarContract read/write, mirroring `plugin-native-calendar`'s EventKit surface). We do not touch the agent-side calendar planner, sync destinations, or the calendar view.
5. **Everything lands on `sol/main` first.** Upstream PRs are cut per capability, one consolidated PR with tests, as drafts against `develop`. A human merges. No auto-merge, no check weakening, no `gh pr edit` (use `gh api -X PATCH`).
6. Never `wakesync.dev`. Git identity on the Mac: `Shadow <shadow@shad0w.xyz>`.
7. Bug fixes need bidirectional proof (test fails on clean `develop`, passes with the fix). Features need device evidence (screenshot / screenrecord / logcat) saved under `wakesync/receipts/`.
8. If something in a workstream already exists on `develop`, extend it, don't duplicate it. Grep first.

---

## 1. Mac setup (M5 Pro, 48GB, clean)

```bash
# Xcode: install full Xcode from the App Store first (needed for iOS + simulators), then:
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch

# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install git gh bun node@22 openjdk@21 android-commandlinetools cocoapods ripgrep jq
brew install --cask android-studio android-platform-tools

# ~/.zshrc
cat >> ~/.zshrc <<'EOF'
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:/opt/homebrew/opt/node@22/bin:$PATH"
EOF
source ~/.zshrc
java -version   # must say 21
```

Gradle heap (default 2g is why Android builds crawl on big machines):

```bash
mkdir -p ~/.gradle && cat > ~/.gradle/gradle.properties <<'EOF'
org.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=1g
org.gradle.parallel=true
org.gradle.caching=true
EOF
```

SDK packages (open Android Studio once so it creates `$ANDROID_HOME`, then):

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
  "emulator" "system-images;android-36;google_apis;arm64-v8a"
```

`gh auth login` as `wakesync`. SSH key for GitHub: generate a new one on this Mac, add it to the wakesync account. Do not copy keys from the old Mac.

---

## 2. Repo

```bash
mkdir -p ~/src && cd ~/src
git clone git@github.com:elizaOS/eliza.git && cd eliza
git config user.name "Shadow" && git config user.email "shadow@shad0w.xyz"
git config user.email   # verify before the first commit
git checkout sol/main
bun install
bun run dev:prepare      # builds the workspace packages the app depends on
```

Branch model:

- `sol/main`: integration branch. Rebased on `origin/develop` daily by a cron on the VPS. **Never force-push it from the Mac.** Pull with `git pull --rebase origin sol/main` before starting work each day.
- `sol/<topic>`: your working branches, cut from `sol/main`. Push these; Sol reviews from the VPS and merges into `sol/main`. If you want to merge yourself, `--ff-only` or a merge commit, no squash, so the topic history survives.
- `codex/<topic>-<yyyymmdd>`: what the Codex Mac app cuts. Same treatment as `sol/<topic>`.
- Upstream PR branches are cut by Sol from `sol/main`, named `sol/upstream-<capability>`.

Sanity check that the tree builds before touching anything:

```bash
bun run --cwd packages/app-core typecheck
```

---

## 3. Pixel 11 Pro hookup (stock, no flash)

On the phone:

1. Settings > About phone > tap Build number 7x. Developer options appears.
2. Developer options > **OEM unlocking: ON**. Do this now while the phone is stock and online; it needs one network check with Google and later you'll be stuck waiting if it's off. This does not unlock the bootloader, it only permits it.
3. Developer options > USB debugging: ON. Also "Stay awake" ON while charging.
4. Sign the phone into the Google account you want Eliza to see (see §7 on real vs burner).

On the Mac:

```bash
adb devices          # accept the RSA prompt on the phone; state must be "device", not "unauthorized"
adb shell getprop ro.product.model ro.build.version.release ro.build.version.sdk
export ANDROID_SERIAL=$(adb devices | awk 'NR==2{print $1}')   # pin it so the emulator never steals installs
```

Keep an AVD too, for the wipe-data first-install passes and for anything you don't want on the real phone yet:

```bash
avdmanager create avd -n eliza-pixel-clean -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_9_pro
```

---

## 4. First build + install (sideload lane)

```bash
cd ~/src/eliza
bun run build:android                     # sideload: on-device Bun agent, ~95MB/ABI, slow first time
adb install -r packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.elizaos.app/.MainActivity
```

Launcher lane (cloud-safe surface + HOME role):

```bash
bun run build:android:launcher
bun run install:android:launcher          # installs and prompts for the Home role
adb shell cmd role get-role-holders --user 0 android.app.role.HOME   # expect ai.elizaos.app
```

Backend for the app. Two options:

- **Remote agent (fastest).** In onboarding pick the remote-host path and point it at your cloud agent, or at sol-dev (`https://sol-dev.shad0w.xyz`, Sol will hand you a device token in Discord when you get here). You're then debugging the phone, not inference.
- **Local on-device agent.** The sideload build ships it. Slower to iterate, but it's the real "personal device" shape. Use it once the surfaces work.

Read `packages/app-core/platforms/android/README.md` end to end before the first native change. It documents every build target and what gets stripped where.

Baseline QA on the phone, so you know what green looks like on clean `sol/main` before any change (save output to `wakesync/receipts/B-baseline/`):

```bash
cd packages/app
bun run test:e2e:android:onboarding
bun run test:e2e:android:native-plugin-view
bun run test:e2e:android:launcher-loop
bun run test:e2e:android:touch-gesture
bun run test:e2e:android:sleep-wake
bun run test:e2e:android:lifecycle
bun run test:e2e:android:lifecycle:reboot   # LAST, reboots the phone
bun run test:e2e:android:assistant           # assistant role verification
```

Anything red on clean `sol/main` gets recorded (device limitation vs real bug). Real bugs become their own small PR, separate from feature work.

---

## 5. iOS companion

`packages/app-core/platforms/ios` is already a full Capacitor app (Xcode project, fastlane, BroadcastExtension). "Companion iOS app" = the same app-core shell built for your iPhone. EventKit calendar bridge (`plugins/plugin-native-calendar`) already exists for it.

```bash
cd packages/app
bun run build:ios:cloud:sim               # simulator, cloud-backed, quickest
bun run build:ios:cloud:device            # real iPhone, needs your Apple dev team in Xcode signing
bun run ios:device:provision              # helper for device provisioning
```

Open `packages/app-core/platforms/ios/App/App.xcworkspace` in Xcode for signing and simulator runs. Use your personal Apple ID team for dev signing; no App Store / TestFlight uploads from this lane.

---

## 6. Codex Mac app

Open the repo at `~/src/eliza` in the Codex Mac app with computer use enabled. Give it this file plus `wakesync/CODEX-BRIEF.md` as the task. Let it:

- run the env + build + baseline phases itself (computer use for SDK installers, Android Studio, consent dialogs on the phone screen mirrored via `scrcpy`: `brew install scrcpy`)
- work each workstream on its own `codex/<topic>-<date>` branch cut from `sol/main`
- write receipts under `wakesync/receipts/` and push the branch

Do **not** let it: merge anything, push to `sol/main` or `develop`, touch the Play/Alpha lane, touch `packages/cloud/**`, or bypass a consent grant with computer use (the grant flow is the product surface; document it).

`scrcpy -s $ANDROID_SERIAL` mirrors the Pixel to the Mac so Codex can see and tap it.

---

## 7. Workstreams (this is the product)

Detailed specs are in `wakesync/CODEX-BRIEF.md`. Order:

- **W1 notifications out.** Eliza posts real Android notifications: channels, inline reply, full-screen intent for urgent. Bridge in `SafePushNotificationsPlugin` / `@elizaos/capacitor-system`.
- **W2 notifications in.** `ElizaNotificationListenerService` from stub to real: parse, per-app allowlist (default empty), forward to agent as `notification_observed`. Stripped from Play lane.
- **W3 launcher.** App drawer, HOME re-delivery, wallpaper passthrough, boot-to-Eliza. Make the home surface livable.
- **W4 calendar bridge (Android).** New Capacitor plugin mirroring `plugin-native-calendar`'s method surface (`checkPermissions`, `listCalendars`, `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`) on top of `CalendarContract`. `ElizaCalendarActivity` already routes system calendar intents to `elizaos://calendar`; this gives that route real data. Read-only until tests exist, then write.
- **W5 lock screen.** Full-screen intent + show-when-locked voice surface. Honest about what a non-system APK can do; the keyguard takeover list goes in a followup receipt for the flash phase.
- **W6 iOS parity pass.** Same surfaces on the iPhone build where iOS allows (notifications, calendar via EventKit, Siri shortcut). Lock screen and launcher are not possible on iOS; record it and move on.

Real vs burner account on the Pixel: real. It's the only way the listener and calendar get real signal. Calendar bridge stays read-only until W4 has tests. Nothing from the phone leaves the phone except to the agent backend you configured.

---

## 8. Sync without SSH

- Push `sol/<topic>` / `codex/<topic>` branches. Sol reviews from the VPS, merges to `sol/main`, cuts upstream PRs, runs the rebase cron.
- Receipts go in `wakesync/receipts/` on the branch. That's how Sol sees device evidence.
- Blockers, questions, tokens: Discord #cc-eliza.
- Sol never gets a shell on this Mac. The Mac never gets keys to the VPS. Old Mac keeps the Codex reverse tunnel and Strata; this Mac is Eliza only.

---

## 9. Old Mac vs new Mac

New Mac. Reasons:

1. Firewall by construction. Old Mac has the VPS reverse tunnel, Strata credentials and history. Strata is nearing prod; the Eliza personal-device lane pulling in a phone with your real accounts should not share a machine with that. Two machines, two worlds, nothing to leak.
2. Xcode needs current macOS. The old Mac needs the OS update anyway; not worth blocking on.
3. Codex computer use on a machine Sol can't reach is the right trust shape for a device that holds your calendar and notifications.

Old Mac stays: Strata, Codex loop tunnel, JJ-side work. New Mac: Eliza, Pixel, iPhone. Never cross-clone.
