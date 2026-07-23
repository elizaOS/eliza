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

vi.mock("../pages/LauncherSurface", () => ({
  LauncherSurface: ({ layout }: { layout: string }) => (
    <nav
      aria-label="Launcher apps"
      data-testid="home-launcher-grid"
      data-layout={layout}
    >
      <button type="button">Calendar</button>
    </nav>
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
  it("orders notifications, inline apps, then ranked widgets in one scrolling column", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // The clock/date was removed — the home stays simple.
    expect(screen.queryByTestId("home-clock")).toBeNull();
    const notifications = screen.getByTestId("home-notification-center");
    const apps = screen.getByTestId("home-apps-scroll");
    const launcher = screen.getByTestId("home-launcher-grid");
    expect(launcher.getAttribute("data-layout")).toBe("embedded");
    const host = screen.getByTestId("home-widget-host");
    expect(host.getAttribute("data-slot")).toBe("home");
    expect(
      notifications.compareDocumentPosition(apps) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(apps.contains(launcher)).toBe(true);
    expect(apps.contains(host)).toBe(true);
    expect(
      launcher.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("home-screen").className).toContain(
      "overflow-hidden",
    );
    // ONE scroller: the content column owns vertical scroll; the shade and the
    // app region are content-sized siblings inside it.
    const column = screen.getByTestId("home-content-column");
    expect(column.className).toContain("overflow-y-auto");
    expect(column.className).toContain("scrollbar-hide");
    expect(column.className).toContain("[scrollbar-width:none]");
    expect(column.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(column.hasAttribute("data-scroll-cert-scroller")).toBe(true);
    expect(column.contains(apps)).toBe(true);
    expect(apps.className).not.toContain("overflow-y-auto");
    expect(apps.className).toContain("flex-none");
  });

  it("does not render a second AOSP tile list beside the curated launcher", () => {
    render(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    expect(screen.queryByTestId("home-tiles")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Calendar" })).toHaveLength(1);
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

  it("keeps rested notifications compact and keeps apps mounted, visible, and interactive through expansion", () => {
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
    const home = screen.getByTestId("home-screen");
    const card = screen.getByTestId("home-notification-center");
    const apps = screen.getByTestId("home-apps-scroll");
    const launcher = screen.getByTestId("home-launcher-grid");
    expect(home.contains(card)).toBe(true);
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
    expect(card.className).toContain("eliza-notif-center-in");
    const header = screen.getByTestId("default-home-widgets");
    expect(
      header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    // The shade wrapper is content-sized in BOTH modes: expansion grows the
    // inbox inline and pushes apps down the one page scroller — no flex
    // reallocation, no height cap, no hiding.
    const wrapper = card.parentElement;
    expect(wrapper?.className).toContain("flex-none");
    expect(wrapper?.className).not.toContain("max-h-[40%]");
    expect(wrapper?.className).toContain("mt-4");
    expect(wrapper?.className).toContain("mb-3");
    const column = screen.getByTestId("home-content-column");
    expect(column.className).toContain("h-full");
    expect(column.className).not.toContain("min-h-full");
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(apps.contains(launcher)).toBe(true);

    const calendarButton = screen.getByRole("button", { name: "Calendar" });
    calendarButton.focus();
    fireEvent.wheel(screen.getByTestId("home-notification-list"), {
      deltaY: -(PULL_COMMIT_PX + 10),
    });
    expect(screen.getByTestId("home-notification-list").dataset.shadeMode).toBe(
      "expanded",
    );
    // Apps are NOT displaced: still rendered, still interactive, never inert.
    expect(wrapper?.className).toContain("flex-none");
    expect(apps.className).not.toContain("h-0");
    expect(apps.getAttribute("aria-hidden")).toBeNull();
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(apps.contains(launcher)).toBe(true);
    // No focus teleportation either — the launcher control keeps focus.
    expect(document.activeElement).toBe(calendarButton);
    expect(screen.getByTestId("notifications-count").style.opacity).toBe("0");
    expect(screen.queryByTestId("notification-group-label")).toBeNull();

    fireEvent.click(screen.getByTestId("notifications-collapse"));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId("home-notification-list").dataset.shadeMode).toBe(
      "rested",
    );
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(apps.getAttribute("aria-hidden")).toBeNull();
    expect(apps.contains(launcher)).toBe(true);
    expect(document.activeElement).toBe(calendarButton);
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
    const apps = screen.getByTestId("home-apps-scroll");
    expect(apps.className).toContain("flex-none");
    expect(apps.hasAttribute("inert")).toBe(false);
  });

  it("keeps apps available when the empty notification band is expanded", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const list = screen.getByTestId("home-notification-list");
    const apps = screen.getByTestId("home-apps-scroll");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX / 2 + 2) });
    expect(screen.getByTestId("notifications-empty").textContent).toBe(
      "No Notifications",
    );
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(apps.getAttribute("aria-hidden")).toBeNull();
  });

  it("keeps app focus untouched when a notification arrives in an expanded empty shade", () => {
    __setHydratedForTests(true);
    render(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<button type="button">Open Calendar</button>}
      />,
    );
    const list = screen.getByTestId("home-notification-list");
    const apps = screen.getByTestId("home-apps-scroll");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX / 2 + 2) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(apps.hasAttribute("inert")).toBe(false);

    const calendarButton = screen.getByRole("button", {
      name: "Open Calendar",
    });
    calendarButton.focus();
    act(() => {
      __ingestNotificationForTests(
        makeNotification({ title: "Priority alert", priority: "urgent" }),
      );
    });

    // Apps never leave the interaction tree, so an arrival must not displace
    // the user's focus — there is nothing to restore later either.
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(calendarButton);

    fireEvent.click(screen.getByTestId("notifications-collapse"));
    act(() => vi.advanceTimersByTime(300));
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(calendarButton);
  });

  it("leaves focus in chat while the shade expands and collapses", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Priority alert", priority: "urgent" }),
    );
    render(
      <>
        <input aria-label="Chat composer" />
        <HomeScreen
          onOpenTile={vi.fn()}
          apps={<button type="button">Open Calendar</button>}
        />
      </>,
    );
    const list = screen.getByTestId("home-notification-list");
    const apps = screen.getByTestId("home-apps-scroll");
    const calendarButton = screen.getByRole("button", {
      name: "Open Calendar",
    });
    calendarButton.focus();
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(apps.hasAttribute("inert")).toBe(false);

    const chatComposer = screen.getByRole("textbox", {
      name: "Chat composer",
    });
    chatComposer.focus();
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(300));

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(chatComposer);
  });

  it("expands from a quiet-background pull over app space but never from an interactive tile", () => {
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
    render(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<button type="button">Open Calendar</button>}
      />,
    );
    const list = screen.getByTestId("home-notification-list");
    const calendarButton = screen.getByRole("button", {
      name: "Open Calendar",
    });
    // A pull that starts on an interactive tile belongs to the tile.
    fireEvent.touchStart(calendarButton, {
      touches: [{ clientX: 200, clientY: 300 }],
    });
    fireEvent.touchMove(calendarButton, {
      touches: [{ clientX: 202, clientY: 460 }],
    });
    fireEvent.touchEnd(calendarButton, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");

    // Non-interactive app-region space is part of the one home surface: a
    // pull-down at the page top opens the shade (platform-shade idiom).
    const apps = screen.getByTestId("home-apps-scroll");
    fireEvent.touchStart(apps, {
      touches: [{ clientX: 200, clientY: 300 }],
    });
    fireEvent.touchMove(apps, {
      touches: [{ clientX: 202, clientY: 460 }],
    });
    fireEvent.touchEnd(apps, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
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
