// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Weather fetches over the network + device location; stub it to a mutable
// reading so the base widgets render deterministically (the live hook is covered
// by useWeather.test.ts). Default "ready"; individual tests flip the state.
const { weatherState } = vi.hoisted(() => ({
  weatherState: {
    status: "ready" as "ready" | "loading" | "unavailable",
    temp: 68 as number | null,
    unit: "°F",
    condition: "Clear",
    kind: "clear" as const,
    requestLocation: (() => {}) as () => void,
  },
}));
vi.mock("../../hooks/useWeather", () => ({
  useWeather: () => weatherState,
  // Pin a 12-hour clock so the "2:30 PM" assertion is locale-independent; the
  // locale→hour-cycle logic itself is unit-tested in useWeather.test.ts.
  prefers24HourClock: () => false,
}));

beforeEach(() => {
  Object.assign(weatherState, {
    status: "ready",
    temp: 68,
    unit: "°F",
    condition: "Clear",
    kind: "clear",
    requestLocation: () => {},
  });
});

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
    expect(screen.getByText("Thursday, June 25").className).toContain(
      "truncate",
    );

    // Weather tile renders its reading next to the time.
    const weather = screen.getByTestId("home-weather");
    expect(weather.getAttribute("data-status")).toBe("ready");
    expect(weather.textContent).toContain("68");
    expect(weather.textContent).toContain("Clear");
    expect(
      weather.querySelector("svg")?.classList.contains("text-white/85"),
    ).toBe(true);
    expect(weather.querySelector(".text-5xl")).toBeTruthy();
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
    expect(
      screen.getByTestId("default-home-widgets").textContent,
    ).not.toContain("2:30");
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

  it("unavailable weather is a tappable tile that requests location (#14345)", () => {
    const requestLocation = vi.fn();
    Object.assign(weatherState, {
      status: "unavailable",
      temp: null,
      requestLocation,
    });
    render(<DefaultHomeWidgets />);
    const enable = screen.getByTestId("home-weather-enable");
    // Actionable, not dead-end copy.
    expect(enable.tagName).toBe("BUTTON");
    expect(enable.textContent).toContain("Tap to enable location");
    fireEvent.click(enable);
    expect(requestLocation).toHaveBeenCalledTimes(1);
  });
});
