# ElizaOS Architecture

The shape of the Eliza-as-operating-system path. Companion to `SETUP_AOSP.md` (Cuttlefish bring-up runbook) and `SETUP_REAL_DEVICE.md` (Pixel target runbook).

## Two paths, one APK

The same Capacitor APK ships through two completely different deployment paths:

| Path | Where the APK lives | Who's the launcher | Who handles SMS / Dialer / Assistant |
| --- | --- | --- | --- |
| **App** (`bun run build:android`) | `/data/app/com.elizaai.eliza/` (user-installed) | Stock launcher. Eliza appears in the app drawer. | Stock apps (Google Phone / Messages) unless the user picks Eliza from Settings → Default apps. |
| **OS** (`bun run build:android:system`) | `/system/priv-app/Eliza/` (privileged system app) | Eliza is the only HOME activity. | Eliza, by being the only registered handler — every stock app for those roles is stripped from the build. |

Everything below is the OS path.

## Layer map

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Eliza WebView (the user-visible UI)               │
│  Phone, Messages, Contacts, Camera, Clock, Calendar, Browser,       │
│  WiFi/Bluetooth/Display panels (deep-linked into AOSP Settings)     │
└─────────────────────────────────────────────────────────────────────┘
            ▲                                            ▲
            │ Capacitor bridge                           │ deep links
            │                                            │ eliza://...
┌─────────────────────────────────────────────────────────────────────┐
│                 Native Java entry points (priv-app)                 │
│  MainActivity (HOME) · ElizaDialActivity (DIAL/CALL)               │
│  ElizaSmsReceiver/SmsCompose/RespondViaMessage/MmsReceiver         │
│  ElizaAssistActivity (ASSIST) · ElizaInCallService (call lifecycle)│
│  ElizaBrowserActivity (http/https) · ElizaContactsActivity        │
│  ElizaCameraActivity (IMAGE_CAPTURE) · ElizaClockActivity (alarms)│
│  ElizaCalendarActivity · ElizaBootReceiver (boot-time setup)      │
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

`packages/os/android/vendor/eliza/eliza_common.mk` removes these from `PRODUCT_PACKAGES`:

| Package | Reason | Replacement |
| --- | --- | --- |
| `Browser2` | Eliza is the system browser. | `ElizaBrowserActivity` for `ACTION_VIEW` http/https + `WEB_SEARCH`. |
| `Calendar` | Eliza owns calendar UI. | `ElizaCalendarActivity` for event-view / INSERT / EDIT + `APP_CALENDAR` launcher. |
| `Camera2` | Eliza provides the capture surface. | `ElizaCameraActivity` for `STILL_IMAGE_CAMERA` / `IMAGE_CAPTURE` / `VIDEO_CAPTURE`. |
| `Contacts` | Eliza displays contacts via the WebView. The framework's `ContactsContract` provider stays. | `ElizaContactsActivity` for `APP_CONTACTS` launcher + contact mime VIEW. |
| `DeskClock` | Eliza owns the alarm UI. | `ElizaClockActivity` for `SET_ALARM` / `SHOW_ALARMS` / `SET_TIMER` / `SHOW_TIMERS` / `DISMISS_ALARM`. |
| `Dialer` | Eliza is the dialer. | `ElizaDialActivity` (DIAL / CALL) + `ElizaInCallService`. |
| `Email` | Out of OS-MVP scope. | None — third-party email apps install over-the-top if needed. |
| `Gallery2` | Eliza owns image browsing. | None yet — `ACTION_VIEW` on image content URIs falls back to the OS image viewer. **GAP.** |
| `Launcher3` / `Launcher3QuickStep` / `Trebuchet` | Eliza is HOME. | Manifest `MAIN + HOME + DEFAULT` filter on `MainActivity`. |
| `ManagedProvisioning` / `Provision` | First-boot wizard fights "boot directly to Eliza." | None — boot lands in HOME with `ro.setupwizard.mode=DISABLED`. |
| `Messaging` / `com.google.android.apps.messaging` | Eliza is the SMS role holder. | `ElizaSmsReceiver` / `ElizaMmsReceiver` / `ElizaRespondViaMessageService` / `ElizaSmsComposeActivity`. |
| `Music` | Out of OS-MVP scope. | None — third-party. |
| `QuickSearchBox` | Eliza's assistant is the search surface. | `ElizaAssistActivity` (`ACTION_ASSIST`). |
| `SetupWizard` | Pixel partner first-boot. Same reason as Provision. | None — see above. |

