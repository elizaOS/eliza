# #10196 — permission-gate fixes verified on real hardware (before/after)

The console sweep found 3 native-data views logging a Capacitor permission
rejection (`console.error`). After gating their reads on `checkPermissions()`,
I **rebuilt the APK with the fixes, installed it on the emulator in the same
permission-denied state, and re-ran the sweep**. This is the on-hardware
before/after — not a unit test of the gate, the actual rebuilt app.

## Before → After (emulator, READ_CONTACTS/READ_SMS/READ_CALL_LOG all denied)

| Route | Before (shipped APK) | After (rebuilt APK with fixes) |
|---|---|---|
| `/contacts` | `console.error: READ_CONTACTS permission is required` | **CLEAN** |
| `/messages` | `console.error: READ_SMS permission is required` | **CLEAN** |
| `/phone` | `console.error: READ_CALL_LOG` + `READ_CONTACTS` | **CLEAN** |

All other 49 views: clean before and after. Full sweep re-run: **0 permission
console-errors across all 52 views.**

## What the fix does (visible in the screenshots)

Instead of calling the native read and letting it reject (which Capacitor's
`handleError` logs), the view now checks/requests permission first and, when not
granted, renders a **user-facing permission-needed message** and skips the
native call — so nothing rejects and nothing is logged.

- `after-fix-shots/02-messages.png` — `/messages`: the Compose form renders with
  *"SMS permission is required. Grant Messages access to read your texts, then
  retry."* (a styled in-UI message, **not** a console error).
- `after-fix-shots/03-phone.png` — `/phone`: the phone workspace renders with
  *"Phone and Contacts permissions are required to load recent calls and your
  address book."* — the combined message from gating both the call-log and the
  address-book read.
- `after-fix-shots/01-contacts.png` — `/contacts`: the contacts form renders
  clean.
- `after-fix-shots/00-home.png`, `04-home-after-walk.png` — home before/after
  the walk.
- `after-fix-shots/view-walk.mp4` — screenrecord of the on-device walk across
  the views.

## Build/verify notes

- APK rebuilt from this tree: `ELIZA_MOBILE_REPO_ROOT=<eliza> ELIZA_WEBVIEW_DEBUG=1
  ELIZA_BUN_RISCV64_OPTIONAL=1 bun run --cwd packages/app build:android`, then
  `./gradlew :app:assembleDebug` directly (the full `build:android` aborts on an
  unrelated pre-existing `compileDebugUnitTestKotlin`/junit gap in the native
  capacitor modules' JVM unit tests, which the APK does not need).
- The sweep dismisses the system permission dialog the new `requestPermissions()`
  call surfaces (`input keyevent BACK`), then confirms no console error fired —
  i.e. even when the user declines, the view degrades cleanly.
- Two distinct mounts read these APIs and both are now gated: the
  `ElizaOsAppsView` contacts/messages/phone surfaces (this fix) and the
  standalone `plugin-phone` `PhoneView` (the `status?.phone` null-guard fix).
