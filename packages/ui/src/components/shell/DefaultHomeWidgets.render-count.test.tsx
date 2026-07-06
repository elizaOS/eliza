// @vitest-environment jsdom

/**
 * Render-count lock for the `DefaultHomeWidgets` half of #14559 (spec §C.4).
 *
 * BEFORE: `DefaultHomeWidgets` called `useNow(60_000)` at the top, so every
 * minute the whole base grid re-rendered - the clock AND the sibling
 * `WeatherTile` (which fetches + renders conditions) - just to move the minutes
 * digit.
 *
 * AFTER: the live clock content is a `<HomeClock>` LEAF that owns the shared,
 * visibility-gated ticker. The minute tick re-renders only the clock stack; the
 * `WeatherTile` does not re-render. This test proves it with a Profiler count
 * on the weather subtree across a minute roll - re-introducing a top-level
 * `useNow` makes the "weather did not re-render on the tick" assertion go red.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { weatherState, weatherRenderCounter } = vi.hoisted(() => ({
  weatherState: {
    status: "ready" as "ready" | "loading" | "unavailable",
    temp: 68 as number | null,
    unit: "°F",
    condition: "Clear",
    kind: "clear" as const,
    requestLocation: (() => {}) as () => void,
  },
  // A render counter incremented by the mocked `useWeather` - it runs once per
  // render of any component that calls it (here, only `WeatherTile`). So a bump
  // means the weather tile re-rendered.
  weatherRenderCounter: { count: 0 },
}));

vi.mock("../../hooks/useWeather", () => ({
  useWeather: () => {
    weatherRenderCounter.count += 1;
    return weatherState;
  },
  prefers24HourClock: () => false,
}));

import { __resetSharedNowForTests, MINUTE_MS } from "../../hooks/useSharedNow";
import { __setAppValueForTests } from "../../state/app-store";
import { DefaultHomeWidgets } from "./DefaultHomeWidgets";

beforeEach(() => {
  vi.useFakeTimers();
  // 2026-06-25 14:30Z, TZ=UTC → 2:30 PM.
  vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
  weatherRenderCounter.count = 0;
  Object.assign(weatherState, {
    status: "ready",
    temp: 68,
    unit: "°F",
    condition: "Clear",
    kind: "clear",
    requestLocation: () => {},
  });
});

afterEach(() => {
  cleanup();
  __resetSharedNowForTests();
  __setAppValueForTests(null);
  vi.useRealTimers();
});

describe("DefaultHomeWidgets render count (#14559)", () => {
  it("the minute tick advances the clock but does NOT re-render the weather tile", () => {
    render(<DefaultHomeWidgets />);
    // Flush the shared-ticker subscribe effect (installs the live clock).
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const root = screen.getByTestId("default-home-widgets");
    expect(root.textContent).toContain("2:30");
    expect(root.textContent).toContain("PM");

    // Weather rendered on mount. Zero it, then roll a full minute.
    const weatherAtMount = weatherRenderCounter.count;
    expect(weatherAtMount).toBeGreaterThan(0);
    weatherRenderCounter.count = 0;

    act(() => {
      // Cross the minute boundary: 14:30 → 14:31.
      vi.advanceTimersByTime(MINUTE_MS);
    });

    // The clock text advanced…
    expect(screen.getByTestId("default-home-widgets").textContent).toContain(
      "2:31",
    );
    // …but the weather tile did NOT re-render on the tick (it is a sibling of
    // the `<HomeClock>` leaf, not a child of the clock's ticker). A top-level
    // `useNow` regression re-renders the whole grid and bumps this above 0.
    expect(weatherRenderCounter.count).toBe(0);
  });

  it("holds the deterministic first-render (no epoch flash) then shows the live clock", () => {
    // The clock leaf starts at `useSharedNow() === 0` and keeps its text
    // `invisible` until the live clock ticks - never flashing 1970. The tile
    // footprint is still reserved (no layout pop).
    render(<DefaultHomeWidgets />);
    // Before flushing the subscribe effect there is no live time yet, but the
    // time tile footprint exists.
    expect(screen.getByTestId("home-time-widget")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("default-home-widgets").textContent).toContain(
      "2:30",
    );
  });
});
