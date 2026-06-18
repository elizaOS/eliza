import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const wifiBridge = vi.hoisted(() => ({
  listAvailableNetworks: vi.fn(),
}));

vi.mock("@elizaos/capacitor-wifi", () => ({
  WiFi: wifiBridge,
}));

import { wifiNetworksProvider } from "./networks";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;
const state = {} as State;

/**
 * Real-shaped WiFiNetwork[] (matches @elizaos/capacitor-wifi definitions.ts,
 * including the `capabilities` field). The provider must tolerate the full
 * shape and intentionally drop `capabilities` from its emitted entries.
 */
function realNetworks() {
  return [
    {
      ssid: "HomeNet",
      bssid: "aa:bb:cc:dd:ee:01",
      rssi: -45,
      frequency: 5180,
      capabilities: "[WPA2-PSK-CCMP][ESS]",
      secured: true,
    },
    {
      ssid: "Cafe",
      bssid: "aa:bb:cc:dd:ee:02",
      rssi: -72,
      frequency: 2412,
      capabilities: "[ESS]",
      secured: false,
    },
  ];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("wifiNetworksProvider — declaration", () => {
  it("is a dynamic, turn-scoped, system-gated provider", () => {
    expect(wifiNetworksProvider.name).toBe("wifiNetworks");
    expect(wifiNetworksProvider.dynamic).toBe(true);
    expect(wifiNetworksProvider.cacheScope).toBe("turn");
    expect(wifiNetworksProvider.contextGate).toEqual({ anyOf: ["system"] });
  });
});

describe("wifiNetworksProvider — success mapping", () => {
  it("maps real-shaped networks to {ssid,bssid,rssi,frequency,secured}, dropping capabilities", async () => {
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: realNetworks(),
    });

    const result = await wifiNetworksProvider.get(runtime, message, state);

    // Bridge called with the provider's own 25-network cap.
    expect(wifiBridge.listAvailableNetworks).toHaveBeenCalledWith({
      limit: 25,
    });

    expect(result.data?.networks).toEqual([
      {
        ssid: "HomeNet",
        bssid: "aa:bb:cc:dd:ee:01",
        rssi: -45,
        frequency: 5180,
        secured: true,
      },
      {
        ssid: "Cafe",
        bssid: "aa:bb:cc:dd:ee:02",
        rssi: -72,
        frequency: 2412,
        secured: false,
      },
    ]);
    // `capabilities` is intentionally dropped — assert it never leaks through.
    for (const entry of result.data?.networks as Array<
      Record<string, unknown>
    >) {
      expect(entry).not.toHaveProperty("capabilities");
    }

    expect(result.data?.count).toBe(2);
    expect(result.data?.limit).toBe(25);
    expect(result.values?.wifiNetworksAvailable).toBe(true);
    expect(result.values?.wifiNetworkCount).toBe(2);
    expect(result.values?.wifiNetworksError).toBeUndefined();

    const parsed = JSON.parse(result.text ?? "");
    expect(parsed.wifi_networks.count).toBe(2);
    expect(parsed.wifi_networks.items).toHaveLength(2);
    expect(parsed.wifi_networks.items[0]).toEqual({
      ssid: "HomeNet",
      bssid: "aa:bb:cc:dd:ee:01",
      rssi: -45,
      frequency: 5180,
      secured: true,
    });
  });

  it("reports availability false and count 0 for an empty scan", async () => {
    wifiBridge.listAvailableNetworks.mockResolvedValue({ networks: [] });

    const result = await wifiNetworksProvider.get(runtime, message, state);

    expect(result.values?.wifiNetworksAvailable).toBe(false);
    expect(result.values?.wifiNetworkCount).toBe(0);
    expect(result.data?.count).toBe(0);
    const parsed = JSON.parse(result.text ?? "");
    expect(parsed.wifi_networks.count).toBe(0);
    expect(parsed.wifi_networks.items).toEqual([]);
  });
});

describe("wifiNetworksProvider — error branch", () => {
  it("maps a rejected scan to wifiNetworksError + empty networks + limit 25", async () => {
    wifiBridge.listAvailableNetworks.mockRejectedValue(
      new Error("ACCESS_FINE_LOCATION denied"),
    );

    const result = await wifiNetworksProvider.get(runtime, message, state);

    expect(result.text).toBe("");
    expect(result.values?.wifiNetworksAvailable).toBe(false);
    expect(result.values?.wifiNetworkCount).toBe(0);
    expect(result.values?.wifiNetworksError).toBe(
      "ACCESS_FINE_LOCATION denied",
    );
    expect(result.data?.networks).toEqual([]);
    expect(result.data?.count).toBe(0);
    expect(result.data?.limit).toBe(25);
    expect(result.data?.error).toBe("ACCESS_FINE_LOCATION denied");
  });

  it("stringifies non-Error throws into wifiNetworksError", async () => {
    wifiBridge.listAvailableNetworks.mockRejectedValue("scan throttled");

    const result = await wifiNetworksProvider.get(runtime, message, state);

    expect(result.values?.wifiNetworksError).toBe("scan throttled");
    expect(result.data?.error).toBe("scan throttled");
  });
});
