/**
 * Pins resolveDefaultIntelligencePanelId: a disconnected cloud-proxy
 * session opens Local, not Cloud, so first paint matches the serving
 * provider (#20045). Deterministic — no React, no window.
 */
import { describe, expect, it } from "vitest";
import { resolveDefaultIntelligencePanelId } from "./useProviderSelection";

describe("resolveDefaultIntelligencePanelId", () => {
  it("opens Local when cloud is selected but not signed in", () => {
    expect(
      resolveDefaultIntelligencePanelId({
        cloudCallsDisabled: false,
        cloudRuntimeLocked: false,
        elizaCloudConnected: false,
        isCloudSelected: true,
        resolvedSelectedId: "__cloud__",
      }),
    ).toBe("__local__");
  });

  it("opens Local when cloud is locked but the account is not signed in", () => {
    expect(
      resolveDefaultIntelligencePanelId({
        cloudCallsDisabled: false,
        cloudRuntimeLocked: true,
        elizaCloudConnected: false,
        isCloudSelected: true,
        resolvedSelectedId: "__cloud__",
      }),
    ).toBe("__local__");
  });

  it("opens Cloud when the account is connected", () => {
    expect(
      resolveDefaultIntelligencePanelId({
        cloudCallsDisabled: false,
        cloudRuntimeLocked: false,
        elizaCloudConnected: true,
        isCloudSelected: true,
        resolvedSelectedId: "__cloud__",
      }),
    ).toBe("__cloud__");
  });

  it("stays on an explicit local-only pin", () => {
    expect(
      resolveDefaultIntelligencePanelId({
        cloudCallsDisabled: true,
        cloudRuntimeLocked: false,
        elizaCloudConnected: false,
        isCloudSelected: false,
        resolvedSelectedId: null,
      }),
    ).toBe("__local__");
  });

  it("does not steal a direct provider selection", () => {
    expect(
      resolveDefaultIntelligencePanelId({
        cloudCallsDisabled: false,
        cloudRuntimeLocked: false,
        elizaCloudConnected: false,
        isCloudSelected: false,
        resolvedSelectedId: "cerebras",
      }),
    ).toBe("cerebras");
  });
});
