// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwabbleWakeWordEvent } from "../bridge/native-plugins";

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
