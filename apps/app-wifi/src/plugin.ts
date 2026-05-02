/**
 * elizaOS runtime plugin for the WiFi app — exposes a single SCAN_WIFI action,
 * gated to the WiFi app's session.
 */

import type { Plugin } from "@elizaos/core";
import { scanWifiAction } from "./actions/scan-wifi";

const WIFI_APP_NAME = "@elizaos/app-wifi";

export const appWifiPlugin: Plugin = {
  name: WIFI_APP_NAME,
  description:
    "WiFi overlay: list nearby networks via Android WifiManager. " +
    "Actions apply only while the WiFi app session is active.",
  actions: [scanWifiAction],
};

export default appWifiPlugin;

export { scanWifiAction } from "./actions/scan-wifi";