### What we keep

| Package | Why |
| --- | --- |
| `Settings` | The system-wide settings UI. Eliza deep-links to specific panels (`Settings.ACTION_WIFI_SETTINGS`, `ACTION_BLUETOOTH_SETTINGS`, `ACTION_DISPLAY_SETTINGS`, `ACTION_SOUND_SETTINGS`, etc.) so the user can adjust system state from inside Eliza without us re-implementing the framework. |
| Telecom / Telephony framework | The dialer **UI** is Eliza, but call routing, modem stack, and `PhoneAccount` registration stay in AOSP. `ElizaDialActivity` calls `TelecomManager.placeCall`; `ElizaInCallService` receives `Call` objects from there. |
| `ContactsContract` provider | The provider is framework, the UI is Eliza. Stripping `Contacts` removes the *app*, not the provider — Eliza reads / writes via `getContentResolver()`. Same pattern for `CalendarContract` and `Telephony`. |
| `SystemUI` | Status bar, navigation gestures, notification shade. We could overlay them later but they're orthogonal to "be the launcher." |
| `PermissionController` | Default-permission grants land here from `default-permissions-com.elizaai.eliza.xml`. |

## Boot sequence

1. Bootloader hands off to kernel.
2. Kernel mounts partitions.
3. AOSP `init` parses `/system/etc/init/*.rc` + `/product/etc/init/init.eliza.rc`.
4. `init.eliza.rc` `early-init` / `init` / `boot` set `ro.elizaos.boot_phase` markers.
5. `system_server` boots the framework — `PackageManager`, `RoleManager`, `PermissionController`, etc.
6. `framework-res` overlay sets `config_defaultDialer` / `config_defaultSms` / `config_defaultAssistant` to `com.elizaai.eliza`.
7. `default-permissions-com.elizaai.eliza.xml` runtime-grants the dangerous permissions (READ_CONTACTS, CALL_PHONE, READ_SMS, ...).
8. `privapp-permissions-com.elizaai.eliza.xml` whitelists `PACKAGE_USAGE_STATS` so PackageManager grants it (signature|privileged level).
9. Boot completes → `sys.boot_completed=1` triggers fire.
10. `init.eliza.rc` `on property:sys.boot_completed=1` runs `appops set` to allow `SYSTEM_ALERT_WINDOW` and `GET_USAGE_STATS` (these are appops, not manifest permissions).
11. `ElizaBootReceiver` fires on `BOOT_COMPLETED`, redundantly grants the `GET_USAGE_STATS` appop via reflection (defense in depth), and starts `GatewayConnectionService` (foreground service that keeps the process alive even when the WebView is backgrounded).
12. `system_server` resolves `MAIN + HOME` → `com.elizaai.eliza/.MainActivity` → Eliza boots into the HOME surface.

## Validation surfaces

| Tool | What it checks | When it runs |
| --- | --- | --- |
| `bun run elizaos:validate` | Static product layer + permission XMLs + Soong modules + APK manifest entries + AOSP source compatibility + `init.eliza.rc` syntax. | Locally / in CI before any Cuttlefish build. |
| `bun test scripts/elizaos-validate-unit.test.ts` | Unit tests that synthesize fake vendor dirs and assert each `validate*` function rejects specific regressions. | Locally / in CI. |
| `bun test scripts/elizaos-scripts-contract.test.ts` | Contract: parseArgs / helper signatures don't drift across script renames. | Locally / in CI. |
| `bun run elizaos:boot-validate` | Live-device asserts: `ro.elizaos.product`, `ro.setupwizard.mode=DISABLED`, `ro.elizaos.boot_phase=completed`, package path is `/system/priv-app/Eliza/`, HOME / DIALER / SMS / ASSISTANT role holders are Eliza, replacement intents resolve to Eliza, no forbidden stock packages installed, no `avc: denied` / `FATAL EXCEPTION` in logcat. | After Cuttlefish boots (or against a Pixel target). |
| `bun run elizaos:e2e` | Wraps boot-validate + screenshots of HOME / Dialer / SMS / Assistant surfaces. Emits `report.json`. | After Cuttlefish boots. |
| `bun run elizaos:avd` | Short-loop app-only test against a stock AVD. Does NOT prove role ownership — only that the APK installs and launches. | Locally during iteration. |
| `node scripts/elizaos/lint-init-rc.mjs <FILE>` | Lints any init.rc file standalone. | Pre-commit / standalone. |

