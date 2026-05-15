/**
 * Side-effect entry point — registers the WiFi overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop register a no-op so loading this
 * module never throws on those platforms.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerWifiApp } from "./components/wifi-app";

if (isElizaOS()) {
  registerWifiApp();
}
