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

import { __setAppValueForTests } from "../../state/app-store";
import type { AppContextValue } from "../../state/types";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __setAppValueForTests(null);
});

describe("DefaultHomeWidgets", () => {
  it("renders the clock, date, and the weather tile once the clock is live", () => {
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

  it("hides the time/date tile when the pref is set, keeping weather (#10706)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
    __setAppValueForTests({
      homeTimeWidgetHidden: true,
    } as unknown as AppContextValue);

    render(<DefaultHomeWidgets />);
    act(() => {
      vi.advanceTimersByTime(1);
    });

    // The time tile is gone…
    expect(screen.queryByTestId("home-time-widget")).toBeNull();
    expect(screen.getByTestId("default-home-widgets").textContent).not.toContain(
      "2:30",
    );
    // …but weather is independent and still shows immediately.
    expect(screen.getByTestId("home-weather")).toBeTruthy();
  });

  it("shows the time tile by default (pref unset)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
    __setAppValueForTests({
      homeTimeWidgetHidden: false,
    } as unknown as AppContextValue);

    render(<DefaultHomeWidgets />);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("home-time-widget")).toBeTruthy();
  });
});
