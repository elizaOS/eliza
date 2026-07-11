// @vitest-environment jsdom

// HomeScreen composition: the unified home WidgetHost, the pinned dashboard
// notification center, and the AOSP-only tile grid, with the notification
// store driven directly (no network).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  __setHydratedForTests,
} from "../../state/notifications/notification-store";
import { __resetHomeDismissalsForTests } from "../../widgets/home-dismissal-store";
import { HomeScreen } from "./HomeScreen";
import { PULL_COMMIT_PX } from "./NotificationsHomeCenter";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
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
    // High so the row renders in the rested (interrupt-tier-only) shade.
    priority: "high",
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

  // Notifications render INLINE on the home column (no portal shade or hint
  // pill). Before hydration there is no surface, avoiding a false empty flash.
  it("hides the notification inbox while initial hydration is pending", () => {
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
    // The containing flex column has a definite height. `min-h-full` lets a
    // large inbox grow to its content height and continue behind the composer.
    const column = screen.getByTestId("home-content-column");
    expect(column.className).toContain("h-full");
    expect(column.className).not.toContain("min-h-full");
    // Closed keeps interrupt-tier rows above the total; opening reveals every
    // priority with no header eyebrows.
    expect(screen.getByTestId("notifications-count")).toBeTruthy();
    expect(screen.getByTestId("notification-row")).toBeTruthy();
    fireEvent.wheel(screen.getByTestId("home-notification-list"), {
      deltaY: -(PULL_COMMIT_PX + 10),
    });
    expect(screen.getByTestId("notification-row")).toBeTruthy();
    expect(screen.getByTestId("notifications-count").style.opacity).toBe("0");
    expect(screen.queryByTestId("notification-group-label")).toBeNull();
  });

  it("keeps widget taps inert and expands a populated shade from a widget-area pull", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Priority alert", priority: "urgent" }),
    );
    __ingestNotificationForTests(
      makeNotification({
        id: "22222222-2222-4222-8222-222222222222" as AgentNotification["id"],
        title: "Quiet summary",
        priority: "normal",
      }),
    );
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const timeWidget = screen.getByTestId("home-time-widget");
    const center = screen.getByTestId("home-notification-center");
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(timeWidget, {
      touches: [{ clientX: 100, clientY: 80 }],
    });
    fireEvent.touchEnd(timeWidget, { touches: [] });
    fireEvent.click(timeWidget);
    expect(screen.getByTestId("home-notification-center")).toBe(center);
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);

    fireEvent.touchStart(timeWidget, {
      touches: [{ clientX: 100, clientY: 80 }],
    });
    fireEvent.touchMove(timeWidget, {
      touches: [{ clientX: 102, clientY: 230 }],
    });
    fireEvent.touchEnd(timeWidget, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notifications-count").style.opacity).toBe("0");
  });

  it("keeps the hydrated empty gesture band quiet without growing the notification region", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // The pull target is mounted but has no visible empty label until dragged.
    const center = screen.getByTestId("home-notification-center");
    expect(center.className).toContain("min-h-14");
    expect(center.className).not.toContain("eliza-notif-center-in");
    const empty = screen.getByTestId("notifications-empty");
    expect(empty.style.opacity).toBe("0");
    expect(empty.getAttribute("aria-hidden")).toBe("true");
    expect(center.parentElement?.className).not.toContain("flex-1");
    // The widget breathing region keeps the flex-1 fill.
    const hostWrapper = screen.getByTestId("home-widget-host").parentElement;
    expect(hostWrapper?.className).toContain("flex-1");
    expect(hostWrapper?.className).toContain("justify-center");
  });

  it("reveals the empty state from a pull on the quiet home background", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const home = screen.getByTestId("home-screen");
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(home, {
      touches: [{ clientX: 200, clientY: 300 }],
    });
    fireEvent.touchMove(home, {
      // An 80px pull clears the empty-state threshold while remaining below
      // the populated shade's commit threshold after resistance.
      touches: [{ clientX: 202, clientY: 380 }],
    });
    expect(screen.getByTestId("notifications-empty").textContent).toBe(
      "No Notifications",
    );
    fireEvent.touchEnd(home, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");

    fireEvent.touchStart(home, {
      touches: [{ clientX: 200, clientY: 440 }],
    });
    fireEvent.touchMove(home, {
      touches: [{ clientX: 202, clientY: 300 }],
    });
    fireEvent.touchEnd(home, { touches: [] });
    act(() => vi.advanceTimersByTime(300));
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("0");
  });

  it("reveals and closes the empty state from a trackpad swipe on the home background", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const home = screen.getByTestId("home-screen");
    const list = screen.getByTestId("home-notification-list");

    fireEvent.wheel(home, { deltaY: -(PULL_COMMIT_PX / 2 + 2) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notifications-empty").textContent).toBe(
      "No Notifications",
    );

    // Opposite-direction rebound during the settle cannot hide the empty
    // status and make it flash back on trailing momentum.
    fireEvent.wheel(home, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(home, { deltaY: PULL_COMMIT_PX + 10 });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");

    act(() => vi.advanceTimersByTime(500));
    fireEvent.wheel(home, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(home, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(300));
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("0");
  });

  it("does not steal an empty-inbox gesture that begins on a home control", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    const tile = screen.getByTestId("home-tile-camera");
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(tile, {
      touches: [{ clientX: 200, clientY: 300 }],
    });
    fireEvent.touchMove(tile, {
      touches: [{ clientX: 202, clientY: 440 }],
    });
    fireEvent.touchEnd(tile, { touches: [] });
    fireEvent.wheel(tile, { deltaY: -(PULL_COMMIT_PX + 10) });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("0");
  });

  it("tapping an inline row follows its safe deep link directly", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Open settings" }),
    );
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    fireEvent.wheel(screen.getByTestId("home-notification-list"), {
      deltaY: -(PULL_COMMIT_PX + 10),
    });
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
  });
});
