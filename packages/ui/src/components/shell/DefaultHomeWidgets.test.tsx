// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Weather fetches over the network + device location; stub it to a stable
// "ready" reading so the base widgets render deterministically (the live hook
// is covered by useWeather.test.ts).
vi.mock("../../hooks/useWeather", () => ({
  useWeather: () => ({
    status: "ready",
    temp: 68,
    unit: "°F",
    condition: "Clear",
    kind: "clear",
    city: "Testville",
  }),
}));

import { DefaultHomeWidgets } from "./DefaultHomeWidgets";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DefaultHomeWidgets", () => {
  it("renders the clock, date, week strip, and the weather tile once the clock is live", () => {
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

    // Weather tile renders its reading next to the time.
    const weather = screen.getByTestId("home-weather");
    expect(weather.getAttribute("data-status")).toBe("ready");
    expect(weather.textContent).toContain("68");
    expect(weather.textContent).toContain("Clear");
    expect(weather.textContent).toContain("Testville");
  });

  it("lays the time + weather out as 2×2 grid neighbours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
    render(<DefaultHomeWidgets />);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const root = screen.getByTestId("default-home-widgets");
    // The container is a 4-column grid; the time + weather each span 2×2.
    expect(root.className).toContain("grid-cols-4");
    const weather = screen.getByTestId("home-weather");
    expect(weather.className).toContain("col-span-2");
    expect(weather.className).toContain("row-span-2");
  });
});
