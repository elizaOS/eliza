# Deferred native integration — Android system UI

This package scaffolds the React surface. Wiring it to real AOSP system
state requires native integrations that are intentionally out of scope
for this session.

## Required when SystemUI replacement lands

- **Surface host.** Replace `frameworks/base/packages/SystemUI` with an
  app that hosts this React tree inside a `WebView` (or Hermes + Fabric
  if going RN/React Native). Window types:
  - Status bar: `WindowManager.LayoutParams.TYPE_STATUS_BAR`.
  - Nav bar: `TYPE_NAVIGATION_BAR`.
  - Keyguard / lock: `TYPE_KEYGUARD` via Keyguard service replacement.
  Requires platform signing and `android.uid.system`.
- **Wi-Fi state.** `ConnectivityManager.registerDefaultNetworkCallback`
  + `WifiManager.getConnectionInfo()` for SSID + RSSI. `ACCESS_FINE_LOCATION`
  is required for SSID on Android 10+.
- **Cell signal.** `TelephonyManager.listen(PhoneStateListener.LISTEN_SIGNAL_STRENGTHS)`
  / `TelephonyCallback.SignalStrengthsListener`. Carrier name via
  `TelephonyManager.getNetworkOperatorName()`.
- **Audio state.** `AudioManager.getStreamVolume(STREAM_MUSIC)` +
  `AudioManager.isStreamMute(STREAM_MUSIC)`. Subscribe via
  `ContentObserver` on `Settings.System.VOLUME_*` URIs.
- **Battery state.** Sticky broadcast `ACTION_BATTERY_CHANGED`,
  `EXTRA_LEVEL` / `EXTRA_SCALE` / `EXTRA_STATUS` /
  `EXTRA_PLUGGED`.
- **Airplane mode.** Read `Settings.Global.AIRPLANE_MODE_ON`. Writing
  requires `WRITE_SECURE_SETTINGS` (platform signature).
- **Power controls.** `PowerManager.reboot()` and
  `PowerManager.goToSleep()` require `REBOOT` /
  `DEVICE_POWER` permissions (platform-signed). For shutdown, broadcast
  `Intent.ACTION_REQUEST_SHUTDOWN` from a system app.
- **Settings entry.** `Intent(Settings.ACTION_SETTINGS)` launched via
  `Context.startActivity`.
- **Navigation buttons.** When replacing nav bar, hook back/home/recents
  to `InputManager.injectInputEvent` with `KEYCODE_BACK`,
  `KEYCODE_HOME`, `KEYCODE_APP_SWITCH`. Or call directly through the
  `WindowManagerService` AIDL when running as system_uid.
- **Lock-screen auth gating.** This package only renders the visual
  lock screen. Real unlock requires hooking `KeyguardService` /
  `KeyguardViewMediator`. The "voice unlock" pill is visual only.
- **Wallpaper / clouds.** Re-export `SlowClouds` from
  `@elizaos/ui/backgrounds` once that module exists, then pass it into
  `<LockScreen cloudsModule={<SlowClouds />} />`.
- **CompanionBar.** Once `packages/ui/src/desktop-runtime/` exports a
  `CompanionBar` component + types, pass it to
  `<LockScreen companionBar={<CompanionBar … />} />`.

## Markers in source

Search for `// IMPL:` comments in
`src/providers/AndroidSystemProvider.tsx` for the exact integration
points.

## Native skeleton

`native/` now contains an Android library skeleton
(`eliza-android-system-bridge`, package `ai.elizaos.system.bridge`) that
mirrors the JS-side channel map in `src/bridge/bridge-contract.ts`.
Every method in `SystemBridge.kt` throws `NotImplementedError`. Landing
the integration requires:

- A SystemUI replacement APK that hosts the React surface in a `WebView`
  and exposes `SystemBridge` to JS via
  `WebView.addJavascriptInterface(bridge, "__elizaAndroidBridge")`.
  That bound name is what `getBridgeTransport()` looks up.
- The bridge APK installed in `/system/priv-app/` and signed with the
  AOSP platform key.
- A vendor partition allowlist
  (`vendor/eliza/permissions/privapp-permissions-ai.elizaos.system.bridge.xml`)
  granting `REBOOT`, `DEVICE_POWER`, `WRITE_SECURE_SETTINGS`, and the
  rest of the signature-level permissions. The library's own
  `AndroidManifest.xml` only **declares** them.
- SELinux policy in `vendor/eliza/sepolicy/` for the bridge service
  domain (read + write contexts for power control, AudioManager IPC,
  ConnectivityManager IPC, TelephonyManager IPC).
- Replacing `frameworks/base/packages/SystemUI` in the AOSP build with
  this APK (or an overlay product variant under
  `vendor/eliza/products/`).
- A real lock-screen integration via `KeyguardService` replacement; the
  JS-side `dismissLockscreen` command currently maps to
  `KeyguardManager.requestDismissKeyguard`, which only works from a
  foreground activity context.
