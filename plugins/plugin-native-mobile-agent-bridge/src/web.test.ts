/** Exercises real web tunnel validation, error notifications and return to idle. */
import { describe, expect, it, vi } from "vitest";

import { MobileAgentBridgeWeb } from "./web";

describe("MobileAgentBridgeWeb fallback", () => {
  it.each([
    { relayUrl: "", deviceId: "device-1" },
    { relayUrl: "javascript:alert(1)", deviceId: "device-1" },
    { relayUrl: "file:///tmp/socket", deviceId: "device-1" },
    { relayUrl: "wss://user:pass@example.test/relay", deviceId: "device-1" },
    { relayUrl: "wss://example.test/relay", deviceId: "" },
    { relayUrl: "wss://example.test/relay", deviceId: "../escape" },
  ])("rejects malformed tunnel options %#", async (options) => {
    const plugin = new MobileAgentBridgeWeb();
    const listener = vi.fn();
    await plugin.addListener("stateChange", listener);

    await expect(plugin.startInboundTunnel(options)).rejects.toThrow(/relayUrl|deviceId/);
    await expect(plugin.getTunnelStatus()).resolves.toEqual({
      state: "idle",
      relayUrl: null,
      deviceId: null,
      lastError: null,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes valid options, emits an error state, and returns to idle on stop", async () => {
    const plugin = new MobileAgentBridgeWeb();
    const listener = vi.fn();
    await plugin.addListener("stateChange", listener);

    await expect(
      plugin.startInboundTunnel({
        relayUrl: "wss://relay.example/tunnel",
        deviceId: " device-1 ",
        pairingToken: "<script>",
      }),
    ).resolves.toEqual({
      state: "error",
      relayUrl: "wss://relay.example/tunnel",
      deviceId: "device-1",
      lastError: "MobileAgentBridge.startInboundTunnel is only available on iOS and Android.",
    });
    expect(listener).toHaveBeenCalledWith({
      state: "error",
      reason: "MobileAgentBridge.startInboundTunnel is only available on iOS and Android.",
    });

    await plugin.stopInboundTunnel();
    await expect(plugin.getTunnelStatus()).resolves.toEqual({
      state: "idle",
      relayUrl: null,
      deviceId: null,
      lastError: null,
    });
    expect(listener).toHaveBeenLastCalledWith({ state: "idle" });
  });
});
