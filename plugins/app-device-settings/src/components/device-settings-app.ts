import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { DeviceSettingsAppView } from "./DeviceSettingsAppView";

export const DEVICE_SETTINGS_APP_NAME = "@elizaos/app-device-settings";

export const deviceSettingsApp: OverlayApp = {
  name: DEVICE_SETTINGS_APP_NAME,
  displayName: "Device Settings",
  description: "Brightness, volume, Android roles, and device settings",
  category: "system",
  icon: null,
  androidOnly: true,
  Component: DeviceSettingsAppView,
};

export function registerDeviceSettingsApp(): void {
  registerOverlayApp(deviceSettingsApp);
}
