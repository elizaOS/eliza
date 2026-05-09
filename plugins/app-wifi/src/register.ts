/**
 * Side-effect entry point — registers the WiFi overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop register a no-op so importing
 * `@elizaos/app-wifi/register` never throws on those platforms.
 *
 * Usage:
 *   import "@elizaos/app-wifi/register";
 */

import { isElizaOS } from "@elizaos/ui";
import { registerWifiApp } from "./components/wifi-app";

if (isElizaOS()) {
  registerWifiApp();
}
