# eliza-android-system-bridge

Android library that backs the JS `BridgeTransport` contract declared in
`../src/bridge/`. Packaged inside the AOSP SystemUI replacement APK and
exposes the channels listed in `bridge-contract.ts` over a single
`WebView`-bound JS interface.

## Responsibilities

Only this library is allowed to call `AudioManager`,
`ConnectivityManager`, `TelephonyManager`, `BatteryManager`, and
`PowerManager`. Every privileged action requires the AOSP fork to install
the bridge APK as a system-signature app (`/system/priv-app/` plus a
matching entry in `privapp-permissions-*.xml`).

| JS channel                                   | Native binding                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `eliza.android.wifi.state`                   | `ConnectivityManager.NetworkCallback` + `WifiManager.getConnectionInfo`        |
| `eliza.android.cell.state`                   | `TelephonyManager.PhoneStateListener` + `LISTEN_SIGNAL_STRENGTHS`              |
| `eliza.android.audio.state`                  | `AudioManager.getStreamVolume(STREAM_MUSIC)` + `STREAM_*_VOLUME_CHANGED`       |
| `eliza.android.audio.setLevel`               | `AudioManager.setStreamVolume(STREAM_MUSIC, …, 0)`                             |
| `eliza.android.audio.setMuted`               | `AudioManager.adjustStreamVolume(ADJUST_MUTE / ADJUST_UNMUTE, 0)`              |
| `eliza.android.battery.state`                | sticky `Intent.ACTION_BATTERY_CHANGED` + `BatteryManager`                      |
| `eliza.android.time.state`                   | `Intent.ACTION_TIME_TICK` + `Calendar.getInstance().timeZone`                  |
| `eliza.android.connectivity.state`           | `ConnectivityManager.registerDefaultNetworkCallback`                           |
| `eliza.android.cell.toggleAirplaneMode`      | `Settings.Global.AIRPLANE_MODE_ON` write (requires `WRITE_SECURE_SETTINGS`)    |
| `eliza.android.power.shutdown`               | `PowerManager.shutdown` (requires `REBOOT` + signature)                        |
| `eliza.android.power.restart`                | `PowerManager.reboot(null)`                                                    |
| `eliza.android.power.sleep`                  | `PowerManager.goToSleep` (requires `DEVICE_POWER` + signature)                 |
| `eliza.android.settings.open`                | `Context.startActivity(Intent(Settings.ACTION_SETTINGS))`                      |
| `eliza.android.lockscreen.state`             | `KeyguardManager.isDeviceLocked` + `KeyguardManager.isKeyguardSecure`          |
| `eliza.android.lockscreen.dismiss`           | `KeyguardManager.requestDismissKeyguard` (foreground activity context only)   |

## Status

Skeleton only. Every method in `SystemBridge.kt` throws
`NotImplementedError`. Real wiring depends on:

- A signed system-app build slot in `vendor/eliza/`.
- A matching `privapp-permissions-ai.elizaos.system.bridge.xml` granting
  `REBOOT`, `DEVICE_POWER`, `WRITE_SECURE_SETTINGS`, and
  `ACCESS_NETWORK_STATE`.
- SELinux policy entries in `vendor/eliza/sepolicy/` for the bridge
  service domain.

The bridge's manifest declares the **dangerous** permissions only. The
**signature-level** ones above must be granted at build time through the
vendor-partition allowlist; declaring them inside this library's
`AndroidManifest.xml` is intentionally not enough.

## Build

```
./gradlew :eliza-android-system-bridge:assembleRelease
```

(Do not run as part of this scaffold session — the source is here for
the AOSP integrator.)
