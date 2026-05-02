/**
 * SCAN_WIFI action — returns nearby Wi-Fi networks.
 *
 * Wraps `@elizaos/capacitor-wifi`'s `listAvailableNetworks`. The native plugin
 * triggers a `WifiManager.startScan` on Android (or reuses a recent scan if
 * within `maxAge` of the previous one) and reads `scanResults`. Requires
 * `ACCESS_FINE_LOCATION` to be granted on device for the platform to
 * populate the list. Session-gated at the plugin level; web/iOS fallback
 * returns an empty list.
 */

import { WiFi } from "@elizaos/capacitor-wifi";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasRoleAccess } from "@elizaos/shared/eliza-core-roles";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface ScanWifiParams {
  limit?: number;
  maxAge?: number;
}

export const scanWifiAction: Action = {
  name: "SCAN_WIFI",
  similes: ["LIST_WIFI", "WIFI_SCAN", "NEARBY_WIFI", "WIFI_NETWORKS"],
  description:
    "List nearby Wi-Fi networks visible to the device. Returns SSID, BSSID, " +
    "RSSI (signal strength), channel frequency, and whether the network is " +
    "secured. Triggers a fresh scan when the cached results are older than " +
    "`maxAge` milliseconds (default 30000). Requires the WiFi app session " +
    "to be active and ACCESS_FINE_LOCATION granted on device.",
  descriptionCompressed: "List nearby Wi-Fi networks (Android scanResults).",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ScanWifiParams
      | undefined;
    const requested =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, requested));
    const maxAge =
      typeof params?.maxAge === "number" && Number.isFinite(params.maxAge)
        ? Math.max(0, Math.floor(params.maxAge))
        : undefined;

    const { networks } = await WiFi.listAvailableNetworks({ limit, maxAge });

    return {
      text: `Found ${networks.length} Wi-Fi network${networks.length === 1 ? "" : "s"}.`,
      success: true,
      data: { networks, limit },
    };
  },

  parameters: [
    {
      name: "limit",
      description:
        "Maximum number of networks to return (1-100). Defaults to 25.",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
      },
    },
    {
      name: "maxAge",
      description:
        "Reuse cached scan results if completed within this many milliseconds. " +
        "Defaults to 30000 (30 seconds). Set to 0 to force a fresh scan.",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 0,
      },
    },
  ],
};
