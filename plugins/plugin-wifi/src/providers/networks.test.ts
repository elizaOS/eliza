/** Exercises real Wi-Fi provider mapping and failures with a deterministic native bridge. */
import type { ListNetworksResult, WiFiNetwork } from "@elizaos/capacitor-wifi";
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
function realNetworks(): WiFiNetwork[] {
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
      ssid: "",
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

describe("wifiNetworksProvider — success mapping", () => {
  it("maps real-shaped networks to {ssid,bssid,rssi,frequency,secured}, dropping capabilities", async () => {
    const response: ListNetworksResult = { networks: realNetworks() };
    wifiBridge.listAvailableNetworks.mockResolvedValue(response);

    const result = await wifiNetworksProvider.get(runtime, message, state);

    expect(wifiBridge.listAvailableNetworks).toHaveBeenCalledWith();

    expect(result.data?.networks).toEqual([
      {
        ssid: "HomeNet",
        bssid: "aa:bb:cc:dd:ee:01",
        rssi: -45,
        frequency: 5180,
        secured: true,
      },
      {
        ssid: "",
        bssid: "aa:bb:cc:dd:ee:02",
        rssi: -72,
        frequency: 2412,
        secured: false,
      },
    ]);
    expect(result.data?.count).toBe(2);
    expect(result.data).not.toHaveProperty("limit");
    expect(result.values?.wifiNetworksAvailable).toBe(true);
    expect(result.values?.wifiNetworkCount).toBe(2);
    expect(result.values?.wifiNetworksError).toBeUndefined();

    expect(JSON.parse(result.text ?? "").wifi_networks).toEqual({
      count: 2,
      items: result.data?.networks,
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
  it("maps a rejected scan to wifiNetworksError and empty networks", async () => {
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
    expect(result.data).not.toHaveProperty("limit");
    expect(result.data?.error).toBe("ACCESS_FINE_LOCATION denied");
  });

  it("stringifies non-Error throws into wifiNetworksError", async () => {
    wifiBridge.listAvailableNetworks.mockRejectedValue("scan throttled");

    const result = await wifiNetworksProvider.get(runtime, message, state);

    expect(result.values?.wifiNetworksError).toBe("scan throttled");
    expect(result.data?.error).toBe("scan throttled");
  });
});
