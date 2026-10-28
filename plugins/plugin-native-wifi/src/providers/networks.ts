/**
 * wifiNetworks provider — read-only nearby Wi-Fi network context.
 *
 * Listing nearby networks is state exposure, not an agent operation with side
 * effects. Surfaced as a dynamic provider so the planner can pull network
 * context (signal strength, security state) when relevant.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { WiFiNetwork } from "@elizaos/plugin-native-wifi/bridge";
import { WiFi } from "@elizaos/plugin-native-wifi/bridge";

interface WifiNetworkEntry {
  ssid: string;
  bssid: string;
  rssi: number;
  frequency: number;
  secured: boolean;
}

export const wifiNetworksProvider: Provider = {
  name: "wifiNetworks",
  description:
    "Read-only nearby Wi-Fi networks (ssid, bssid, rssi dBm, frequency MHz, secured). Source: Android WifiManager.scanResults.",
  descriptionCompressed:
    "Wi-Fi networks: ssid, bssid, rssi, frequency, secured.",
  dynamic: true,
  contexts: ["system"],
  contextGate: { anyOf: ["system"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const { networks } = await WiFi.listAvailableNetworks();
      const entries: WifiNetworkEntry[] = networks.map((n: WiFiNetwork) => ({
        ssid: n.ssid,
        bssid: n.bssid,
        rssi: n.rssi,
        frequency: n.frequency,
        secured: n.secured,
      }));

      return {
        text: JSON.stringify({
          wifi_networks: {
            count: entries.length,
            items: entries,
          },
        }),
        values: {
          wifiNetworksAvailable: entries.length > 0,
          wifiNetworkCount: entries.length,
        },
        data: {
          networks: entries,
          count: entries.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed scan is planner context, not a successful empty list: the
      // phone call-log provider reports a failed native read the same way.
      // Empty text would make a denied permission or a radio that is off look
      // like "there are no networks nearby".
      runtime.reportError?.("wifiNetworks.provider", error);
      return {
        text: JSON.stringify({ wifi_networks: { error: message } }),
        values: {
          wifiNetworksAvailable: false,
          wifiNetworkCount: 0,
          wifiNetworksError: message,
        },
        data: {
          networks: [],
          count: 0,
          error: message,
        },
      };
    }
  },
};
