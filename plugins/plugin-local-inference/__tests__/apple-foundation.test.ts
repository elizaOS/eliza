import { beforeEach, describe, expect, it } from "vitest";
import type {
  IosBridgeResult,
  IosComputerUseBridge,
} from "@elizaos/plugin-computeruse";
import {
  _resetAppleFoundationAdapterForTests,
  createAppleFoundationAdapter,
  getAppleFoundationAdapter,
  registerAppleFoundationAdapter,
} from "../src/backends/apple-foundation.js";

function makeBridge(overrides: Partial<IosComputerUseBridge> = {}): IosComputerUseBridge {
  const stub = <T,>(): Promise<IosBridgeResult<T>> =>
    Promise.resolve({ ok: false, code: "internal_error", message: "stub" });
  return {
    probe: () =>
      Promise.resolve({
        ok: true,
        data: {
          platform: "ios",
          osVersion: "26.1",
          capabilities: {
            replayKitForeground: true,
            broadcastExtension: false,
            visionOcr: true,
            appIntents: true,
            accessibilityRead: true,
            foundationModel: true,
          },
        },
      }),
    replayKitForegroundStart: stub,
    replayKitForegroundStop: stub,
    replayKitForegroundDrain: stub,
    broadcastExtensionHandshake: stub,
    visionOcr: stub,
    appIntentList: () =>
      Promise.resolve({ ok: true, data: { intents: [] } }),
    appIntentInvoke: stub,
    accessibilitySnapshot: stub,
    foundationModelGenerate: () =>
      Promise.resolve({
        ok: true,
        data: { text: "stub-out", tokensIn: 1, tokensOut: 2, elapsedMs: 5 },
      }),
    memoryPressureProbe: () =>
      Promise.resolve({
        ok: true,
        data: {
          source: "ios-uikit",
          capturedAt: 0,
          severity: 0,
          availableMb: 1024,
          broadcastActive: false,
        },
      }),
    ...overrides,
  };
}

describe("apple-foundation adapter", () => {
  beforeEach(() => {
    _resetAppleFoundationAdapterForTests();
  });

  it("returns false from available() before the probe resolves and then flips true", async () => {
    const adapter = createAppleFoundationAdapter(() => makeBridge());
    expect(adapter.available()).toBe(false);
    // Trigger probe via a generate cycle to force it to settle.
    const result = await adapter.generate({ prompt: "hi" });
    expect(result.text).toBe("stub-out");
    // Re-trigger probe by calling available; the cached value should resolve.
    // Note: probe is async; we wait one microtask to let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.available()).toBe(true);
  });

  it("available() reports false when bridge probe says foundationModel:false", async () => {
    const bridge = makeBridge({
      probe: () =>
        Promise.resolve({
          ok: true,
          data: {
            platform: "ios",
            osVersion: "26.1",
            capabilities: {
              replayKitForeground: true,
              broadcastExtension: false,
              visionOcr: true,
              appIntents: true,
              accessibilityRead: true,
              foundationModel: false,
            },
          },
        }),
    });
    const adapter = createAppleFoundationAdapter(() => bridge);
    // Force the probe to run by calling available once + microtask.
    adapter.available();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.available()).toBe(false);
  });

  it("generate throws when the bridge is null", async () => {
    const adapter = createAppleFoundationAdapter(() => null);
    await expect(adapter.generate({ prompt: "hi" })).rejects.toThrow(
      /not registered/,
    );
  });

  it("generate surfaces bridge error code/message", async () => {
    const bridge = makeBridge({
      foundationModelGenerate: () =>
        Promise.resolve({
          ok: false,
          code: "foundation_model_unavailable",
          message: "Apple Intelligence disabled",
        }),
    });
    const adapter = createAppleFoundationAdapter(() => bridge);
    await expect(adapter.generate({ prompt: "hi" })).rejects.toThrow(
      /foundation_model_unavailable/,
    );
  });

  it("register / get cycle returns the same adapter", () => {
    const adapter = createAppleFoundationAdapter(() => makeBridge());
    expect(getAppleFoundationAdapter()).toBeNull();
    registerAppleFoundationAdapter(adapter);
    expect(getAppleFoundationAdapter()).toBe(adapter);
  });

  // ── Capability-probe contract (WS10 cross-review) ────────────────────────

  it("capability probe — iOS 26+ with foundationModel:true flips available to true", async () => {
    const adapter = createAppleFoundationAdapter(() =>
      makeBridge({
        probe: () =>
          Promise.resolve({
            ok: true,
            data: {
              platform: "ios",
              osVersion: "26.2",
              capabilities: {
                replayKitForeground: true,
                broadcastExtension: false,
                visionOcr: true,
                appIntents: true,
                accessibilityRead: true,
                foundationModel: true,
              },
            },
          }),
      }),
    );
    expect(adapter.available()).toBe(false);
    // Drive a probe by triggering available()
    adapter.available();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.available()).toBe(true);
  });

  it("capability probe — iOS 17 (no foundationModel capability) keeps available false", async () => {
    const adapter = createAppleFoundationAdapter(() =>
      makeBridge({
        probe: () =>
          Promise.resolve({
            ok: true,
            data: {
              platform: "ios",
              osVersion: "17.6",
              capabilities: {
                replayKitForeground: true,
                broadcastExtension: false,
                visionOcr: true,
                appIntents: true,
                accessibilityRead: true,
                foundationModel: false,
              },
            },
          }),
      }),
    );
    adapter.available();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.available()).toBe(false);
  });

  it("capability probe — failure arm (`probe.ok:false`) keeps available false", async () => {
    const adapter = createAppleFoundationAdapter(() =>
      makeBridge({
        probe: () =>
          Promise.resolve({
            ok: false,
            code: "internal_error",
            message: "could not query Apple Intelligence status",
          }),
      }),
    );
    adapter.available();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.available()).toBe(false);
  });

  it("registered adapter is discoverable from the WS9 cross-review entry point", () => {
    const adapter = createAppleFoundationAdapter(() => makeBridge());
    registerAppleFoundationAdapter(adapter);
    const found = getAppleFoundationAdapter();
    expect(found).toBe(adapter);
    expect(found!.name).toBe("apple-foundation");
    // The runtime side that wires up `registerAppleFoundationAdapter` does
    // so only when the iOS bridge probe reports `foundationModel:true`. The
    // adapter exposes a structural `LocalInferenceRuntimeService`-compatible
    // surface — `generate` is the relevant entry point.
    expect(typeof found!.generate).toBe("function");
  });
});
