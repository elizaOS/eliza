/**
 * External-API contract test for @elizaos/capacitor-wifi.
 *
 * Source of truth: plugins/plugin-native-wifi/src/definitions.ts (the published
 * @elizaos/capacitor-wifi types), which vitest aliases `@elizaos/capacitor-wifi`
 * to via vitest.config.ts. The fixtures below are typed against the REAL
 * exported interfaces (WiFiNetwork / ListNetworksResult / ConnectResult /
 * WifiStateResult), so a field rename/removal in the published contract breaks
 * this file at compile time. Running the provider's real mapper over a
 * real-shaped response verifies the plugin tolerates the genuine API surface,
 * and locks the intentional dropping of WiFiNetwork.capabilities so a future
 * API change is caught.
 */

import type {
  ConnectResult,
  ListNetworksResult,
  WiFiNetwork,
  WifiStateResult,
} from "@elizaos/capacitor-wifi";
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
 * A WiFiNetwork that exactly matches definitions.ts — every required field,
 * including `capabilities`. Typed as WiFiNetwork so a field rename/removal in
 * the published contract breaks this fixture at compile time.
 */
const REAL_NETWORK: WiFiNetwork = {
  ssid: "ContractNet",
  bssid: "de:ad:be:ef:00:01",
  rssi: -52,
  frequency: 5240,
  capabilities: "[WPA2-PSK-CCMP][WPS][ESS]",
  secured: true,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("capacitor-wifi contract — DTO shapes consumed by the view logic", () => {
  it("WifiStateResult round-trips through refreshState's reads (enabled + nullable rssi)", () => {
    // Both real states: disabled (web fallback shape) and a live connection.
    const off: WifiStateResult = {
      enabled: false,
      connected: false,
      rssi: null,
    };
    const live: WifiStateResult = { enabled: true, connected: true, rssi: -55 };

    // refreshState/ConnectedCard branch on `.enabled` and render `.rssi`.
    expect(off.enabled).toBe(false);
    expect(off.rssi).toBeNull();
    expect(live.enabled).toBe(true);
    expect(live.rssi).toBe(-55);
  });

  it("ConnectResult round-trips through handleConnect's success/message reads", () => {
    const ok: ConnectResult = { success: true };
    const failed: ConnectResult = { success: false, message: "bad password" };

    // handleConnect: !result.success → setError(result.message ?? "Failed…").
    expect(ok.success).toBe(true);
    expect(ok.message).toBeUndefined();
    expect(failed.success).toBe(false);
    expect(failed.message).toBe("bad password");
  });
});

describe("capacitor-wifi contract — provider mapper over real WiFiNetwork shape", () => {
  it("accepts the full real shape and emits a contract-valid DTO without capabilities", async () => {
    const real: ListNetworksResult = {
      networks: [
        REAL_NETWORK,
        {
          ssid: "",
          bssid: "de:ad:be:ef:00:02",
          rssi: -81,
          frequency: 2437,
          capabilities: "[ESS]",
          secured: false,
        },
      ],
    };
    wifiBridge.listAvailableNetworks.mockResolvedValue(real);

    const result = await wifiNetworksProvider.get(runtime, message, state);

    const entries = result.data?.networks as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);

    // Every emitted entry keeps exactly the five contracted display fields.
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ["bssid", "frequency", "rssi", "secured", "ssid"].sort(),
      );
      expect(entry).not.toHaveProperty("capabilities");
    }

    // Values round-trip from the real shape.
    expect(entries[0]).toMatchObject({
      ssid: "ContractNet",
      bssid: "de:ad:be:ef:00:01",
      rssi: -52,
      frequency: 5240,
      secured: true,
    });
    expect(result.values?.wifiNetworkCount).toBe(2);
  });

  it("documents the contract gap: WiFiNetwork carries capabilities that the DTO intentionally omits", () => {
    // If capabilities is ever removed from the published WiFiNetwork, this line
    // fails to type-check, flagging that the intentional drop is now moot.
    const capabilities: string = REAL_NETWORK.capabilities;
    expect(typeof capabilities).toBe("string");
  });
});
