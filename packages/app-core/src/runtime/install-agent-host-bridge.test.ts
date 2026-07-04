/**
 * Verifies installAgentHostBridge() swaps the agent host-bridge seam from its
 * no-op default to the app-core implementation, exposing real vault /
 * account-pool / shared-vault / build-variant / cloud-pair-route capabilities.
 * Drives the real host-bridge singleton (reset before and after) — no runtime
 * boot.
 */
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  getAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { describe, expect, it } from "vitest";
import {
  installAgentHostBridge,
  isAgentHostBridgeInstalled,
} from "./install-agent-host-bridge";

describe("installAgentHostBridge", () => {
  it("wires app-core host capabilities into the agent host-bridge seam", () => {
    _resetAgentHostBridge();
    expect(getAgentHostBridge()).toBe(defaultAgentHostBridge);

    installAgentHostBridge();

    expect(isAgentHostBridgeInstalled()).toBe(true);
    const bridge = getAgentHostBridge();
    // The app-core bridge replaces the no-op default with real implementations.
    expect(bridge).not.toBe(defaultAgentHostBridge);
    expect(typeof bridge.runVaultBootstrap).toBe("function");
    expect(typeof bridge.getDefaultAccountPool).toBe("function");
    expect(typeof bridge.sharedVault).toBe("function");
    expect(typeof bridge.getBuildVariant).toBe("function");
    expect(typeof bridge.handleCloudPairRoute).toBe("function");

    _resetAgentHostBridge();
  });
});
