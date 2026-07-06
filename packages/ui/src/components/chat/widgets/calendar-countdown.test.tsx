// @vitest-environment jsdom
//
// CalendarCountdown leaf (§C.4, issue #14564): the "in 40 min" countdown owns
// its OWN minute ticker so the minute tick re-renders only the <time> text
// node, NEVER the card shell above it. These tests lock two things:
//   1. the copy contract (sentence case, no em-dashes, the compact buckets), and
//   2. the render-count isolation, a leaf tick must not commit the parent
//      shell (the whole reason the timer was pushed down into the leaf).
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeRenderCounter,
  useRenderSpy,
} from "../../../testing/render-counter";
import { CalendarCountdown, formatCountdown } from "./calendar-countdown";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatCountdown", () => {
  const now = 0;
  it('reads "now" at or before the event start', () => {
    expect(formatCountdown(new Date(now).toISOString(), now)).toBe("now");
    // Already started (negative delta) still reads "now", never a negative.
    expect(formatCountdown(new Date(now - 5 * 60_000).toISOString(), now)).toBe(
      "now",
    );
  });

  it("uses compact minute / hour / day buckets", () => {
    const at = (ms: number) =>
      formatCountdown(new Date(now + ms).toISOString(), now);
    expect(at(25 * 60_000)).toBe("in 25m");
    expect(at(3 * 60 * 60_000)).toBe("in 3h");
    expect(at(24 * 60 * 60_000)).toBe("tomorrow");
    expect(at(2 * 24 * 60 * 60_000)).toBe("in 2d");
  });

  it("emits no em-dashes and stays sentence case (copy law)", () => {
    const samples = [0, 25 * 60_000, 3 * 60 * 60_000, 48 * 60 * 60_000].map(
      (ms) => formatCountdown(new Date(now + ms).toISOString(), now),
    );
    for (const s of samples) {
      expect(s).not.toContain(",");
      expect(s).toBe(s.toLowerCase());
    }
  });

  it("returns empty string for an unparseable date", () => {
    expect(formatCountdown("not-a-date", now)).toBe("");
  });
});

describe("CalendarCountdown leaf", () => {
  it("holds empty text when the clock reads 0 (deterministic first-render guard)", () => {
    // The `now === 0` first render is the determinism guard (useNow returns 0
    // before its effect installs Date.now). We assert it via the injected-clock
    // path since RTL flushes the mount effect synchronously in the un-injected
    // path; injecting now === 0 pins that exact frame.
    const startAt = new Date(1_000_000 + 40 * 60_000).toISOString();
    const { container } = render(<CalendarCountdown date={startAt} now={0} />);
    expect(container.querySelector("time")?.textContent).toBe("");
  });

  it("renders the countdown string and a machine-readable start once the clock is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const startAt = new Date(Date.parse("2026-07-05T12:40:00Z")).toISOString();

    let container!: HTMLElement;
    // RTL flushes the mount effect (which installs the live clock) inside act.
    act(() => {
      ({ container } = render(<CalendarCountdown date={startAt} />));
    });
    expect(container.querySelector("time")?.textContent).toBe("in 40m");
    // The <time> carries the machine-readable start for a11y.
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      startAt,
    );
  });

  it("honors an injected `now` (deterministic tests/stories path) without a ticker", () => {
    const startAt = new Date(1_000_000 + 90 * 60_000).toISOString();
    const { container } = render(
      <CalendarCountdown date={startAt} now={1_000_000} />,
    );
    // Injected clock wins immediately, no effect tick needed.
    expect(container.querySelector("time")?.textContent).toBe("in 2h");
  });

  // The load-bearing test (§C.4): a minute tick inside the leaf must re-render
  // ONLY the leaf, not the surrounding card shell. We wrap the leaf in a fake
  // "shell" whose renders are counted; after advancing the leaf's ticker a full
  // minute, the shell's render count must be unchanged while the leaf's text
  // has advanced.
  it("ticks without re-rendering the card shell (render-count lock)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const startAt = new Date(Date.parse("2026-07-05T12:40:00Z")).toISOString();

    const shellCounter = makeRenderCounter();

    // A minimal stand-in for the card shell: it renders once and holds the leaf
    // as a child. If the leaf's ticker leaked upward (e.g. useNow lived here),
    // this counter would climb every minute, exactly the bug §C.4 forbids.
    function FakeCardShell() {
      useRenderSpy(shellCounter);
      // Local state the shell controls; never touched by the leaf's ticker.
      const [title] = useState("Design sync");
      return (
        <button type="button" data-testid="shell">
          <span data-testid="title">{title}</span>
          <CalendarCountdown date={startAt} />
        </button>
      );
    }

    const { container } = render(<FakeCardShell />);

    // Flush the leaf's clock-install effect.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(container.querySelector("time")?.textContent).toBe("in 40m");
    const shellRendersAfterMount = shellCounter.count;

    // Advance a full minute so the leaf's 60s ticker fires.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // The leaf re-rendered: the countdown string advanced by a minute.
    expect(container.querySelector("time")?.textContent).toBe("in 39m");
    // The shell did NOT re-render on the leaf's tick, the whole point.
    expect(shellCounter.count).toBe(shellRendersAfterMount);
  });
});
