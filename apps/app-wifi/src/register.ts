/**
 * Side-effect entry point — registers the WiFi overlay app on Android only.
 *
 * Web, iOS, and desktop register a no-op so importing
 * `@elizaos/app-wifi/register` never throws on those platforms.
 *
 * Usage:
 *   import "@elizaos/app-wifi/register";
 */

import { Capacitor } from "@capacitor/core";
import { registerWifiApp } from "./components/wifi-app";

if (Capacitor.getPlatform() === "android") {
  registerWifiApp();
}
