# MiladyOS Architecture

The shape of the Milady-as-operating-system path. Companion to `SETUP_AOSP.md` (Cuttlefish bring-up runbook) and `SETUP_REAL_DEVICE.md` (Pixel target runbook).

## Two paths, one APK

The same Capacitor APK ships through two completely different deployment paths:

| Path | Where the APK lives | Who's the launcher | Who handles SMS / Dialer / Assistant |
| --- | --- | --- | --- |
| **App** (`bun run build:android`) | `/data/app/com.miladyai.milady/` (user-installed) | Stock launcher. Milady appears in the app drawer. | Stock apps (Google Phone / Messages) unless the user picks Milady from Settings → Default apps. |
| **OS** (`bun run build:android:system`) | `/system/priv-app/Milady/` (privileged system app) | Milady is the only HOME activity. | Milady, by being the only registered handler — every stock app for those roles is stripped from the build. |

Everything below is the OS path.

## Layer map

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Milady WebView (the user-visible UI)               │
│  Phone, Messages, Contacts, Camera, Clock, Calendar, Browser,       │
│  WiFi/Bluetooth/Display panels (deep-linked into AOSP Settings)     │
└─────────────────────────────────────────────────────────────────────┘
            ▲                                            ▲
            │ Capacitor bridge                           │ deep links
            │                                            │ milady://...
┌─────────────────────────────────────────────────────────────────────┐
│                 Native Java entry points (priv-app)                 │
│  MainActivity (HOME) · MiladyDialActivity (DIAL/CALL)               │
│  MiladySmsReceiver/SmsCompose/RespondViaMessage/MmsReceiver         │
│  MiladyAssistActivity (ASSIST) · MiladyInCallService (call lifecycle)│
│  MiladyBrowserActivity (http/https) · MiladyContactsActivity        │
│  MiladyCameraActivity (IMAGE_CAPTURE) · MiladyClockActivity (alarms)│
│  MiladyCalendarActivity · MiladyBootReceiver (boot-time setup)      │
│  GatewayConnectionService (foreground service keeps process alive) │
└─────────────────────────────────────────────────────────────────────┘
            ▲
            │ Android framework (Telecom, Telephony, Provider APIs)
            │
┌─────────────────────────────────────────────────────────────────────┐
│              AOSP system + framework (system_server)                │
│  Telecom · Telephony · ContactsContract · CalendarContract ·        │
│  PackageManager · PermissionController · RoleManager · Settings ·   │
│  AppOpsManager · ConnectivityService · WifiService · ...            │
└─────────────────────────────────────────────────────────────────────┘
            ▲
            │ HALs (vendor blobs on real devices, virtio on Cuttlefish)
            │
