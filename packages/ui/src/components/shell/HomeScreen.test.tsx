// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the live activity stream so the home renders deterministically.
vi.mock("../../hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({
    events: [
      {
        id: "e1",
        timestamp: Date.now() - 5000,
        eventType: "task_complete",
        summary: "Finished the build",
      },
    ],
    clearEvents: vi.fn(),
  }),
}));

// HomeScreen now mounts the unified home-slot WidgetHost (#9143) — its ranking +
// per-widget behavior is covered by the widgets suites. Here we stub it to a
// marker so HomeScreen's own responsibility (mount the host for slot "home" +
// the AOSP tiles) is what's asserted, without pulling the whole registry/app
// store into this unit test.
vi.mock("../../widgets/WidgetHost", () => ({
  WidgetHost: (props: { slot: string }) => (
    <div data-testid="home-widget-host" data-slot={props.slot} />
  ),
}));

import {
  __getNotificationShellStateForTests,
  __resetNotificationShellForTests,
} from "../../state/notifications/notification-shell";
import { HomeScreen } from "./HomeScreen";

afterEach(() => {
  cleanup();
  __resetNotificationShellForTests();
});

const NATIVE_OS_TILES = ["messages", "phone", "contacts", "camera"];

function tileIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="home-tile-"]'),
  ).map((el) => el.dataset.testid?.replace("home-tile-", "") ?? "");
}

describe("HomeScreen", () => {
  it("mounts the unified home WidgetHost (slot=home) and no clock, NO pinned tiles off-AOSP", () => {
    const { container } = render(<HomeScreen onOpenTile={vi.fn()} />);
    // The clock/date was removed — the home stays simple.
    expect(screen.queryByTestId("home-clock")).toBeNull();
    // The prioritized home widgets render through the unified WidgetHost.
    const host = screen.getByTestId("home-widget-host");
    expect(host.getAttribute("data-slot")).toBe("home");
    // Off-AOSP: zero tiles — Launcher is the adjacent launcher now, and the
    // tile grid is omitted entirely (not an empty section).
    expect(tileIds(container)).toEqual([]);
    expect(screen.queryByTestId("home-tiles")).toBeNull();
  });

  it("shows only the 4 native-OS tiles on the AOSP fork; none off-AOSP", () => {
    const { rerender, container } = render(<HomeScreen onOpenTile={vi.fn()} />);
    // Off-AOSP: no tiles at all (default tiles removed; native-OS hidden).
    for (const id of NATIVE_OS_TILES) {
      expect(screen.queryByTestId(`home-tile-${id}`)).toBeNull();
    }
    expect(tileIds(container)).toHaveLength(0);

    rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    // AOSP: exactly the four native-OS surfaces.
    expect(tileIds(container)).toEqual(NATIVE_OS_TILES);
  });

  it("opens an AOSP native-OS tile with the right target", () => {
    const onOpenTile = vi.fn();
    render(<HomeScreen onOpenTile={onOpenTile} showNativeOsTiles />);
    fireEvent.click(screen.getByTestId("home-tile-camera"));
    expect(onOpenTile).toHaveBeenCalledWith({ kind: "tab", tab: "camera" });
    fireEvent.click(screen.getByTestId("home-tile-phone"));
    expect(onOpenTile).toHaveBeenCalledWith({ kind: "tab", tab: "phone" });
  });

  it("has no Edit button or Pinned label (clean, action-driven dashboard)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-edit-toggle")).toBeNull();
    expect(screen.queryByText("Pinned")).toBeNull();
  });

  // The resting pull "pill"/grabber is gone — pulling down from anywhere on the
  // dashboard is the affordance now, and a bare pill at the top was noise the
  // redesign removes. There is no separate reveal element either: the real sheet
  // (rendered by the headless NotificationCenter) fades in and tracks the pull.
  it("has NO resting notification pill/grabber or reveal affordance", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-notification-grabber")).toBeNull();
    expect(screen.queryByTestId("home-notification-reveal")).toBeNull();
    expect(__getNotificationShellStateForTests().open).toBe(false);
  });

  // Drive a real touch drag on the scroller (the gesture uses touch events, not
  // pointer events, so it can preventDefault the top-overscroll under
  // `touch-action: pan-y`). Each waypoint is [clientX, clientY]; the first is
  // touchstart, the middle are touchmove, the last is touchend.
  function touchDrag(el: HTMLElement, points: Array<[number, number]>): void {
    const at = (x: number, y: number) => ({
      identifier: 1,
      clientX: x,
      clientY: y,
    });
    const [first, ...rest] = points;
    fireEvent.touchStart(el, {
      changedTouches: [at(...first)],
      touches: [at(...first)],
    });
    for (const p of rest.slice(0, -1)) {
      fireEvent.touchMove(el, {
        changedTouches: [at(...p)],
        touches: [at(...p)],
      });
    }
    const end = rest[rest.length - 1];
    fireEvent.touchMove(el, {
      changedTouches: [at(...end)],
      touches: [at(...end)],
    });
    fireEvent.touchEnd(el, { changedTouches: [at(...end)], touches: [] });
  }

  // The iOS-style pull-down: a downward drag ANYWHERE on the dashboard (while the
  // widget list is at the top) drives the shared shell store so the real sheet
  // fades in + tracks the finger; a release past threshold settles it OPEN.
  it("opens the notification center on a downward pull from anywhere on the dashboard", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // The gesture lives on the scroller itself, not a thin top strip. jsdom keeps
    // scrollTop at 0, so the surface is "at the top" and the top-overscroll pull
    // engages. Pull DOWN ~76px past the 60px threshold.
    touchDrag(screen.getByTestId("home-screen"), [
      [120, 20],
      [120, 60],
      [120, 96],
    ]);

    expect(__getNotificationShellStateForTests().open).toBe(true);
  });

  it("does NOT open on an UPWARD drag (direction-gated — that is native scroll)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // Pull UP: the notification pull is downward-only.
    touchDrag(screen.getByTestId("home-screen"), [
      [120, 96],
      [120, 60],
      [120, 20],
    ]);

    const shell = __getNotificationShellStateForTests();
    expect(shell.open).toBe(false);
    expect(shell.dragging).toBe(false);
  });

  it("does NOT open when the list is scrolled down (only a top-overscroll pull opens)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const surface = screen.getByTestId("home-screen");
    // Simulate a list scrolled away from the top: a downward drag here is a real
    // scroll-up of content, never the notification pull.
    Object.defineProperty(surface, "scrollTop", {
      configurable: true,
      value: 240,
    });

    touchDrag(surface, [
      [120, 20],
      [120, 60],
      [120, 96],
    ]);

    expect(__getNotificationShellStateForTests().open).toBe(false);
  });

  it("does NOT open on a horizontal swipe (that belongs to the home↔launcher pager)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // Horizontal-dominant drag: the pull hook rejects it so the pager owns it.
    touchDrag(screen.getByTestId("home-screen"), [
      [40, 40],
      [120, 46],
      [220, 52],
    ]);

    expect(__getNotificationShellStateForTests().open).toBe(false);
  });

  it("keeps a click/keyboard entry point on the top-edge button (desktop/AT)", async () => {
    // The top-edge button opens via the surface-agnostic event (the headless
    // NotificationCenter — mounted app-wide, not here — turns it into a store
    // open), so this asserts the event, the button's public contract.
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    const onOpen = vi.fn();
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    try {
      render(<HomeScreen onOpenTile={vi.fn()} />);
      fireEvent.click(screen.getByTestId("home-notification-pull-zone"));
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    }
  });
});
