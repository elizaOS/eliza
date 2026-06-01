# @elizaos/capacitor-system

Android system-role status bridge for elizaOS.

A [Capacitor](https://capacitorjs.com/) plugin that exposes Android system roles (home launcher, default dialer, SMS app, assistant), screen brightness, and audio-volume controls to TypeScript code running inside an elizaOS-based Android app.

## What it does

On **Android**, the plugin lets TypeScript code:

- Query which Android system roles the app currently holds (home, dialer, SMS, voice assistant).
- Request a system role via the standard Android role-request dialog.
- Read and write screen brightness (requires WRITE_SETTINGS permission).
- Read and set per-stream audio volume (music, ring, alarm, notification, system, voice call).
- Open standard Android settings screens (main settings, Wi-Fi, display, sound, WRITE_SETTINGS permission grant).

On **web/browser**, `getStatus()` and `getDeviceSettings()` return safe stub values. All other methods throw a descriptive error.

## Installation

This package is part of the elizaOS monorepo. In a standalone Capacitor project, install it as you would any Capacitor plugin:

```bash
npm install @elizaos/capacitor-system
npx cap sync android
```

## Usage

```typescript
import { System } from "@elizaos/capacitor-system";

// Check which roles the app holds
const status = await System.getStatus();
console.log(status.packageName, status.roles);

// Request the default SMS role
const result = await System.requestRole({ role: "sms" });
if (result.held) {
  console.log("App is now the default SMS handler");
}

// Read device settings
const settings = await System.getDeviceSettings();
console.log("Brightness:", settings.brightness);
console.log("Can write settings:", settings.canWriteSettings);

// Set screen brightness (requires WRITE_SETTINGS permission)
if (!settings.canWriteSettings) {
  await System.openWriteSettings(); // redirect user to grant permission
} else {
  await System.setScreenBrightness({ brightness: 0.5 });
}

// Set music volume
await System.setVolume({ stream: "music", volume: 10, showUi: true });
```

## Android roles

| Role name | Android constant | What it controls |
|-----------|-----------------|------------------|
| `home` | `ROLE_HOME` | Default launcher / home screen |
| `dialer` | `ROLE_DIALER` | Default phone/dialer app |
| `sms` | `ROLE_SMS` | Default SMS messaging app |
| `assistant` | `ROLE_ASSISTANT` | Default voice assistant |

Role queries and requests require **Android 10 (API 29+)**. On older devices, `getStatus()` returns an empty roles array; `requestRole()` rejects.

## Permissions

The plugin declares these permissions in its `AndroidManifest.xml`. They are merged into the host app automatically via Capacitor:

| Permission | Required for |
|------------|-------------|
| `MODIFY_AUDIO_SETTINGS` | `setVolume` |
| `WRITE_SETTINGS` | `setScreenBrightness` |

`WRITE_SETTINGS` is a special system permission that cannot be granted via the standard permission dialog. Direct the user to grant it:

```typescript
await System.openWriteSettings();
```

## API

Full TypeScript types are exported from the package root. See `src/definitions.ts` for the complete interface.

```typescript
interface SystemPlugin {
  getStatus(): Promise<SystemStatus>;
  requestRole(options: { role: AndroidRoleName }): Promise<AndroidRoleRequestResult>;
  openSettings(): Promise<void>;
  openNetworkSettings(): Promise<void>;
  openWriteSettings(): Promise<void>;
  openDisplaySettings(): Promise<void>;
  openSoundSettings(): Promise<void>;
  getDeviceSettings(): Promise<DeviceSettingsStatus>;
  setScreenBrightness(options: { brightness: number }): Promise<DeviceSettingsStatus>;
  setVolume(options: { stream: SystemVolumeStream; volume: number; showUi?: boolean }): Promise<SystemVolumeStatus>;
}
```

## Building

```bash
bun run --cwd plugins/plugin-native-system build
```

The Android library is built by Gradle as part of the host Capacitor Android project (`npx cap build android`).

## License

MIT
