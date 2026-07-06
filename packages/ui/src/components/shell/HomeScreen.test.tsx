// @vitest-environment jsdom

// HomeScreen composition: the unified home WidgetHost, the pinned dashboard
// notification center, and the AOSP-only tile grid, with the notification
// store driven directly (no network).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigateDeepLink = vi.hoisted(() => vi.fn());
vi.mock("../../state/notifications/navigate-deep-link", async (orig) => ({
  ...(await orig()),
  navigateDeepLink,
}));

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
// the pinned notification center + the AOSP tiles) is what's asserted, without
// pulling the whole registry/app store into this unit test.
vi.mock("../../widgets/WidgetHost", () => ({
  WidgetHost: (props: { slot: string }) => (
    <div data-testid="home-widget-host" data-slot={props.slot} />
  ),
}));

import type { AgentNotification } from "@elizaos/core";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import { __resetHomeDismissalsForTests } from "../../widgets/home-dismissal-store";
import { HomeScreen } from "./HomeScreen";

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
  __resetHomeDismissalsForTests();
  navigateDeepLink.mockClear();
});

const NATIVE_OS_TILES = ["messages", "phone", "contacts", "camera"];

function tileIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="home-tile-"]'),
  ).map((el) => el.dataset.testid?.replace("home-tile-", "") ?? "");
}

function makeNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  return {
    id: "11111111-1111-1111-1111-111111111111" as AgentNotification["id"],
    title: "Build finished",
    category: "task",
    priority: "normal",
    source: "test",
    createdAt: Date.now() - 60_000,
    readAt: null,
    ...overrides,
  };
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

  // Notifications render INLINE on the home column (no pull-down shade, no hint
  // pill): the inbox self-hides while empty and appears in place when it fills.
  it("hides the notification inbox while empty (and has no shade/hint shells)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
    expect(screen.queryByTestId("home-notifications-hint")).toBeNull();
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
  });

  it("renders the notification inbox inline (Apple-style fade-in), below the time/weather header", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const home = screen.getByTestId("home-screen");
    const card = screen.getByTestId("home-notification-center");
    // Inline on the same layer — it lives INSIDE the home scroller, not a portal
    // shade over it.
    expect(home.contains(card)).toBe(true);
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
    // Apple-style entrance.
    expect(card.className).toContain("eliza-notif-center-in");
    // Positioned AFTER the time/weather header in the column.
    const header = screen.getByTestId("default-home-widgets");
    expect(
      header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    // The wrapper grows to fill the column down to the chat (flex-1) and keeps a
    // small margin below the header (mt-4).
    const wrapper = card.parentElement;
    expect(wrapper?.className).toContain("flex-1");
    expect(wrapper?.className).toContain("mt-4");
    // The inbox itself fills its wrapper and scrolls internally.
    expect(card.className).toContain("flex-1");
    // Rows are grouped by view.
    expect(screen.getByTestId("notification-group-label")).toBeTruthy();
  });

  it("does NOT grow the notification region when the inbox is empty (calm centred home)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // Empty inbox self-hides; the widget breathing region keeps the flex-1 fill.
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
    const hostWrapper = screen.getByTestId("home-widget-host").parentElement;
    expect(hostWrapper?.className).toContain("flex-1");
    expect(hostWrapper?.className).toContain("justify-center");
  });

  // GESTURE-HINT OVERLAP FIX (#14945 follow-up): the one-time gesture hint
  // ("Swipe for apps. Pull chat up. Hold wallpaper to restyle.") sat as the last
  // flow item in the scroll column, flush against the top of the reserved
  // composer-clearance zone — on device the floating composer overlapped it and
  // only the top few pixels of the hint peeked above the composer edge. Its
  // wrapper must carry an explicit bottom clearance keyed to the composer
  // footprint + safe area so it can NEVER render under the composer.
  it("anchors the gesture hint above the floating composer (explicit bottom clearance, never overlapping)", () => {
    // The gesture hint is a one-time widget; ensure a pristine dismissal store
    // so it renders on this mount.
    __resetHomeDismissalsForTests();
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const hint = screen.getByTestId("home-gesture-hint");
    // The hint's positioning wrapper is its parent in the HomeScreen column.
    const wrapper = hint.parentElement;
    expect(wrapper).not.toBeNull();
    const cls = wrapper?.className ?? "";
    // The wrapper must reserve clearance for the floating composer footprint
    // (the measured pill height var) plus the bottom safe area, so the hint
    // always sits fully ABOVE the composer, not behind it.
    expect(cls).toContain("--eliza-continuous-chat-clearance");
    expect(cls).toMatch(/safe-area-bottom|android-gesture-inset-bottom/);
  });

  it("tapping an inline row follows its safe deep link", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Open settings" }),
    );
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
  });
});
