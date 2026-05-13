/**
 * Capability-detection tests.
 *
 * Exercises the policy encoded in `probeCapabilities`:
 *   - DFlash off when streaming-LLM unsupported.
 *   - DFlash off when the drafter isn't resident.
 *   - DFlash off under serious/critical thermal pressure.
 *   - mmproj gated on bundle residency.
 *   - omnivoice streaming gated on the FFI build's TTS-stream flag.
 *
 * No FFI loaded.  Probes are plain stubs.
 */

import { describe, expect, it } from "vitest";

import {
  type CapabilityProbes,
  defaultsForNoBinding,
  probeCapabilities,
  type ThermalState,
} from "../inference-capabilities";

function probeFromBits(bits: {
  streaming?: boolean;
  ttsStream?: boolean;
  drafter?: boolean;
  mmproj?: boolean;
  thermal?: ThermalState;
  platform?: "android" | "ios" | "desktop" | "unknown";
}): CapabilityProbes {
  return {
    llmStreamSupported: () => bits.streaming ?? false,
    ttsStreamSupported: () => bits.ttsStream ?? false,
    drafterResident: () => bits.drafter ?? false,
    mmprojResident: () => bits.mmproj ?? false,
    thermalState: () => bits.thermal ?? "nominal",
    platform: () => bits.platform ?? "unknown",
  };
}

describe("probeCapabilities", () => {
  it("defaults: every flag off when no bits are set", () => {
    const caps = probeCapabilities(probeFromBits({}));
    expect(caps).toEqual({
      streamingLlm: false,
      dflashSupported: false,
      omnivoiceStreaming: false,
      mmprojSupported: false,
      thermalState: "nominal",
      platform: "unknown",
    });
  });

  it("desktop fully loaded → DFlash + omnivoice + mmproj all on", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: true,
        ttsStream: true,
        drafter: true,
        mmproj: true,
        thermal: "nominal",
        platform: "desktop",
      }),
    );
    expect(caps.streamingLlm).toBe(true);
    expect(caps.dflashSupported).toBe(true);
    expect(caps.omnivoiceStreaming).toBe(true);
    expect(caps.mmprojSupported).toBe(true);
  });

  it("android with streaming but no drafter → DFlash off, streaming on", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: true,
        ttsStream: true,
        drafter: false,
        mmproj: false,
        platform: "android",
      }),
    );
    expect(caps.streamingLlm).toBe(true);
    expect(caps.dflashSupported).toBe(false);
    expect(caps.omnivoiceStreaming).toBe(true);
    expect(caps.mmprojSupported).toBe(false);
  });

  it("serious thermal pressure forces DFlash off", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: true,
        drafter: true,
        thermal: "serious",
        platform: "android",
      }),
    );
    expect(caps.dflashSupported).toBe(false);
  });

  it("critical thermal pressure forces DFlash off", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: true,
        drafter: true,
        thermal: "critical",
        platform: "android",
      }),
    );
    expect(caps.dflashSupported).toBe(false);
  });

  it("fair thermal still allows DFlash", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: true,
        drafter: true,
        thermal: "fair",
        platform: "desktop",
      }),
    );
    expect(caps.dflashSupported).toBe(true);
  });

  it("ios without streaming-LLM bridge → everything off except thermal/platform", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: false,
        ttsStream: false,
        drafter: false,
        mmproj: false,
        thermal: "nominal",
        platform: "ios",
      }),
    );
    expect(caps).toEqual({
      streamingLlm: false,
      dflashSupported: false,
      omnivoiceStreaming: false,
      mmprojSupported: false,
      thermalState: "nominal",
      platform: "ios",
    });
  });

  it("mmproj follows residency probe independent of platform", () => {
    const caps = probeCapabilities(
      probeFromBits({
        streaming: true,
        mmproj: true,
        platform: "android",
      }),
    );
    expect(caps.mmprojSupported).toBe(true);
  });

  it("omnivoice streaming follows ttsStreamSupported only", () => {
    const onlyTts = probeCapabilities(
      probeFromBits({ ttsStream: true, platform: "ios" }),
    );
    expect(onlyTts.omnivoiceStreaming).toBe(true);
    expect(onlyTts.streamingLlm).toBe(false);
  });
});

describe("defaultsForNoBinding", () => {
  it("is all-false with unknown platform + nominal thermal", () => {
    expect(defaultsForNoBinding()).toEqual({
      streamingLlm: false,
      dflashSupported: false,
      omnivoiceStreaming: false,
      mmprojSupported: false,
      thermalState: "nominal",
      platform: "unknown",
    });
  });
});
