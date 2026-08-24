/** Verifies useRafCoalescer through the package's configured test harness. */
// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRafCoalescer } from "./useRafCoalescer";

/**
 * Manual rAF clock: schedule() captures callbacks under increasing positive
 * handles, drainFrames() paints them in order. Mirrors the stub style of
 * use-pull-gesture.test.ts so frame timing stays fully under test control.
 */
function installManualRaf() {
  const frames = new Map<number, (t: number) => void>();
  let nextHandle = 1;
  const rafStub = vi.fn((cb: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    frames.set(handle, cb);
    return handle;
  });
  const cancelStub = vi.fn((handle: number) => {
    frames.delete(handle);
  });
  vi.stubGlobal("requestAnimationFrame", rafStub);
  vi.stubGlobal("cancelAnimationFrame", cancelStub);
  const drainFrames = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [handle, cb] of pending) cb(handle * 16);
  };
  return { rafStub, cancelStub, drainFrames };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useRafCoalescer", () => {
  it("delivers only the LATEST scheduled value, exactly once, on the next frame", () => {
    const { drainFrames } = installManualRaf();
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(1);
    result.current.schedule(2);
    result.current.schedule(3);

    // Nothing may fan out before the frame paints.
    expect(sink).not.toHaveBeenCalled();

    drainFrames();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(3);
  });

  it("coalesces a whole burst into ONE rAF, then schedules a fresh frame for the next burst", () => {
    const { rafStub, drainFrames } = installManualRaf();
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(10);
    result.current.schedule(11);
    result.current.schedule(12);
    expect(rafStub).toHaveBeenCalledTimes(1);

    drainFrames();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(12);

    // After the frame ran, the next schedule must book a NEW frame — a stale
    // pending marker here would swallow the rest of the gesture.
    result.current.schedule(13);
    expect(rafStub).toHaveBeenCalledTimes(2);

    drainFrames();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith(13);
  });

  it("flush forces the pending value out NOW, cancels the queued frame, and never double-delivers", () => {
    const { cancelStub, drainFrames } = installManualRaf();
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(7);
    result.current.flush();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(7);
    expect(cancelStub).toHaveBeenCalled();

    // Even if the already-booked frame were to fire, the value must not be
    // delivered twice.
    drainFrames();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("flush with an empty queue is a silent no-op", () => {
    installManualRaf();
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    expect(() => result.current.flush()).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });

  it("cancel drops the pending value so neither the frame nor a later flush delivers it", () => {
    const { drainFrames } = installManualRaf();
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(9);
    result.current.cancel();

    drainFrames();
    result.current.flush();

    expect(sink).not.toHaveBeenCalled();
  });

  it("cancel/flush with nothing pending never touches cancelAnimationFrame", () => {
    const { cancelStub } = installManualRaf();
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.flush();
    result.current.cancel();

    expect(cancelStub).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("delivers synchronously when requestAnimationFrame is unavailable so the final value is never lost", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(5);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(5);
  });

  it("survives a synchronous rAF (inline callback): every schedule keeps delivering", () => {
    // Some test environments run the rAF callback INLINE during schedule().
    // The coalescer must mark the frame pending BEFORE booking, or the handle
    // assigned afterwards would re-mark a dead frame as pending forever and
    // swallow every later value.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const sink = vi.fn();
    const { result } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(1);
    result.current.schedule(2);
    result.current.schedule(3);

    expect(sink).toHaveBeenCalledTimes(3);
    expect(sink).toHaveBeenNthCalledWith(1, 1);
    expect(sink).toHaveBeenNthCalledWith(2, 2);
    expect(sink).toHaveBeenNthCalledWith(3, 3);
  });

  it("keeps a stable identity across renders and always calls the LATEST sink", () => {
    const { drainFrames } = installManualRaf();
    const firstSink = vi.fn();
    const latestSink = vi.fn();
    const { result, rerender } = renderHook(
      ({ onValue }: { onValue: (v: string) => void }) =>
        useRafCoalescer<string>(onValue),
      { initialProps: { onValue: firstSink } },
    );
    const stableSchedule = result.current.schedule;
    const stableFlush = result.current.flush;
    const stableCancel = result.current.cancel;

    rerender({ onValue: latestSink });

    // The three callbacks are useCallback-stable across renders (safe as
    // effect deps); the wrapper object itself is rebuilt per render.
    expect(result.current.schedule).toBe(stableSchedule);
    expect(result.current.flush).toBe(stableFlush);
    expect(result.current.cancel).toBe(stableCancel);

    result.current.schedule("drag-end");
    drainFrames();

    expect(latestSink).toHaveBeenCalledTimes(1);
    expect(latestSink).toHaveBeenCalledWith("drag-end");
    expect(firstSink).not.toHaveBeenCalled();
  });

  it("drops an in-flight frame when the consumer unmounts mid-gesture", () => {
    const { cancelStub, drainFrames } = installManualRaf();
    const sink = vi.fn();
    const { result, unmount } = renderHook(() => useRafCoalescer<number>(sink));

    result.current.schedule(21);
    unmount();

    expect(cancelStub).toHaveBeenCalled();

    drainFrames();
    result.current.flush();

    expect(sink).not.toHaveBeenCalled();
  });
});