## Threat model: the privilege we hand to Eliza

Privileged system apps are dangerous. Eliza has, by virtue of being in `/system/priv-app/`:

- All dangerous runtime permissions auto-granted on first boot (READ/WRITE_CONTACTS, CALL_PHONE, ANSWER_PHONE_CALLS, READ/WRITE_CALL_LOG, READ/SEND/RECEIVE_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH, POST_NOTIFICATIONS).
- Whitelisted access to `PACKAGE_USAGE_STATS` (signature|privileged level).
- Hidden-API access (`AppOpsManager.setMode` via reflection works at runtime).
- Default holder for HOME, DIALER, SMS, ASSISTANT roles.
- The same UID space as `system` for many surfaces (since the APK is signed with the platform key by Soong's `android_app_import`).

This is intentional — the OS path can't function without it — but it means **a Eliza APK compromise is full-device compromise**. Mitigations:

- Sepolicy (`vendor/eliza/sepolicy/`) constrains what file paths Eliza can read/write outside its scoped types. Today this is only the `eliza_data_file` type for `/data/eliza/`. As more surfaces land, more types should land too.
- The privapp whitelist starts minimal and grows only when a manifest signature|privileged permission demands it.
- `default-permissions-*.xml` uses `fixed="false"` for permissions a user may reasonably want to revoke (mic, camera, location). Critical role permissions (SMS, telephony) are `fixed="true"`.
- The platform key for production builds **must not** match the AOSP test key. `SETUP_REAL_DEVICE.md` covers the production-key generation flow.

## What's still gap, deferred, or out-of-scope

- **MMS retrieval** — `ElizaMmsReceiver` logs the WAP-push event and forwards PDU bytes to the JS layer but doesn't actually fetch MMS content. Hidden-API PduParser is reachable at runtime; wiring it is on the JS side and is deferred work.
- **Gallery handler** — `Gallery2` stripped, no replacement. `ACTION_VIEW` on image content URIs falls through. Open question: build a Eliza gallery surface, or reinstate a minimal viewer.
- **Settings panels** — Eliza deep-links to AOSP Settings, but a Eliza-themed wrapper around Wifi/Bluetooth/Display panels (so it doesn't visually whiplash the user) would be nicer. Not blocking.
- **Boot animation** — recipe + script in place, but the actual brand frames are intentionally not in the repo. Drop PNGs into `packages/os/android/vendor/eliza/bootanimation/part0/` and run `node scripts/elizaos/build-bootanimation.mjs --frames packages/os/android/vendor/eliza/bootanimation` to ship one.
- **Pixel device makefiles** — wrappers exist (oriole / panther / shiba / caiman) but `lunch` only resolves them when the AOSP checkout has the matching device tree. AOSP `android-latest-release` may not — bisect by re-init'ing `repo` to a tag that does.
- **OTA infrastructure** — none. First flash is `fastboot flashall`. Auto-update is deferred until production-key signing lands.
- **Production signing** — the AOSP test platform key signs Cuttlefish images, which is fine for dev. A production deployment **must** swap to a generated `releasekey` / `platform` / `shared` / `media` keypair. See `SETUP_REAL_DEVICE.md`.
- **Java unit tests** — the priv-app activities have no JVM unit-test coverage. Each activity is small (deep-link redirector + maybe a TelecomManager call), so the cost is low, but the runtime is Android-only. Would need Robolectric or instrumentation tests.

## Reading order for a new contributor

1. `SETUP_AOSP.md` — bring up Cuttlefish.
2. This file — orient on the layer map and what's stripped.
3. `packages/os/android/vendor/eliza/eliza_common.mk` — see the actual strip list and PRODUCT_COPY_FILES.
4. `eliza/packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/Eliza*.java` — every native entry point.
5. `scripts/elizaos/validate.mjs` and `boot-validate.mjs` — what we assert about the resulting build.
6. `SETUP_REAL_DEVICE.md` — when ready to leave Cuttlefish.
