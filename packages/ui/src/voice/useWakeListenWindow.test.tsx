/** Verifies useWakeListenWindow through the package's configured test harness. */
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the registered wakeWord listener so tests can fire detections.
let wakeListener: (() => void) | null = null;
const removeSpy = vi.fn(async () => {});

vi.mock("../bridge/native-plugins", () => ({
  getSwabblePlugin: () => ({
    addListener: async (_event: string, fn: () => void) => {
      wakeListener = fn;
      return { remove: removeSpy };
    },
  }),
}));

import { useWakeListenWindow } from "./useWakeListenWindow";

function fireWake() {
  // The hook subscribes asynchronously; flush microtasks first.
  return act(async () => {
    await Promise.resolve();
    wakeListener?.();
  });
}

describe("useWakeListenWindow", () => {
  let nowValue = 0;
  const now = () => nowValue;

  beforeEach(() => {
    vi.useFakeTimers();
    nowValue = 1000;
    wakeListener = null;
    removeSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the mic on wake and closes it when the agent responds", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: false,
      agentBusy: false,
      onOpen,
      onClose,
      now,
      tickMs: 500,
    };
    const { rerender, result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });

    await fireWake();
    expect(result.current.phase).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Agent busy rising edge = the user's turn was submitted → awaiting reply.
    nowValue = 2000;
    rerender({ ...props, agentBusy: true });
    expect(result.current.phase).toBe("awaiting-response");

    // Agent busy falling edge = the agent responded → window closes.
    nowValue = 3000;
    rerender({ ...props, agentBusy: false });
    expect(result.current.phase).toBe("idle");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes via the idle timeout when the user never speaks", async () => {
    const onClose = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: false,
      agentBusy: false,
      onOpen: vi.fn(),
      onClose,
      now,
      tickMs: 500,
    };
    const { result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });

    await fireWake();
    expect(result.current.phase).toBe("open");

    // Advance the clock past the idle timeout and let a tick fire.
    nowValue = 1000 + 9000;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.phase).toBe("idle");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays inert while always-on (never grabs the mic)", async () => {
    const onOpen = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: true,
      agentBusy: false,
      onOpen,
      onClose: vi.fn(),
      now,
    };
    const { result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });
    // No subscription registered while always-on.
    await act(async () => {
      await Promise.resolve();
    });
    expect(wakeListener).toBeNull();
    expect(result.current.phase).toBe("idle");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores an agent-busy edge while no window is open", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: false,
      agentBusy: false,
      onOpen,
      onClose,
      now,
      tickMs: 500,
    };
    const { rerender, result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });

    // A rising edge with no wake behind it dispatches a stray user-speech-final,
    // which must not open the mic.
    rerender({ ...props, agentBusy: true });
    expect(result.current.phase).toBe("idle");
    expect(onOpen).not.toHaveBeenCalled();

    // The falling edge is equally inert while idle.
    rerender({ ...props, agentBusy: false });
    expect(result.current.phase).toBe("idle");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-arms an open window on a second wake, refreshing the idle budget", async () => {
    const onClose = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: false,
      agentBusy: false,
      onOpen: vi.fn(),
      onClose,
      now,
      tickMs: 500,
    };
    const { result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });

    await fireWake();
    expect(result.current.phase).toBe("open");

    // Second wake before any timeout: openedAt refreshes instead of toggling.
    nowValue = 7000;
    await fireWake();
    expect(result.current.phase).toBe("open");

    // 8000ms after the FIRST wake but only 2000ms after the re-arm → still open.
    nowValue = 9000;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.phase).toBe("open");
    expect(onClose).not.toHaveBeenCalled();

    // Past the re-armed idle budget the window finally closes.
    nowValue = 16000;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.phase).toBe("idle");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("force-closes via the safety cap even while awaiting a response", async () => {
    const onClose = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: false,
      agentBusy: false,
      onOpen: vi.fn(),
      onClose,
      now,
      tickMs: 500,
    };
    const { rerender, result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });

    await fireWake();
    nowValue = 2000;
    rerender({ ...props, agentBusy: true });
    expect(result.current.phase).toBe("awaiting-response");

    // A missed agent-responded must not pin the mic forever: once total window
    // lifetime reaches maxWindowMs the tick closes it regardless of phase.
    nowValue = 31000;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.phase).toBe("idle");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes an open window when the hook is disabled or always-on turns on", async () => {
    const onClose = vi.fn();
    const props = {
      enabled: true,
      alwaysOn: false,
      agentBusy: false,
      onOpen: vi.fn(),
      onClose,
      now,
      tickMs: 500,
    };
    const { rerender, result } = renderHook((p) => useWakeListenWindow(p), {
      initialProps: props,
    });

    await fireWake();
    expect(result.current.phase).toBe("open");

    // Master switch off mid-window → forced back to idle.
    rerender({ ...props, enabled: false });
    expect(result.current.phase).toBe("idle");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Back on: a fresh wake can open a new window.
    rerender({ ...props });
    await act(async () => {
      await Promise.resolve();
      wakeListener?.();
    });
    expect(result.current.phase).toBe("open");

    // Always-on turning on mid-window gets the same treatment.
    rerender({ ...props, alwaysOn: true });
    expect(result.current.phase).toBe("idle");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
