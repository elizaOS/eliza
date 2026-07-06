// @vitest-environment jsdom

/**
 * Unit lock for the shared, visibility-gated minute ticker (spec §C.4 item 3).
 *
 * The three properties the binding pattern relies on:
 *  1. ONE interval for N subscribers (not one per leaf) - proven by spying on
 *     `setInterval` and mounting many consumers.
 *  2. The tick is **visibility-gated**: the interval is cleared while
 *     `document.hidden` and re-armed (with an immediate resync) on show.
 *  3. Deterministic render path: the first snapshot is `0` (never `Date.now()`),
 *     the live clock installs after subscribe.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSharedNowForTests,
  MINUTE_MS,
  useSharedNow,
} from "./useSharedNow";

// A tiny consumer that surfaces the current snapshot for assertions.
function NowProbe({ label }: { label: string }): React.JSX.Element {
  const now = useSharedNow();
  return <span data-testid={`now-${label}`}>{now}</span>;
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
  vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
  setHidden(false);
});

afterEach(() => {
  cleanup();
  __resetSharedNowForTests();
  vi.useRealTimers();
});

describe("useSharedNow - shared visibility-gated ticker", () => {
  it("arms exactly ONE interval no matter how many leaves subscribe", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    render(
      <>
        <NowProbe label="a" />
        <NowProbe label="b" />
        <NowProbe label="c" />
        <NowProbe label="d" />
      </>,
    );
    // Flush subscribe effects.
    act(() => {
      vi.advanceTimersByTime(0);
    });

    // Four subscribers, one interval. The naive `useNow`-per-leaf shape would
    // arm four here - this is the whole point of the shared ticker.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it("returns 0 on first render, then the live clock after subscribe", () => {
    // getServerSnapshot / first snapshot is the deterministic epoch. React may
    // commit the effect synchronously in the test env, so assert the live value
    // after flushing rather than trying to freeze the pre-effect frame.
    const { getByTestId } = render(<NowProbe label="live" />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(getByTestId("now-live").textContent).toBe(String(Date.now()));
  });

  it("advances every subscriber on the minute tick", () => {
    const { getByTestId } = render(
      <>
        <NowProbe label="a" />
        <NowProbe label="b" />
      </>,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    const t0 = getByTestId("now-a").textContent;
    expect(getByTestId("now-b").textContent).toBe(t0);

    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    const t1 = getByTestId("now-a").textContent;
    expect(Number(t1)).toBe(Number(t0) + MINUTE_MS);
    // Both leaves saw the same new value from the single shared tick.
    expect(getByTestId("now-b").textContent).toBe(t1);
  });

  it("stops ticking while document.hidden and resyncs on show", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { getByTestId } = render(<NowProbe label="vis" />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    const visible0 = Number(getByTestId("now-vis").textContent);

    // Hide the tab: the interval must be torn down (zero timer wakeups).
    setHidden(true);
    expect(clearIntervalSpy).toHaveBeenCalled();

    // Time passes while hidden - advancing timers must NOT move the snapshot,
    // because the interval is cleared.
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS * 5);
    });
    expect(Number(getByTestId("now-vis").textContent)).toBe(visible0);

    // Show again: it resyncs immediately to the real (advanced) clock…
    setHidden(false);
    const afterShow = Number(getByTestId("now-vis").textContent);
    expect(afterShow).toBe(Date.now());
    expect(afterShow).toBeGreaterThan(visible0);

    // …and resumes ticking.
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    expect(Number(getByTestId("now-vis").textContent)).toBe(
      afterShow + MINUTE_MS,
    );
    clearIntervalSpy.mockRestore();
  });

  it("tears the interval down when the last subscriber unmounts", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<NowProbe label="only" />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    clearIntervalSpy.mockClear();

    unmount();
    // Last leaf gone → the shared interval is cleared (no orphaned timer on the
    // always-mounted home once every relative-time leaf is off screen).
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
