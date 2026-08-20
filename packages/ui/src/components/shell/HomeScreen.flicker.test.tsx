/**
 * Verifies that the Home entrance rise plays once without fading readable
 * content, then stays settled across later renders (#9304).
 */
// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../../state/notifications/notification-store";
import { __resetHomeEntranceForTests, HomeScreen } from "./HomeScreen";

beforeEach(() => {
  vi.useFakeTimers();
  __resetHomeEntranceForTests();
  __resetNotificationStoreForTests();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  __resetNotificationStoreForTests();
  vi.restoreAllMocks();
});

function homeBlocks(container: HTMLElement): HTMLElement[] {
  // The home-enter blocks are the direct children of the centered column.
  const column = container.querySelector<HTMLElement>(".mx-auto");
  if (!column) return [];
  return Array.from(column.children) as HTMLElement[];
}

function classOnAnyBlock(container: HTMLElement): boolean {
  return homeBlocks(container).some((el) =>
    el.classList.contains("home-enter"),
  );
}

describe("HomeScreen entrance flicker lock (#9304)", () => {
  it("keeps secondary content unpainted until initial notification hydration settles", () => {
    const { container } = render(
      <HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />,
    );
    const belowNotifications = container.querySelector<HTMLElement>(
      "[data-home-below-notifications]",
    );
    const homeContent = container.querySelector<HTMLElement>(
      '[aria-label="Home content"]',
    );

    expect(
      belowNotifications?.hasAttribute("data-home-notifications-pending"),
    ).toBe(true);
    expect(homeContent?.getAttribute("aria-hidden")).toBe("true");
    expect(homeContent?.hasAttribute("inert")).toBe(true);

    act(() => __setHydratedForTests(true));
    expect(
      belowNotifications?.hasAttribute("data-home-notifications-pending"),
    ).toBe(false);
    expect(homeContent?.hasAttribute("aria-hidden")).toBe(false);
    expect(homeContent?.hasAttribute("inert")).toBe(false);
  });

  it("plays home-enter once on mount, never re-adds it on a later re-render (no flash)", () => {
    const { container, rerender } = render(
      <HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />,
    );

    // First mount: the entrance class is present, but content remains opaque.
    expect(classOnAnyBlock(container)).toBe(true);
    expect(
      container
        .querySelector("[data-home-below-notifications]")
        ?.getAttribute("data-eliza-layout-shift-intent"),
    ).toBe("transient");
    // Advance past the mount window so the once-guard strips the class.
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(classOnAnyBlock(container)).toBe(false); // entrance done, class gone
    expect(
      container
        .querySelector("[data-home-below-notifications]")
        ?.hasAttribute("data-eliza-layout-shift-intent"),
    ).toBe(false);
    // A later re-render (e.g. a prop / resize-driven update) must NOT re-add the
    // entrance class — this is the regression the bug caused.
    act(() => {
      rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    });
    expect(classOnAnyBlock(container)).toBe(false);

    // Another re-render to be sure.
    act(() => {
      rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles={false} />);
    });
    expect(classOnAnyBlock(container)).toBe(false);
  });

  it("does not replay the entrance after leaving and returning home", () => {
    const first = render(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    expect(classOnAnyBlock(first.container)).toBe(true);

    first.unmount();
    const second = render(
      <HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />,
    );

    expect(classOnAnyBlock(second.container)).toBe(false);
  });
});
