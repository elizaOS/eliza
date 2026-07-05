/**
 * `OverlayApp` descriptor for the Android device-settings overlay —
 * the entire runtime surface this plugin contributes (no actions,
 * providers, or services). `androidOnly: true` keeps it out of the apps
 * grid on non-Android shells; the view itself is lazy-loaded so importing
 * this module never pulls in React/the UI bundle.
 */

import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";

export const DEVICE_SETTINGS_APP_NAME = "@elizaos/plugin-native-settings";

export const deviceSettingsApp: OverlayApp = {
  name: DEVICE_SETTINGS_APP_NAME,
  displayName: "Device Settings",
  description: "Brightness, volume, Android roles, and device settings",
  category: "system",
  icon: null,
  androidOnly: true,
  loader: () =>
    import("./DeviceSettingsAppView").then((m) => ({
      default: m.DeviceSettingsAppView,
    })),
};

export function registerDeviceSettingsApp(): void {
  registerOverlayApp(deviceSettingsApp);
}
