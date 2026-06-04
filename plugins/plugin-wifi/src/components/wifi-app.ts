/**
 * WiFi overlay app definition + registration.
 *
 * Registered by the WiFi side-effect entry only on
 * Android; other platforms intentionally leave registration unchanged so the app does
 * not appear in the catalog where it cannot function.
 */

import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";

export const WIFI_APP_NAME = "@elizaos/plugin-wifi";

export const wifiApp: OverlayApp = {
  name: WIFI_APP_NAME,
  displayName: "WiFi",
  description: "Scan, inspect, and connect to nearby Wi-Fi networks",
  category: "system",
  icon: null,
  androidOnly: true,
  loader: () =>
    import("./WifiAppView").then((m) => ({ default: m.WifiAppView })),
};

/** Register the WiFi app with the overlay app registry. */
export function registerWifiApp(): void {
  registerOverlayApp(wifiApp);
}
