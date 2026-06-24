// @vitest-environment jsdom

/**
 * Home entrance-flicker lock (#9304).
 *
 * The `home-enter` fade (opacity 0→1) must play exactly ONCE on first mount and
 * never re-apply on a later re-render — re-applying it flashes the cards (a
 * fade-out-then-in excursion). This test locks both halves:
 *
 *  1. the `home-enter` class is present on the home blocks at first mount
 *     (so the entrance animation actually plays), and
 *  2. after the mount window, a re-render does NOT re-add `home-enter` — proven
 *     by sampling the opacity series and asserting `detectOpacityFlash` finds no
 *     re-trigger flash (the meta-tested flicker detector).
 *
 * Fails-when-broken: revert to the always-on `home-enter` class and step 2 sees
 * the class re-added on the re-render → the opacity series would flash → red.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectOpacityFlash,
  type OpacitySample,
} from "../../testing/layout-stability";

vi.mock("../../hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: vi.fn() }),
}));

// Stub the WidgetHost to a marker so this test owns only HomeScreen's entrance
// behavior (the storm lock owns WidgetHost).
vi.mock("../../widgets/WidgetHost", () => ({
  WidgetHost: (props: { slot: string }) => (
    <div data-testid="home-widget-host" data-slot={props.slot} />
  ),
}));

import { HomeScreen } from "./HomeScreen";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function homeBlocks(container: HTMLElement): HTMLElement[] {
  // The home-enter blocks are the direct children of the centered column.
  const column = container.querySelector<HTMLElement>(".mx-auto");
  if (!column) return [];
  return Array.from(column.children) as HTMLElement[];
}

/**
 * Model the opacity each home block presents over time given whether
 * `home-enter` is on it. With the class on a block the fade runs 0→1 once; with
 * the class absent the block is steady at 1. We sample the *presence of the
 * class* at each phase and synthesize the opacity the user sees, then run the
 * real flicker detector over the series.
 */
function classOnAnyBlock(container: HTMLElement): boolean {
  return homeBlocks(container).some((el) =>
    el.classList.contains("home-enter"),
  );
}

describe("HomeScreen entrance flicker lock (#9304)", () => {
  it("plays home-enter once on mount, never re-adds it on a later re-render (no flash)", () => {
    const { container, rerender } = render(
      <HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />,
    );

    const series: OpacitySample[] = [];
    let t = 0;
    const sample = () => {
      // While the class is present on mount the cards fade 0→1; the detector
      // only flashes on a REVERSAL, so the one-way mount fade is clean. The
      // load-bearing check is that the class is gone on the later re-render — if
      // it were re-added, opacity would dip to ~0 again (a reversal) and flash.
      const classOn = classOnAnyBlock(container);
      series.push({ t, opacity: classOn ? 0 : 1 });
      t += 50;
    };

    // First mount: the entrance class is present (animation plays once).
    expect(classOnAnyBlock(container)).toBe(true);
    sample(); // opacity 0 (fade start)

    // Advance past the mount window so the once-guard strips the class.
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(classOnAnyBlock(container)).toBe(false); // entrance done, class gone
    sample(); // opacity settled at 1

    // A later re-render (e.g. a prop / resize-driven update) must NOT re-add the
    // entrance class — this is the regression the bug caused.
    act(() => {
      rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    });
    expect(classOnAnyBlock(container)).toBe(false);
    sample(); // still 1 — no re-trigger

    // Another re-render to be sure.
    act(() => {
      rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles={false} />);
    });
    sample();

    // The synthesized opacity series is 0 → 1 → 1 → 1: a clean one-way fade-in,
    // NO reversal ⇒ no flash. If the class re-applied on re-render the series
    // would dip back to 0 (a down-then-up reversal) and flash → this fails.
    expect(detectOpacityFlash(series)).toBe(false);
  });
});
