# @elizaos/plugin-device-settings

Android device-settings overlay for elizaOS. Adds a full-screen UI panel that lets users adjust screen brightness, control per-stream audio volumes (media, ring, alarm, notifications, system, voice call), request Android default app roles (Home, Phone, SMS, Assistant), and jump directly to system settings panels — all through the `@elizaos/capacitor-system` native bridge.

## What it does

| Capability | Details |
|---|---|
| **Brightness** | Slider + Apply button. Requires Android `WRITE_SETTINGS` permission; the UI shows a shortcut to grant it if missing. |
| **Volume** | Per-stream sliders for every audio stream the system exposes. Apply is per-stream. |
| **Default roles** | View and request Home, Phone/Dialer, SMS, and Assistant roles. Shows current assignment and whether the role is already held. |
| **Settings shortcuts** | One-tap deep links into System settings, Display, Sound, and Network panels. |

## Platform support

Android only (`androidOnly: true`). The overlay is not rendered on iOS or desktop.

## How to enable

Add the plugin to your elizaOS agent's plugin list:

```ts
import deviceSettingsPlugin from "@elizaos/plugin-device-settings";

const agent = new AgentRuntime({
  plugins: [deviceSettingsPlugin],
  // ...
});
```

The overlay app is registered automatically in the elizaOS UI shell when the package is loaded inside an elizaOS runtime.

## Requirements

- Running inside the elizaOS Android shell.
- `@elizaos/capacitor-system` native Capacitor plugin registered in the native layer.
- Android `WRITE_SETTINGS` permission for brightness control (prompted from within the UI when missing).

## Package

```
@elizaos/plugin-device-settings
```

Exports: `appDeviceSettingsPlugin` (default), `DeviceSettingsAppView`, `deviceSettingsApp`, `registerDeviceSettingsApp`, `DEVICE_SETTINGS_APP_NAME`.