┌─────────────────────────────────────────────────────────────────────┐
│                      Linux kernel + drivers                         │
└─────────────────────────────────────────────────────────────────────┘
```

## What we strip and why

`os/android/vendor/milady/milady_common.mk` removes these from `PRODUCT_PACKAGES`:

| Package | Reason | Replacement |
| --- | --- | --- |
| `Browser2` | Milady is the system browser. | `MiladyBrowserActivity` for `ACTION_VIEW` http/https + `WEB_SEARCH`. |
| `Calendar` | Milady owns calendar UI. | `MiladyCalendarActivity` for event-view / INSERT / EDIT + `APP_CALENDAR` launcher. |
| `Camera2` | Milady provides the capture surface. | `MiladyCameraActivity` for `STILL_IMAGE_CAMERA` / `IMAGE_CAPTURE` / `VIDEO_CAPTURE`. |
| `Contacts` | Milady displays contacts via the WebView. The framework's `ContactsContract` provider stays. | `MiladyContactsActivity` for `APP_CONTACTS` launcher + contact mime VIEW. |
| `DeskClock` | Milady owns the alarm UI. | `MiladyClockActivity` for `SET_ALARM` / `SHOW_ALARMS` / `SET_TIMER` / `SHOW_TIMERS` / `DISMISS_ALARM`. |
| `Dialer` | Milady is the dialer. | `MiladyDialActivity` (DIAL / CALL) + `MiladyInCallService`. |
| `Email` | Out of OS-MVP scope. | None — third-party email apps install over-the-top if needed. |
| `Gallery2` | Milady owns image browsing. | None yet — `ACTION_VIEW` on image content URIs falls back to the OS image viewer. **GAP.** |
| `Launcher3` / `Launcher3QuickStep` / `Trebuchet` | Milady is HOME. | Manifest `MAIN + HOME + DEFAULT` filter on `MainActivity`. |
| `ManagedProvisioning` / `Provision` | First-boot wizard fights "boot directly to Milady." | None — boot lands in HOME with `ro.setupwizard.mode=DISABLED`. |
| `Messaging` / `com.google.android.apps.messaging` | Milady is the SMS role holder. | `MiladySmsReceiver` / `MiladyMmsReceiver` / `MiladyRespondViaMessageService` / `MiladySmsComposeActivity`. |
| `Music` | Out of OS-MVP scope. | None — third-party. |
| `QuickSearchBox` | Milady's assistant is the search surface. | `MiladyAssistActivity` (`ACTION_ASSIST`). |
| `SetupWizard` | Pixel partner first-boot. Same reason as Provision. | None — see above. |

### What we keep

| Package | Why |
| --- | --- |
| `Settings` | The system-wide settings UI. Milady deep-links to specific panels (`Settings.ACTION_WIFI_SETTINGS`, `ACTION_BLUETOOTH_SETTINGS`, `ACTION_DISPLAY_SETTINGS`, `ACTION_SOUND_SETTINGS`, etc.) so the user can adjust system state from inside Milady without us re-implementing the framework. |
| Telecom / Telephony framework | The dialer **UI** is Milady, but call routing, modem stack, and `PhoneAccount` registration stay in AOSP. `MiladyDialActivity` calls `TelecomManager.placeCall`; `MiladyInCallService` receives `Call` objects from there. |
| `ContactsContract` provider | The provider is framework, the UI is Milady. Stripping `Contacts` removes the *app*, not the provider — Milady reads / writes via `getContentResolver()`. Same pattern for `CalendarContract` and `Telephony`. |
| `SystemUI` | Status bar, navigation gestures, notification shade. We could overlay them later but they're orthogonal to "be the launcher." |
| `PermissionController` | Default-permission grants land here from `default-permissions-com.miladyai.milady.xml`. |

## Boot sequence

1. Bootloader hands off to kernel.
2. Kernel mounts partitions.
3. AOSP `init` parses `/system/etc/init/*.rc` + `/product/etc/init/init.milady.rc`.
4. `init.milady.rc` `early-init` / `init` / `boot` set `ro.miladyos.boot_phase` markers.
5. `system_server` boots the framework — `PackageManager`, `RoleManager`, `PermissionController`, etc.
6. `framework-res` overlay sets `config_defaultDialer` / `config_defaultSms` / `config_defaultAssistant` to `com.miladyai.milady`.
7. `default-permissions-com.miladyai.milady.xml` runtime-grants the dangerous permissions (READ_CONTACTS, CALL_PHONE, READ_SMS, ...).
8. `privapp-permissions-com.miladyai.milady.xml` whitelists `PACKAGE_USAGE_STATS` so PackageManager grants it (signature|privileged level).
9. Boot completes → `sys.boot_completed=1` triggers fire.
10. `init.milady.rc` `on property:sys.boot_completed=1` runs `appops set` to allow `SYSTEM_ALERT_WINDOW` and `GET_USAGE_STATS` (these are appops, not manifest permissions).
11. `MiladyBootReceiver` fires on `BOOT_COMPLETED`, redundantly grants the `GET_USAGE_STATS` appop via reflection (defense in depth), and starts `GatewayConnectionService` (foreground service that keeps the process alive even when the WebView is backgrounded).
12. `system_server` resolves `MAIN + HOME` → `com.miladyai.milady/.MainActivity` → Milady boots into the HOME surface.

## Validation surfaces

| Tool | What it checks | When it runs |
| --- | --- | --- |
| `bun run miladyos:validate` | Static product layer + permission XMLs + Soong modules + APK manifest entries + AOSP source compatibility + `init.milady.rc` syntax. | Locally / in CI before any Cuttlefish build. |
| `bun test scripts/miladyos-validate-unit.test.ts` | Unit tests that synthesize fake vendor dirs and assert each `validate*` function rejects specific regressions. | Locally / in CI. |
| `bun test scripts/miladyos-scripts-contract.test.ts` | Contract: parseArgs / helper signatures don't drift across script renames. | Locally / in CI. |
| `bun run miladyos:boot-validate` | Live-device asserts: `ro.miladyos.product`, `ro.setupwizard.mode=DISABLED`, `ro.miladyos.boot_phase=completed`, package path is `/system/priv-app/Milady/`, HOME / DIALER / SMS / ASSISTANT role holders are Milady, replacement intents resolve to Milady, no forbidden stock packages installed, no `avc: denied` / `FATAL EXCEPTION` in logcat. | After Cuttlefish boots (or against a Pixel target). |
| `bun run miladyos:e2e` | Wraps boot-validate + screenshots of HOME / Dialer / SMS / Assistant surfaces. Emits `report.json`. | After Cuttlefish boots. |
| `bun run miladyos:avd` | Short-loop app-only test against a stock AVD. Does NOT prove role ownership — only that the APK installs and launches. | Locally during iteration. |
| `node scripts/miladyos/lint-init-rc.mjs <FILE>` | Lints any init.rc file standalone. | Pre-commit / standalone. |

## Threat model: the privilege we hand to Milady

Privileged system apps are dangerous. Milady has, by virtue of being in `/system/priv-app/`:

- All dangerous runtime permissions auto-granted on first boot (READ/WRITE_CONTACTS, CALL_PHONE, ANSWER_PHONE_CALLS, READ/WRITE_CALL_LOG, READ/SEND/RECEIVE_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH, POST_NOTIFICATIONS).
- Whitelisted access to `PACKAGE_USAGE_STATS` (signature|privileged level).
- Hidden-API access (`AppOpsManager.setMode` via reflection works at runtime).
- Default holder for HOME, DIALER, SMS, ASSISTANT roles.
- The same UID space as `system` for many surfaces (since the APK is signed with the platform key by Soong's `android_app_import`).

This is intentional — the OS path can't function without it — but it means **a Milady APK compromise is full-device compromise**. Mitigations:

- Sepolicy (`vendor/milady/sepolicy/`) constrains what file paths Milady can read/write outside its scoped types. Today this is only the `milady_data_file` type for `/data/milady/`. As more surfaces land, more types should land too.
- The privapp whitelist starts minimal and grows only when a manifest signature|privileged permission demands it.
- `default-permissions-*.xml` uses `fixed="false"` for permissions a user may reasonably want to revoke (mic, camera, location). Critical role permissions (SMS, telephony) are `fixed="true"`.
- The platform key for production builds **must not** match the AOSP test key. `SETUP_REAL_DEVICE.md` covers the production-key generation flow.

## What's still gap, deferred, or out-of-scope

- **MMS retrieval** — `MiladyMmsReceiver` logs the WAP-push event and forwards PDU bytes to the JS layer but doesn't actually fetch MMS content. Hidden-API PduParser is reachable at runtime; wiring it is on the JS side and is deferred work.
- **Gallery handler** — `Gallery2` stripped, no replacement. `ACTION_VIEW` on image content URIs falls through. Open question: build a Milady gallery surface, or reinstate a minimal viewer.
- **Settings panels** — Milady deep-links to AOSP Settings, but a Milady-themed wrapper around Wifi/Bluetooth/Display panels (so it doesn't visually whiplash the user) would be nicer. Not blocking.
- **Boot animation** — recipe + script in place, but the actual brand frames are intentionally not in the repo. Drop PNGs into `os/android/vendor/milady/bootanimation/part0/` and run `node scripts/miladyos/build-bootanimation.mjs --frames os/android/vendor/milady/bootanimation` to ship one.
- **Pixel device makefiles** — wrappers exist (oriole / panther / shiba / caiman) but `lunch` only resolves them when the AOSP checkout has the matching device tree. AOSP `android-latest-release` may not — bisect by re-init'ing `repo` to a tag that does.
- **OTA infrastructure** — none. First flash is `fastboot flashall`. Auto-update is deferred until production-key signing lands.
- **Production signing** — the AOSP test platform key signs Cuttlefish images, which is fine for dev. A production deployment **must** swap to a generated `releasekey` / `platform` / `shared` / `media` keypair. See `SETUP_REAL_DEVICE.md`.
- **Java unit tests** — the priv-app activities have no JVM unit-test coverage. Each activity is small (deep-link redirector + maybe a TelecomManager call), so the cost is low, but the runtime is Android-only. Would need Robolectric or instrumentation tests.

## Reading order for a new contributor

1. `SETUP_AOSP.md` — bring up Cuttlefish.
2. This file — orient on the layer map and what's stripped.
3. `os/android/vendor/milady/milady_common.mk` — see the actual strip list and PRODUCT_COPY_FILES.
4. `eliza/packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/Milady*.java` — every native entry point.
5. `scripts/miladyos/validate.mjs` and `boot-validate.mjs` — what we assert about the resulting build.
6. `SETUP_REAL_DEVICE.md` — when ready to leave Cuttlefish.
