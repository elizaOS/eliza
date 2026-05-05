import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wifiMock = vi.hoisted(() => ({
  listAvailableNetworks: vi.fn(),
}));

vi.mock("@elizaos/capacitor-wifi", () => ({
  WiFi: wifiMock,
}));

import { scanWifiAction } from "./scan-wifi";

describe("SCAN_WIFI", () => {
  beforeEach(() => {
    wifiMock.listAvailableNetworks.mockReset();
  });

  it("clamps limit and maxAge before scanning via the Android WiFi plugin", async () => {
    const networks = [
      {
        ssid: "Milady",
        bssid: "00:11:22:33:44:55",
        rssi: -42,
        frequency: 5180,
        capabilities: "[WPA2-PSK-CCMP][ESS]",
        secured: true,
      },
    ];
    wifiMock.listAvailableNetworks.mockResolvedValue({ networks });

    const result = await scanWifiAction.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: { limit: 250, maxAge: -100 } } satisfies HandlerOptions,
    );

    expect(wifiMock.listAvailableNetworks).toHaveBeenCalledWith({
      limit: 100,
      maxAge: 0,
    });
    expect(result).toMatchObject({
      success: true,
      data: { networks, limit: 100 },
    });
  });
});
