/**
 * WiFi overlay app definition + registration.
 *
 * Registered as a side-effect from `@elizaos/app-wifi/register` only on
 * Android; other platforms intentionally skip registration so the app does
 * not appear in the catalog where it cannot function.
 */

import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { WifiAppView } from "./WifiAppView";

export const WIFI_APP_NAME = "@elizaos/app-wifi";

export const wifiApp: OverlayApp = {
  name: WIFI_APP_NAME,
  displayName: "WiFi",
  description: "Scan, inspect, and connect to nearby Wi-Fi networks",
  category: "system",
  icon: null,
  androidOnly: true,
  Component: WifiAppView,
};

/** Register the WiFi app with the overlay app registry. */
export function registerWifiApp(): void {
  registerOverlayApp(wifiApp);
}
