// @vitest-environment jsdom
//
// Phase 2 of #9953: the fused on-device wake path is bridged to the UI through
// the same useWakeController capabilities contract as Swabble. These tests drive
// fused stages both via an injected source (deterministic) and via the real
// `eliza:fused-wake` window CustomEvent bridge, and prove a synthetic fused wake
// opens the listening window (the bar's mic) — closing the "fused path built +
// tested but never bridged" gap.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Swabble absent so only the fused path is exercised.
vi.mock("../bridge/native-plugins", () => ({
  getSwabblePlugin: () => ({}),
}));

import { emitFusedWake, type FusedWakeEvent } from "./fused-wake-bridge";
import { useWakeController } from "./useWakeController";
import { useWakeListenWindow } from "./useWakeListenWindow";
import type { WakeCapabilities, WakeDetection } from "./wake-controller";

const FUSED_ONLY: WakeCapabilities = {
  openWakeWord: true,
  asrConfirm: true,
  swabble: false,
};

function makeSource() {
  let listener: ((event: FusedWakeEvent) => void) | null = null;
  const source = (l: (event: FusedWakeEvent) => void) => {
    listener = l;
    return () => {
      listener = null;
    };
  };
  const fire = (event: FusedWakeEvent) =>
    act(async () => {
      listener?.(event);
    });
  return { source, fire };
}

function clearFusedFlag() {
  delete (window as { __ELIZA_FUSED_WAKE__?: boolean }).__ELIZA_FUSED_WAKE__;
}

describe("useWakeController — fused on-device path", () => {
  afterEach(() => {
    clearFusedFlag();
    vi.clearAllMocks();
  });

  it("emits a head-fast-path detection on a fused head-fire", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    const { source, fire } = makeSource();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza", // shipped head → head-fast-path
        capabilities: FUSED_ONLY,
        onWake,
        fusedWakeSource: source,
      }),
    );
    await fire({ stage: "head-fired", confidence: 0.92 });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].path).toBe("head-fast-path");
    expect(onWake.mock.calls[0][0].confidence).toBe(0.92);
  });

  it("confirms a two-stage detection (Stage-A candidate → Stage-B transcript)", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    const { source, fire } = makeSource();
    let t = 1000;
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "ada", // no head → two-stage ASR
        capabilities: FUSED_ONLY,
        onWake,
        fusedWakeSource: source,
        now: () => t,
      }),
    );
    await fire({ stage: "stage-a-candidate" });
    expect(onWake).not.toHaveBeenCalled();
    t = 1200;
    await fire({
      stage: "stage-b-transcript",
      transcript: "hey ada what's up",
    });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].path).toBe("two-stage-asr");
  });

  it("does not subscribe to the fused path when openWakeWord is not declared", async () => {
    const onWake = vi.fn();
    const { source, fire } = makeSource();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        capabilities: {
          openWakeWord: false,
          asrConfirm: false,
          swabble: false,
        },
        onWake,
        fusedWakeSource: source,
      }),
    );
    await fire({ stage: "head-fired" });
    expect(onWake).not.toHaveBeenCalled();
  });

  it("drives detection through the real eliza:fused-wake window bridge", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        capabilities: FUSED_ONLY,
        onWake,
        // default fusedWakeSource = subscribeFusedWake (real window CustomEvent)
      }),
    );
    await act(async () => {
      emitFusedWake({ stage: "head-fired", confidence: 0.8 });
    });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].path).toBe("head-fast-path");
  });

  it("auto-detects the fused path from window.__ELIZA_FUSED_WAKE__", async () => {
    (window as { __ELIZA_FUSED_WAKE__?: boolean }).__ELIZA_FUSED_WAKE__ = true;
    const onWake = vi.fn<(d: WakeDetection) => void>();
    const { result } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake, // no capabilities override → default probes the window flag
      }),
    );
    expect(result.current.capabilities.openWakeWord).toBe(true);
    expect(result.current.path).toBe("head-fast-path");
    await act(async () => {
      emitFusedWake({ stage: "head-fired" });
    });
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});

describe("useWakeListenWindow — fused wake opens the bar", () => {
  afterEach(() => {
    clearFusedFlag();
  });

  it("opens the listening window (mic/bar) on a synthetic fused head-fire", async () => {
    (window as { __ELIZA_FUSED_WAKE__?: boolean }).__ELIZA_FUSED_WAKE__ = true;
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const t = 1000;
    const { result } = renderHook(() =>
      useWakeListenWindow({
        enabled: true,
        alwaysOn: false,
        agentBusy: false,
        characterName: "eliza",
        onOpen,
        onClose,
        now: () => t,
        tickMs: 500,
      }),
    );
    await act(async () => {
      emitFusedWake({ stage: "head-fired", confidence: 0.9 });
    });
    expect(result.current.phase).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
