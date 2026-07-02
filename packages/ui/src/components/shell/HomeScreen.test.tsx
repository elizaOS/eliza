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

import { HomeScreen } from "./HomeScreen";

afterEach(() => {
  cleanup();
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

  // #10706 — a downward pull from the thin top strip DISPATCHES the surface-
  // agnostic open event. The single always-mounted headless NotificationCenter
  // (App.tsx) is the sole renderer of the sheet/panel, so two shells can never
  // stack; HomeScreen's job here is only to fire the event. The strip is
  // deliberately off the scrollable widget list, so this can never fight scroll.
  it("dispatches the open-notification event on a downward pull from the top strip", async () => {
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    const onOpen = vi.fn();
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    try {
      render(<HomeScreen onOpenTile={vi.fn()} />);
      const zone = screen.getByTestId("home-notification-pull-zone");

      // Pull DOWN ~76px (past the 56px distance threshold), then release.
      fireEvent.pointerDown(zone, { pointerId: 1, clientX: 120, clientY: 8 });
      fireEvent.pointerMove(zone, { pointerId: 1, clientX: 120, clientY: 40 });
      fireEvent.pointerMove(zone, { pointerId: 1, clientX: 120, clientY: 84 });
      fireEvent.pointerUp(zone, { pointerId: 1, clientX: 120, clientY: 84 });

      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    }
  });

  it("does NOT dispatch the open event on an UPWARD pull (direction-gated)", async () => {
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    const onOpen = vi.fn();
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    try {
      render(<HomeScreen onOpenTile={vi.fn()} />);
      const zone = screen.getByTestId("home-notification-pull-zone");

      // Pull UP: the down-sheet must not open (onPullDown is direction-specific).
      fireEvent.pointerDown(zone, { pointerId: 1, clientX: 120, clientY: 84 });
      fireEvent.pointerMove(zone, { pointerId: 1, clientX: 120, clientY: 40 });
      fireEvent.pointerMove(zone, { pointerId: 1, clientX: 120, clientY: 8 });
      fireEvent.pointerUp(zone, { pointerId: 1, clientX: 120, clientY: 8 });

      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen);
    }
  });

  it("dispatches the open event on a click/tap/keyboard activation of the pull zone", async () => {
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
