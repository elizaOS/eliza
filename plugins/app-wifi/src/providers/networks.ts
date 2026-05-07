/**
 * wifiNetworks provider — read-only nearby Wi-Fi network context.
 *
 * Listing nearby networks is state exposure, not an agent operation with side
 * effects. Surfaced as a dynamic provider so the planner can pull network
 * context (signal strength, security state) when relevant.
 */

import { WiFi } from "@elizaos/capacitor-wifi";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

const WIFI_NETWORKS_LIMIT = 25;

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

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const { networks } = await WiFi.listAvailableNetworks({
        limit: WIFI_NETWORKS_LIMIT,
      });
      const entries: WifiNetworkEntry[] = networks.map((n) => ({
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
          limit: WIFI_NETWORKS_LIMIT,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: "",
        values: {
          wifiNetworksAvailable: false,
          wifiNetworkCount: 0,
          wifiNetworksError: message,
        },
        data: {
          networks: [],
          count: 0,
          limit: WIFI_NETWORKS_LIMIT,
          error: message,
        },
      };
    }
  },
};
