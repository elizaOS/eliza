import { afterEach, describe, expect, it } from "vitest";
import { type BridgeTransport, getBridgeTransport } from "../transport";

declare global {
  interface Window {
    __elizaAndroidBridge?: unknown;
    ElizaAndroidSystemBridgeNative?: unknown;
  }
}

function clearBridge() {
  if (typeof window !== "undefined") {
    delete window.__elizaAndroidBridge;
    delete window.ElizaAndroidSystemBridgeNative;
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

  it("adapts the native Android Java bridge into the transport shape", async () => {
    const subscriptions: string[] = [];
    const commands: Array<{ channel: string; payload: string }> = [];
    window.ElizaAndroidSystemBridgeNative = {
      subscribe: (channel: string) => {
        subscriptions.push(channel);
        return "sub-1";
      },
      unsubscribe: (id: string) => {
        subscriptions.push(`unsubscribe:${id}`);
      },
      snapshot: (channel: string) =>
        JSON.stringify({ channel, connected: true }),
      send: (channel: string, payload: string) => {
        commands.push({ channel, payload });
        return JSON.stringify({ ok: true });
      },
    };

    const transport = getBridgeTransport();
    expect(transport).not.toBeNull();
    if (!transport) {
      throw new Error("expected native bridge transport");
    }
    expect(window.__elizaAndroidBridge).toBe(transport);

    const payloads: unknown[] = [];
    const unsubscribe = transport.on("eliza.android.wifi.state", (payload) =>
      payloads.push(payload),
    );
    expect(payloads).toEqual([
      { channel: "eliza.android.wifi.state", connected: true },
    ]);
    unsubscribe();
    await expect(
      transport.send("eliza.android.audio.setMuted", { muted: true }),
    ).resolves.toEqual({ ok: true });
    expect(subscriptions).toEqual([
      "eliza.android.wifi.state",
      "unsubscribe:sub-1",
    ]);
    expect(commands).toEqual([
      {
        channel: "eliza.android.audio.setMuted",
        payload: '{"muted":true}',
      },
    ]);
  });
});
