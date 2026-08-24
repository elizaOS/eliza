/** Verifies useWakeController through the package's configured test harness. */
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwabbleWakeWordEvent } from "../bridge/native-plugins";
import type { FusedWakeEvent } from "./fused-wake-bridge";

// Capture the registered wakeWord listener so tests can fire native detections.
let wakeListener: ((e?: SwabbleWakeWordEvent) => void) | null = null;
const removeSpy = vi.fn(async () => {});

vi.mock("../bridge/native-plugins", () => ({
  getSwabblePlugin: () => ({
    addListener: async (
      _event: string,
      fn: (e?: SwabbleWakeWordEvent) => void,
    ) => {
      wakeListener = fn;
      return { remove: removeSpy };
    },
  }),
}));

import { useWakeController } from "./useWakeController";
import type { WakeCapabilities, WakeDetection } from "./wake-controller";

function fireWake(event?: SwabbleWakeWordEvent) {
  return act(async () => {
    await Promise.resolve();
    wakeListener?.(event);
  });
}

const FUSED: WakeCapabilities = {
  openWakeWord: true,
  asrConfirm: true,
  swabble: true,
};

describe("useWakeController", () => {
  beforeEach(() => {
    wakeListener = null;
    removeSpy.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes a Swabble wake through as a swabble-fallback detection", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake,
      }),
    );

    await fireWake({
      wakeWord: "eliza",
      command: "what time is it",
      transcript: "hey eliza what time is it",
      postGap: 0.3,
      confidence: 0.9,
    });

    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0]).toEqual({
      wakeWord: "eliza",
      command: "what time is it",
      transcript: "hey eliza what time is it",
      confidence: 0.9,
      path: "swabble-fallback",
    });
  });

  it("tolerates a no-arg native fire (defaults to the character name)", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "ada",
        onWake,
      }),
    );
    await fireWake();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].wakeWord).toBe("ada");
    expect(onWake.mock.calls[0][0].path).toBe("swabble-fallback");
  });

  it("stays inert while always-on (never subscribes)", async () => {
    const onWake = vi.fn();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: true,
        characterName: "eliza",
        onWake,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(wakeListener).toBeNull();
    expect(onWake).not.toHaveBeenCalled();
  });

  it("exposes the selected path from capabilities + name", () => {
    const { result } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        capabilities: FUSED,
        onWake: vi.fn(),
      }),
    );
    // eliza has a shipped head → head fast-path.
    expect(result.current.path).toBe("head-fast-path");
  });

  it("ignores a Swabble wake when a faster (two-stage) path is selected", async () => {
    const onWake = vi.fn();
    const { result } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "ada", // no head → two-stage ASR
        capabilities: FUSED,
        onWake,
      }),
    );
    expect(result.current.path).toBe("two-stage-asr");
    await fireWake({
      wakeWord: "ada",
      command: "go",
      transcript: "hey ada go",
      postGap: 0.2,
    });
    // The controller only honors the selected path's detector — a stray Swabble
    // event on the two-stage path is dropped.
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("useWakeController — subscription lifecycle, reset, and confirm-window edges", () => {
  beforeEach(() => {
    wakeListener = null;
    removeSpy.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeFusedSource() {
    let listener: ((event: FusedWakeEvent) => void) | null = null;
    const source = (l: (event: FusedWakeEvent) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    };
    const fireFused = (event: FusedWakeEvent) =>
      act(async () => {
        listener?.(event);
      });
    return { source, fireFused };
  }

  it("removes the native wakeWord listener on unmount", async () => {
    const { unmount } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake: vi.fn(),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(wakeListener).not.toBeNull();
    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels a still-resolving addListener when unmounted before it lands", async () => {
    const { unmount } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake: vi.fn(),
      }),
    );
    // Unmount synchronously, before the async addListener promise resolves.
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    // The late handle must still be removed — no orphaned native subscription.
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("discards an armed Stage-A candidate when wake is disabled mid-window", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    const { source, fireFused } = makeFusedSource();
    let t = 1000;
    const options = {
      enabled: true,
      alwaysOn: false,
      characterName: "ada", // no shipped head → two-stage ASR
      capabilities: FUSED,
      onWake,
      fusedWakeSource: source,
      now: () => t,
    };
    const { rerender } = renderHook(() => useWakeController(options));

    // Arm a candidate so the controller sits inside the confirm window.
    await fireFused({ stage: "stage-a-candidate" });

    // Disabling wake force-resets: the armed candidate is abandoned.
    options.enabled = false;
    rerender();
    options.enabled = true;
    rerender();

    // A transcript arriving after re-enable finds no candidate to resolve…
    t = 1200;
    await fireFused({
      stage: "stage-b-transcript",
      transcript: "hey ada what's up",
    });
    expect(onWake).not.toHaveBeenCalled();

    // …and a fresh handshake completes normally afterwards.
    await fireFused({ stage: "stage-a-candidate" });
    t = 1300;
    await fireFused({
      stage: "stage-b-transcript",
      transcript: "hey ada go",
    });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].path).toBe("two-stage-asr");
  });

  it("abandons the candidate when the confirm window lapses, then recovers", async () => {
    vi.useFakeTimers();
    try {
      const onWake = vi.fn<(d: WakeDetection) => void>();
      const { source, fireFused } = makeFusedSource();
      let t = 1000;
      renderHook(() =>
        useWakeController({
          enabled: true,
          alwaysOn: false,
          characterName: "ada",
          capabilities: FUSED,
          onWake,
          fusedWakeSource: source,
          now: () => t,
          confirmWindowMs: 300,
          tickMs: 100,
        }),
      );
      await fireFused({ stage: "stage-a-candidate" });
      expect(onWake).not.toHaveBeenCalled();

      // Ticks inside the window keep the candidate armed.
      await act(async () => {
        t = 1250;
        vi.advanceTimersByTime(250);
      });
      expect(onWake).not.toHaveBeenCalled();

      // Crossing the window abandons it — silence never confirms a wake.
      await act(async () => {
        t = 1350;
        vi.advanceTimersByTime(100);
      });
      await fireFused({
        stage: "stage-b-transcript",
        transcript: "hey ada go",
      });
      expect(onWake).not.toHaveBeenCalled();

      // The controller is not stuck: a later handshake still completes.
      await fireFused({ stage: "stage-a-candidate" });
      t = 1550;
      await fireFused({
        stage: "stage-b-transcript",
        transcript: "hey ada go",
      });
      expect(onWake).toHaveBeenCalledTimes(1);
      expect(onWake.mock.calls[0][0].path).toBe("two-stage-asr");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits no confidence when the native event omits it", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake,
      }),
    );
    await fireWake({
      wakeWord: "eliza",
      command: "go",
      transcript: "hey eliza go",
      postGap: 0.4,
    });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].wakeWord).toBe("eliza");
    expect(onWake.mock.calls[0][0].transcript).toBe("hey eliza go");
    expect(onWake.mock.calls[0][0].command).toBe("go");
    expect(onWake.mock.calls[0][0].confidence).toBeUndefined();
    expect(onWake.mock.calls[0][0].path).toBe("swabble-fallback");
  });

  it("honours custom trainedHeads when selecting the detection path", async () => {
    const onWake = vi.fn<(d: WakeDetection) => void>();
    const { source, fireFused } = makeFusedSource();
    const { result } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "ada",
        capabilities: FUSED,
        trainedHeads: new Set(["ada"]),
        onWake,
        fusedWakeSource: source,
      }),
    );
    expect(result.current.path).toBe("head-fast-path");
    await fireFused({ stage: "head-fired", confidence: 0.7 });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0].wakeWord).toBe("ada");
    expect(onWake.mock.calls[0][0].path).toBe("head-fast-path");
  });
});
