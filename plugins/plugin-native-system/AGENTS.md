# @elizaos/capacitor-system

A Capacitor plugin that bridges Android system-role status and device-settings control into the elizaOS mobile runtime.

## Purpose / Role

Exposes Android system capabilities — role status (home, dialer, SMS, assistant), screen brightness, and audio-volume control — to TypeScript code running inside a Capacitor-based Eliza agent on Android. On web/browser it provides fallback implementations that either return empty data or throw descriptive errors. This package is a Capacitor plugin, not an elizaOS plugin that registers actions/services with `AgentRuntime`; it is consumed by higher-level elizaOS packages that need native Android access.

## Plugin Surface

This is a **Capacitor plugin**, not an elizaOS runtime plugin. It does not register actions, providers, evaluators, services, or routes with `AgentRuntime`. It exposes one Capacitor plugin object:

| Export | Description |
|--------|-------------|
| `System` | Registered as `"ElizaSystem"` via `registerPlugin`. Import from `@elizaos/capacitor-system`. |

### `System` methods (all return Promises)

| Method | Platform | Description |
|--------|----------|-------------|
| `getStatus()` | Android + web | Package name + role-status array (home, dialer, sms, assistant). Web always returns empty roles. |
| `requestRole({ role })` | Android only | Launches system role-request dialog. Requires Android 10+. |
| `openSettings()` | Android only | Opens main system Settings activity. |
| `openNetworkSettings()` | Android only | Opens Wi-Fi settings. |
| `openWriteSettings()` | Android only | Opens WRITE_SETTINGS permission screen for the app. |
| `openDisplaySettings()` | Android only | Opens display settings. |
| `openSoundSettings()` | Android only | Opens sound/volume settings. |
| `getDeviceSettings()` | Android + web | Brightness (0–1), brightness mode, WRITE_SETTINGS permission flag, and volume levels for all streams. Web returns static fallback values. |
| `setScreenBrightness({ brightness })` | Android only | Sets system brightness (0–1). Requires WRITE_SETTINGS permission. |
| `setVolume({ stream, volume, showUi? })` | Android only | Sets volume for a named audio stream. |

### Exported types (from `src/definitions.ts`)

- `AndroidRoleName` — `"home" | "dialer" | "sms" | "assistant"`
- `AndroidRoleStatus` — per-role status object (`role`, `androidRole`, `held`, `holders`, `available`)
- `SystemStatus` — `{ packageName, roles: AndroidRoleStatus[] }`
- `AndroidRoleRequestResult` — `{ role, held, resultCode }`
- `SystemVolumeStream` — `"music" | "ring" | "alarm" | "notification" | "system" | "voiceCall"`
- `SystemVolumeStatus` — `{ stream, current, max }`
- `DeviceSettingsStatus` — `{ brightness, brightnessMode, canWriteSettings, volumes }`
- `SystemPlugin` — interface implemented by both native and web layers

## Layout

```
plugins/plugin-native-system/
  src/
    index.ts          Entry point; calls registerPlugin("ElizaSystem") and re-exports definitions
    definitions.ts    All TypeScript types and the SystemPlugin interface
    web.ts            Web fallback (SystemWeb extends WebPlugin); returns fallback data or throws
  android/
    src/main/
      AndroidManifest.xml                        Declares MODIFY_AUDIO_SETTINGS + WRITE_SETTINGS
      java/ai/eliza/plugins/system/
        SystemPlugin.kt                          Native Android implementation (Kotlin)
    build.gradle                                 Android library build config
  rollup.config.mjs   Bundles dist/esm -> IIFE + CJS for web runtime
  tsconfig.json
  package.json
```

## Commands

Only scripts from `package.json`:

```bash
bun run --cwd plugins/plugin-native-system build          # clean + tsc + rollup
bun run --cwd plugins/plugin-native-system clean          # remove dist/
```

No test script is defined in this package.

## Config / Env Vars

No environment variables. No elizaOS config keys. The plugin has no runtime configuration; behavior is determined entirely by the Android platform and granted permissions.

Android permissions declared in `AndroidManifest.xml` (merged into the host app):
- `android.permission.MODIFY_AUDIO_SETTINGS` — required for `setVolume`
- `android.permission.WRITE_SETTINGS` — required for `setScreenBrightness`; user must grant via Settings on Android 6+

`setScreenBrightness` additionally requires `WRITE_SETTINGS` to be granted at runtime (checked via `Settings.System.canWrite`). Call `openWriteSettings()` first to direct the user to the permission screen.

`requestRole` requires Android 10 (API 29+). On older devices it rejects with an error.

## How to Extend

### Add a new plugin method

1. Add the method signature to `SystemPlugin` in `src/definitions.ts`.
2. Add a web fallback in `src/web.ts` (`SystemWeb` class) — throw a descriptive error or return a safe default.
3. Add the `@PluginMethod` implementation in `android/src/main/java/ai/eliza/plugins/system/SystemPlugin.kt`.
4. If the method requires a new Android permission, add a `<uses-permission>` entry to `android/src/main/AndroidManifest.xml`.
5. Run `bun run --cwd plugins/plugin-native-system build` to verify TypeScript compilation.

### Add a new Capacitor event

Use `notifyListeners("eventName", data)` in the Kotlin plugin and `System.addListener("eventName", handler)` on the JS side. Add the listener type to `SystemPlugin` in `definitions.ts`.

## Conventions / Gotchas

- **Plugin name is `"ElizaSystem"`** — this string must match `@CapacitorPlugin(name = "ElizaSystem")` in Kotlin and the first arg to `registerPlugin` in `src/index.ts`. Mismatches silently fall back to the web implementation.
- **Capacitor, not elizaOS runtime** — `System` is imported and called directly in TypeScript; it does not participate in `AgentRuntime` plugin registration. Do not confuse with elizaOS action/provider/service plugin objects.
- **Android-only methods throw on web** — all settings-open and write methods throw `Error` in `SystemWeb`. Guard call sites with platform checks or catch the error.
- **WRITE_SETTINGS is a special permission** — it cannot be requested via `requestPermissions`; the user must be redirected to `openWriteSettings()`. Check `canWriteSettings` in the `DeviceSettingsStatus` response before calling `setScreenBrightness`.
- **Role queries require Android 10+** — `getStatus()` returns an empty `roles` array on Android < 10 (it does not reject). `requestRole()` rejects on Android < 10.
- **Build output** — `dist/esm/` is produced by `tsc`, then Rollup bundles it to `dist/plugin.js` (IIFE) and `dist/plugin.cjs.js` (CJS). The Android AAR is built separately by Gradle inside the host Capacitor project.
- **No test suite** — there are no unit or integration tests in this package. Changes to the Android Kotlin code require manual device testing or Android emulator verification.
