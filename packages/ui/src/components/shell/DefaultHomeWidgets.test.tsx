// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DefaultHomeWidgets", () => {
  it("renders the clock, date, and a 7-day week strip once the clock is live", () => {
    vi.useFakeTimers();
    // 2026-06-25 is a Thursday; tests run with TZ=UTC, so 14:30Z → 2:30 PM.
    vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));

    render(<DefaultHomeWidgets />);
    // `useNow` installs the real clock in an effect; flush it.
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const root = screen.getByTestId("default-home-widgets");
    expect(root.textContent).toContain("2:30");
    expect(root.textContent).toContain("PM");
    expect(root.textContent).toContain("Thursday");
    expect(root.textContent).toContain("June");

    // The week strip renders all 7 day-number cells, with today (25) present.
    const dayCells = root.querySelectorAll(".grid-cols-7 > div");
    expect(dayCells).toHaveLength(7);
    expect(root.textContent).toContain("25");
  });
});
