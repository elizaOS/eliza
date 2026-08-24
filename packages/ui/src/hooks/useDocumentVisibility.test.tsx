/** Verifies useDocumentVisibility - visibility tracking and gated intervals through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit lock for the boolean visibility hook and its interval companion.
 *
 * Consumers pause polls and animations while the tab is hidden, so the
 * binding properties are:
 *  1. The hook mirrors `document.visibilityState` at mount and on every
 *     `visibilitychange`.
 *  2. The listener lifecycle is balanced - unmount removes exactly what the
 *     effect added (no leaked document listeners).
 *  3. `useIntervalWhenDocumentVisible` arms ONE interval only while enabled
 *     AND visible, tears it down while hidden, resumes on show, follows a
 *     changed delay, and always invokes the LATEST callback without re-arming
 *     when only the callback identity changes.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDocumentVisibility,
  useIntervalWhenDocumentVisible,
} from "./useDocumentVisibility";

function VisibilityProbe(): React.JSX.Element {
  const visible = useDocumentVisibility();
  return <span data-testid="vis">{visible ? "visible" : "hidden"}</span>;
}

function IntervalProbe({
  onTick,
  delayMs,
  enabled = true,
}: {
  onTick: () => void;
  delayMs: number;
  enabled?: boolean;
}) {
  useIntervalWhenDocumentVisible(onTick, delayMs, enabled);
  return null;
}

/** Force `document.hidden` / `visibilityState` and fire the event. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDocumentVisibility", () => {
  it("mirrors visibilityState at mount and on every visibilitychange", () => {
    const { getByTestId } = render(<VisibilityProbe />);
    expect(getByTestId("vis").textContent).toBe("visible");

    setHidden(true);
    expect(getByTestId("vis").textContent).toBe("hidden");

    setHidden(false);
    expect(getByTestId("vis").textContent).toBe("visible");
  });

  it("initializes hidden when the document starts out hidden", () => {
    setHidden(true);
    const { getByTestId } = render(<VisibilityProbe />);
    // The lazy initializer reads live state - a remount into a backgrounded
    // tab must not report visible until the next event arrives.
    expect(getByTestId("vis").textContent).toBe("hidden");
  });

  it("removes its visibilitychange listener on unmount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = render(<VisibilityProbe />);
    expect(addSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );

    unmount();
    expect(removeSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe("useIntervalWhenDocumentVisible", () => {
  it("does not arm an interval while disabled", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const ticks: number[] = [];
    render(
      <IntervalProbe
        onTick={() => ticks.push(ticks.length)}
        delayMs={50}
        enabled={false}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(ticks).toEqual([]);
    setIntervalSpy.mockRestore();
  });

  it("arms ONE interval while visible and delivers the LATEST callback", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const calls: string[] = [];
    const first = (): number => calls.push("first");
    const second = (): number => calls.push("second");

    const { rerender } = render(<IntervalProbe onTick={first} delayMs={100} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(calls).toEqual(["first"]);

    // A new callback identity must not tear down or re-arm the interval...
    rerender(<IntervalProbe onTick={second} delayMs={100} />);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // ...but every later tick goes to the newest closure.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(calls).toEqual(["first", "second", "second"]);
    setIntervalSpy.mockRestore();
  });

  it("pauses while the document is hidden and resumes on show", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const ticks: number[] = [];
    render(
      <IntervalProbe onTick={() => ticks.push(ticks.length)} delayMs={100} />,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(ticks).toEqual([0]);

    // Hidden: the interval is torn down, so zero wakeups while backgrounded.
    setHidden(true);
    const armedAfterHide = setIntervalSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(ticks).toEqual([0]);

    // Visible again: re-armed and ticking on the same cadence.
    setHidden(false);
    expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(armedAfterHide);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(ticks).toEqual([0, 1]);
    setIntervalSpy.mockRestore();
  });

  it("re-arms when delayMs changes, following the new period", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const ticks: number[] = [];
    const { rerender } = render(
      <IntervalProbe onTick={() => ticks.push(ticks.length)} delayMs={100} />,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(ticks).toEqual([]);

    // Shorten the period mid-flight: the pending 100ms timer is cleared...
    rerender(
      <IntervalProbe onTick={() => ticks.push(ticks.length)} delayMs={20} />,
    );
    expect(clearIntervalSpy).toHaveBeenCalled();

    // ...and subsequent ticks arrive on the new 20ms cadence.
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(ticks).toEqual([0]);
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(ticks).toEqual([0, 1, 2]);
    clearIntervalSpy.mockRestore();
  });
});
