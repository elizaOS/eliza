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

  // Notifications are hidden until pulled up (Apple idiom): no pinned inbox
  // card on the dashboard, no legacy pull-down shells.
  it("has NO pinned notification center or pull-down affordance at rest", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
    expect(screen.queryByTestId("home-notification-pull-zone")).toBeNull();
    expect(screen.queryByTestId("home-notification-grabber")).toBeNull();
    expect(screen.queryByTestId("home-notification-reveal")).toBeNull();
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  it("hides the notifications pull-down hint while the inbox is empty", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-notifications-hint")).toBeNull();
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
  });

  // DEVICE FEEDBACK (adjusting #15039's placement): the hint used to render as
  // the FIRST flow item inside the scroll column, ABOVE the clock — on device
  // it floated in the upper-middle mid-air like a misplaced iOS lock-screen
  // element. It now hugs the TOP EDGE of the home surface (the iOS
  // notification-center idiom: you pull from the edge, the affordance lives at
  // the edge), anchored under the status-bar safe area and OUT of the flow
  // column so it never pushes the clock down.
  it("anchors the notifications hint at the top edge, not in the flow column above the clock", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const hint = screen.getByTestId("home-notifications-hint");
    // The pill's positioning wrapper (its grandparent: pill -> pointer-events
    // re-enable div -> absolute top-edge wrapper) must be an absolute, top-edge
    // anchored element keyed to the safe-area top inset.
    const inner = hint.parentElement;
    const wrapper = inner?.parentElement;
    const cls = wrapper?.className ?? "";
    expect(cls).toContain("absolute");
    expect(cls).toContain("--safe-area-top");

    // It must NOT sit inside the flow column that starts with the clock/widgets.
    // The clock base (home-time / DefaultHomeWidgets) lives in the max-w-2xl
    // flex column; the hint wrapper is a sibling of that column, not an
    // ancestor-descendant of it.
    const column = wrapper?.parentElement?.querySelector(".max-w-2xl");
    expect(column).not.toBeNull();
    expect(column?.contains(hint)).toBe(false);
  });

  // Blur budget (#9141 / #14943): the home spends its ONE backdrop-filter on the
  // pinned notification center / shade. The top-edge hint is a quiet whisper and
  // must stay blur-free (a soft float shadow carries legibility instead), so it
  // adds no new compositing surface over the wallpaper.
  it("renders the notifications hint blur-free (no backdrop-filter on the pill)", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const hint = screen.getByTestId("home-notifications-hint");
    expect(hint.className).not.toMatch(/backdrop-blur|backdrop-filter/);
    expect(hint.className).not.toContain("supports-[backdrop-filter]");
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

  it("pins the notification center widget between the base widgets and the WidgetHost once notifications exist", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // Hidden until pulled down: only the quiet hint pill is on the dashboard.
    const hint = screen.getByTestId("home-notifications-hint");
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
    fireEvent.click(hint);
    // The shade carries the shared inbox card, grouped by view.
    expect(screen.getByTestId("notifications-shade")).toBeTruthy();
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    expect(screen.getByTestId("notification-group-label")).toBeTruthy();
    // Scrim tap closes the shade.
    fireEvent.click(screen.getByTestId("notifications-shade-scrim"));
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
  });

  it("opens the shade on a downward pull of the hint pill", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const hint = screen.getByTestId("home-notifications-hint");
    fireEvent.pointerDown(hint, { clientY: 100, pointerId: 1 });
    // Under the 24px threshold: still hidden.
    fireEvent.pointerMove(hint, { clientY: 110, pointerId: 1 });
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
    // Past the threshold (dragging DOWN): the shade opens mid-gesture.
    fireEvent.pointerMove(hint, { clientY: 130, pointerId: 1 });
    expect(screen.getByTestId("notifications-shade")).toBeTruthy();
  });

  // Item 5: opening the shade collapses the chat (the reveal and the chat
  // dismissal are one motion). Proven here via the hint tap — the reliable
  // pointer path; the region-wide downward TOUCH drag is a non-passive
  // touchmove that jsdom can't model faithfully (touch-action / preventDefault),
  // so that gesture is covered by the real-touch e2e in gesture-matrix.spec.ts.
  it("fires eliza:chat:collapse when the shade opens", () => {
    const collapse = vi.fn();
    window.addEventListener("eliza:chat:collapse", collapse);
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);
    fireEvent.click(screen.getByTestId("home-notifications-hint"));
    expect(screen.getByTestId("notifications-shade")).toBeTruthy();
    expect(collapse).toHaveBeenCalledTimes(1);
    window.removeEventListener("eliza:chat:collapse", collapse);
  });

  it("closes the notification shade when a row follows a safe deep link", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Open settings" }),
    );
    render(<HomeScreen onOpenTile={vi.fn()} />);
    fireEvent.click(screen.getByTestId("home-notifications-hint"));
    expect(screen.getByTestId("notifications-shade")).toBeTruthy();

    fireEvent.click(screen.getByTestId("notification-row"));

    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
  });
});
