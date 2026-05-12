/**
 * elizaOS runtime plugin for the WiFi app: surfaces nearby Wi-Fi networks as
 * a read-only wifiNetworks provider. Listing networks is read-only context,
 * not a side-effecting action. The agent Android adapter applies hosted-app
 * session gating when this package's `/plugin` export is registered.
 */

import type { Plugin } from "@elizaos/core";
import { wifiNetworksProvider } from "./providers/networks";

const WIFI_APP_NAME = "@elizaos/app-wifi";

export const appWifiPlugin: Plugin = {
  name: WIFI_APP_NAME,
  description:
    "WiFi overlay: list nearby networks via Android WifiManager. The list is " +
    "surfaced as a read-only provider; the provider only resolves while the " +
    "WiFi app session is active.",
  providers: [wifiNetworksProvider],
};

export default appWifiPlugin;

export { wifiNetworksProvider } from "./providers/networks";
