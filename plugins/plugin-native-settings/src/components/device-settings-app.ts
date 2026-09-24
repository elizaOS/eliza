/** Registers the Android device-settings overlay in the shared browser app registry. */
import { registerOverlayApp } from "@elizaos/ui/apps/overlay-app-registry";
import { type OverlayApp } from "@elizaos/ui/apps/overlay-app-api";
export const DEVICE_SETTINGS_APP_NAME = "@elizaos/plugin-native-settings";
export const deviceSettingsApp: OverlayApp = {
    name: DEVICE_SETTINGS_APP_NAME,
    displayName: "Device Settings",
    description: "Brightness, volume, Android roles, and device settings",
    category: "system",
    icon: null,
    androidOnly: true,
    loader: () => import("./DeviceSettingsAppView").then((m) => ({
        default: m.DeviceSettingsAppView,
    })),
};
export function registerDeviceSettingsApp(): void {
    registerOverlayApp(deviceSettingsApp);
}
