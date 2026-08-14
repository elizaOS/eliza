/** Verifies useWakeController through the package's configured test harness. */
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SwabbleConfig,
  SwabbleWakeWordEvent,
} from "../bridge/native-plugins";

// Capture the registered wakeWord listener so tests can fire native detections.
let wakeListener: ((e?: SwabbleWakeWordEvent) => void) | null = null;
const removeSpy = vi.fn(async () => {});
const addListenerSpy = vi.fn(
  async (_event: string, fn: (e?: SwabbleWakeWordEvent) => void) => {
    wakeListener = fn;
    return { remove: removeSpy };
  },
);
const getConfigSpy = vi.fn<
  () => Promise<{ config: Partial<SwabbleConfig> | null }>
>(async () => ({
  config: { triggers: ["eliza"], minPostTriggerGap: 0.45 },
}));
const isListeningSpy = vi.fn(async () => ({ listening: false }));
const startSpy = vi.fn(async () => ({ started: true }));
const stopSpy = vi.fn(async () => {});

vi.mock("../bridge/native-plugins", () => ({
  getSwabblePlugin: () => ({
    addListener: addListenerSpy,
    getConfig: getConfigSpy,
    isListening: isListeningSpy,
    start: startSpy,
    stop: stopSpy,
  }),
}));

import { useWakeController } from "./useWakeController";
import type { WakeCapabilities, WakeDetection } from "./wake-controller";

function fireWake(event?: SwabbleWakeWordEvent) {
  return act(async () => {
    wakeListener?.(event);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function readyFusedLifecycle() {
  return {
    isListening: vi.fn(async () => false),
    start: vi.fn(async () => ({ started: true })),
    stop: vi.fn(async () => {}),
  };
}

const FUSED: WakeCapabilities = {
  openWakeWord: true,
  asrConfirm: true,
  swabble: true,
};

describe("useWakeController", () => {
  beforeEach(() => {
    wakeListener = null;
    getConfigSpy.mockResolvedValue({
      config: { triggers: ["eliza"], minPostTriggerGap: 0.45 },
    });
    isListeningSpy.mockResolvedValue({ listening: false });
    startSpy.mockResolvedValue({ started: true });
    stopSpy.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
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

    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
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
    expect(startSpy).not.toHaveBeenCalled();
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
        fusedLifecycle: readyFusedLifecycle(),
      }),
    );
    // eliza has a shipped head → head fast-path.
    expect(result.current.path).toBe("head-fast-path");
  });

  it("ignores a Swabble wake when a faster (two-stage) path is selected", async () => {
    const onWake = vi.fn();
    const fusedLifecycle = readyFusedLifecycle();
    const { result } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "ada", // no head → two-stage ASR
        capabilities: FUSED,
        onWake,
        fusedLifecycle,
      }),
    );
    expect(result.current.path).toBe("two-stage-asr");
    await waitFor(() => expect(fusedLifecycle.start).toHaveBeenCalledTimes(1));
    // The controller never starts or subscribes the non-selected fallback.
    expect(wakeListener).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();
    expect(onWake).not.toHaveBeenCalled();
  });

  it("falls back to Swabble when the preferred fused detector cannot start", async () => {
    const fusedLifecycle = {
      isListening: vi.fn(async () => false),
      start: vi.fn(async () => ({
        started: false,
        reason: "wakeword-model-not-staged",
      })),
      stop: vi.fn(async () => {}),
    };
    const { result } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        capabilities: FUSED,
        onWake: vi.fn(),
        fusedLifecycle,
      }),
    );

    await waitFor(() => expect(result.current.path).toBe("swabble-fallback"));
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
    expect(fusedLifecycle.stop).not.toHaveBeenCalled();
  });

  it("retries fused detection after a later disable and re-enable", async () => {
    const fusedLifecycle = {
      isListening: vi.fn(async () => false),
      start: vi
        .fn()
        .mockResolvedValueOnce({
          started: false,
          reason: "wakeword-model-not-staged",
        })
        .mockResolvedValueOnce({ started: true }),
      stop: vi.fn(async () => {}),
    };
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useWakeController({
          enabled,
          alwaysOn: false,
          characterName: "eliza",
          capabilities: FUSED,
          onWake: vi.fn(),
          fusedLifecycle,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.path).toBe("swabble-fallback"));
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
    rerender({ enabled: true });

    await waitFor(() => expect(fusedLifecycle.start).toHaveBeenCalledTimes(2));
    expect(result.current.path).toBe("head-fast-path");
  });

  it("starts once with character-aware config while preserving custom fields", async () => {
    getConfigSpy.mockResolvedValue({ config: null });
    const configSource = vi.fn(async () => ({
      triggers: ["computer"],
      locale: "en-GB",
      modelSize: "small" as const,
      minPostTriggerGap: 0.7,
    }));
    const { rerender } = renderHook(
      ({ enabled }) =>
        useWakeController({
          enabled,
          alwaysOn: false,
          characterName: "Ada",
          onWake: vi.fn(),
          swabbleConfigSource: configSource,
        }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
    expect(startSpy).toHaveBeenCalledWith({
      config: {
        triggers: ["ada", "computer"],
        locale: "en-GB",
        modelSize: "small",
        minPostTriggerGap: 0.7,
      },
    });

    rerender({ enabled: true });
    await act(async () => Promise.resolve());
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("does not start or subscribe before opt-in", async () => {
    renderHook(() =>
      useWakeController({
        enabled: false,
        alwaysOn: false,
        characterName: "eliza",
        onWake: vi.fn(),
      }),
    );
    await act(async () => Promise.resolve());
    expect(addListenerSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not stop a detector that was already listening", async () => {
    isListeningSpy.mockResolvedValue({ listening: true });
    const { unmount } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake: vi.fn(),
      }),
    );
    await waitFor(() => expect(isListeningSpy).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => Promise.resolve());
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("stops an owned detector when disabled", async () => {
    const { rerender } = renderHook(
      ({ enabled }) =>
        useWakeController({
          enabled,
          alwaysOn: false,
          characterName: "eliza",
          onWake: vi.fn(),
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });

    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
  });

  it("repairs a start that resolves after disable without arming stale events", async () => {
    const lateStart = deferred<{ started: boolean }>();
    startSpy.mockReturnValueOnce(lateStart.promise);
    const onWake = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) =>
        useWakeController({
          enabled,
          alwaysOn: false,
          characterName: "eliza",
          onWake,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });

    lateStart.resolve({ started: true });

    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
    await fireWake({
      wakeWord: "eliza",
      command: "stale",
      transcript: "hey eliza stale",
      postGap: 0.2,
    });
    expect(onWake).not.toHaveBeenCalled();
  });

  it("fails closed when the browser detector reports unsupported", async () => {
    startSpy.mockResolvedValue({ started: false });
    const onWake = vi.fn();
    const { unmount } = renderHook(() =>
      useWakeController({
        enabled: true,
        alwaysOn: false,
        characterName: "eliza",
        onWake,
      }),
    );
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
    await fireWake({
      wakeWord: "eliza",
      command: "should not fire",
      transcript: "hey eliza should not fire",
      postGap: 0.2,
    });
    expect(onWake).not.toHaveBeenCalled();
    unmount();
    await act(async () => Promise.resolve());
    expect(stopSpy).not.toHaveBeenCalled();
  });
});
