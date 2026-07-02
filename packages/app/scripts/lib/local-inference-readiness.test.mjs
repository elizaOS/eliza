// #11498: the mobile-local-chat-smoke readiness gate must accept the Android
// in-process bionic-host serving path (capacitor-llama servingVia) alongside
// the hub-active and paired-device-bridge branches — and still fail loudly
// when nothing can serve.
import { describe, expect, it } from "vitest";
import { evaluateLocalInferenceReadiness } from "./local-inference-readiness.mjs";

const capacitorLlama = (overrides = {}) => ({
  id: "capacitor-llama",
  servingVia: null,
  ...overrides,
});

describe("evaluateLocalInferenceReadiness (#11498)", () => {
  it("is NOT ready when every snapshot is missing (endpoints 404 on device)", () => {
    expect(
      evaluateLocalInferenceReadiness({
        hub: null,
        device: null,
        providers: null,
      }),
    ).toEqual({ ready: false, via: null, error: null });
  });

  it("accepts hub.active.status === 'ready' (desktop hub activation)", () => {
    const result = evaluateLocalInferenceReadiness({
      hub: { active: { status: "ready" } },
      device: null,
      providers: null,
    });
    expect(result).toEqual({ ready: true, via: "hub-active", error: null });
  });

  it("accepts a paired device bridge with a loaded model path", () => {
    const result = evaluateLocalInferenceReadiness({
      hub: { active: { status: "idle" } },
      device: { connected: true, modelPath: "/data/models/eliza-1-2b.gguf" },
      providers: null,
    });
    expect(result).toEqual({ ready: true, via: "device-bridge", error: null });
  });

  it("rejects a connected device bridge without a model path", () => {
    const result = evaluateLocalInferenceReadiness({
      hub: null,
      device: { connected: true, modelPath: "   " },
      providers: null,
    });
    expect(result.ready).toBe(false);
  });

  it("accepts the in-process bionic-host serving signal (the #11498 path)", () => {
    // Exact on-device shape: hub idle, device disconnected, bionic serving.
    const result = evaluateLocalInferenceReadiness({
      hub: { active: { status: "idle" } },
      device: { connected: false, modelPath: null },
      providers: {
        providers: [capacitorLlama({ servingVia: "bionic-host" })],
      },
    });
    expect(result).toEqual({ ready: true, via: "bionic-host", error: null });
  });

  it("does NOT treat a present-but-not-serving capacitor-llama provider as ready", () => {
    for (const servingVia of [null, undefined, "device-bridge"]) {
      const result = evaluateLocalInferenceReadiness({
        hub: { active: { status: "idle" } },
        device: { connected: false },
        providers: { providers: [capacitorLlama({ servingVia })] },
      });
      // servingVia==="device-bridge" implies device.connected, which the
      // device snapshot above contradicts — the gate keys on the device
      // branch for that path, so this stays not-ready.
      expect(result.ready).toBe(false);
    }
  });

  it("ignores servingVia on providers other than capacitor-llama", () => {
    const result = evaluateLocalInferenceReadiness({
      hub: null,
      device: null,
      providers: {
        providers: [{ id: "eliza-local-inference", servingVia: "bionic-host" }],
      },
    });
    expect(result.ready).toBe(false);
  });

  it("surfaces hub error state as a hard failure, not keep-polling", () => {
    const result = evaluateLocalInferenceReadiness({
      hub: { active: { status: "error", error: "bundle_dir does not exist" } },
      device: null,
      providers: {
        providers: [capacitorLlama({ servingVia: "bionic-host" })],
      },
    });
    expect(result.ready).toBe(false);
    expect(result.error).toBe(
      "Local inference hub is in error state: bundle_dir does not exist",
    );
  });

  it("hub error without a message reports 'unknown'", () => {
    const result = evaluateLocalInferenceReadiness({
      hub: { active: { status: "error" } },
      device: null,
      providers: null,
    });
    expect(result.error).toBe("Local inference hub is in error state: unknown");
  });
});
