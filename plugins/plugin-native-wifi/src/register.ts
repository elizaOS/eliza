/**
 * Side-effect entry point — registers the WiFi overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop do not register the overlay app, so
 * loading this module remains safe on those platforms.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerWifiApp } from "./components/wifi-app";

if (isElizaOS()) {
  registerWifiApp();
}
