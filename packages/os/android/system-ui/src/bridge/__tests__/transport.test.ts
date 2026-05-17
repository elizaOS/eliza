import { afterEach, describe, expect, it } from "vitest";
import { type BridgeTransport, getBridgeTransport } from "../transport";

declare global {
  interface Window {
    __elizaAndroidBridge?: unknown;
  }
}

function clearBridge() {
  if (typeof window !== "undefined") {
    delete window.__elizaAndroidBridge;
  }
}

describe("getBridgeTransport (android)", () => {
  afterEach(() => {
    clearBridge();
  });

  it("returns null when no bridge is installed", () => {
    clearBridge();
    expect(getBridgeTransport()).toBeNull();
  });

  it("returns null when bridge is not a valid BridgeTransport", () => {
    window.__elizaAndroidBridge = { on: "no", send: null };
    expect(getBridgeTransport()).toBeNull();
  });

  it("returns the bridge when shape matches", () => {
    const bridge: BridgeTransport = {
      on: () => () => {},
      send: async () => ({}) as never,
    };
    window.__elizaAndroidBridge = bridge;
    expect(getBridgeTransport()).toBe(bridge);
  });
});
