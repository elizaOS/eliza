/** Verifies HomeScreen through the package's configured test harness. */
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
import {
  consumeNotificationCenterOpenRequest,
  requestNotificationCenterOpen,
} from "./notification-center-open-request";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  __resetNotificationStoreForTests();
  __resetHomeDismissalsForTests();
  while (consumeNotificationCenterOpenRequest() !== null) {
    // Home consumes this one-shot intent; drain only if a failed test did not.
  }
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
  it("keeps notifications and ranked widgets on the home page without embedding the launcher", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    // The clock/date was removed — the home stays simple.
    expect(screen.queryByTestId("home-clock")).toBeNull();
    const notifications = screen.getByTestId("home-notification-center");
    const apps = screen.getByTestId("home-apps-scroll");
    const host = screen.getByTestId("home-widget-host");
    expect(host.getAttribute("data-slot")).toBe("home");
    expect(
      notifications.compareDocumentPosition(apps) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(apps.contains(host)).toBe(true);
    expect(screen.queryByTestId("home-launcher-grid")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Launcher apps" }),
    ).toBeNull();
    expect(screen.getByTestId("home-screen").className).toContain(
      "overflow-hidden",
    );
    expect(apps.className).toContain("overflow-y-auto");
    expect(apps.className).toContain("scrollbar-hide");
    expect(apps.className).toContain("[scrollbar-width:none]");
    expect(apps.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(apps.hasAttribute("data-scroll-cert-scroller")).toBe(true);
    expect(
      apps.parentElement?.hasAttribute("data-home-below-notifications"),
    ).toBe(true);
  });

  it("does not place launcher or AOSP app grids beside home notifications", () => {
    render(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    expect(screen.queryByTestId("home-tiles")).toBeNull();
    expect(screen.queryByRole("button", { name: "Calendar" })).toBeNull();
  });

  it("lets notifications use the real short-screen remainder instead of a viewport percentage", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const home = screen.getByTestId("home-screen");
    const css = home.querySelector("style")?.textContent ?? "";
    const region = home.querySelector<HTMLElement>(
      "[data-home-notification-region]",
    );

    expect(css).toContain("max-height: min(20rem, 100%)");
    expect(css).not.toContain("max-height: 40%");
    expect(region?.className).toContain("min-h-0");
    expect(screen.getByTestId("home-apps-scroll").className).toContain(
      "overflow-y-auto",
    );
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

  it("keeps rested notifications compact, then displaces and restores focused secondary content", () => {
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
        apps={<button type="button">Calendar</button>}
      />,
    );
    const home = screen.getByTestId("home-screen");
    const card = screen.getByTestId("home-notification-center");
    const apps = screen.getByTestId("home-apps-scroll");
    const calendarButton = screen.getByRole("button", { name: "Calendar" });
    expect(home.contains(card)).toBe(true);
    expect(screen.queryByTestId("notifications-shade")).toBeNull();
    expect(card.className).toContain("eliza-notif-center-in");
    const header = screen.getByTestId("default-home-widgets");
    expect(
      header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    const wrapper = card.parentElement;
    expect(wrapper?.hasAttribute("data-home-notification-region")).toBe(true);
    expect(wrapper?.className).toContain("mt-4");
    expect(wrapper?.className).toContain("mb-3");
    expect(wrapper?.className).toContain("max-sm:-mx-2");
    expect(card.className).toContain("flex-1");
    const column = screen.getByTestId("home-content-column");
    const secondaryRegion = apps.parentElement;
    expect(column.className).toContain("h-full");
    expect(column.className).not.toContain("min-h-full");
    expect(secondaryRegion?.className).toContain("flex-1");
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(apps.contains(calendarButton)).toBe(true);
    apps.scrollTop = 96;

    // The redesigned inbox starts fully populated in its capped region. Fold
    // it once before exercising an explicit expansion that occupies Home.
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));

    calendarButton.focus();
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(apps.className).toContain("overflow-y-auto");
    expect(apps.className).not.toContain("overflow-y-hidden");
    expect(apps.getAttribute("aria-hidden")).toBe("true");
    expect(apps.hasAttribute("inert")).toBe(true);
    expect(apps.contains(calendarButton)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByTestId("home-notification-center"),
    );
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notification-group-label")).toBeNull();

    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByTestId("home-notification-list").dataset.shadeMode).toBe(
      "rested",
    );
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(apps.getAttribute("aria-hidden")).toBeNull();
    expect(apps.className).toContain("overflow-y-auto");
    expect(apps.contains(calendarButton)).toBe(true);
    expect(apps.scrollTop).toBe(96);
    expect(document.activeElement).toBe(calendarButton);
  });

  it("settles the shade and secondary home content on one velocity-aware clock", () => {
    __ingestNotificationForTests(makeNotification());
    render(<HomeScreen onOpenTile={vi.fn()} />);

    const column = screen.getByTestId("home-content-column");
    const list = screen.getByTestId("home-notification-list");
    const notificationRegion = column.querySelector<HTMLElement>(
      "[data-home-notification-region]",
    );
    const secondaryRegion = column.querySelector<HTMLElement>(
      "[data-home-below-notifications]",
    );
    expect(column.hasAttribute("data-home-has-notifications")).toBe(true);
    expect(notificationRegion).toBeTruthy();
    expect(secondaryRegion).toBeTruthy();
    expect(
      secondaryRegion?.contains(screen.getByTestId("home-widget-host")),
    ).toBe(true);

    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 91,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 91,
      clientX: 100,
      clientY: 130,
    });
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");
    expect(list.hasAttribute("data-shade-dragging")).toBe(true);
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 91,
      clientX: 100,
      clientY: 130,
    });
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(
      screen
        .getByTestId("home-notification-center")
        .hasAttribute("data-notification-shade-cancelling"),
    ).toBe(true);
    expect(
      column.style.getPropertyValue(
        "--eliza-home-notification-settle-duration",
      ),
    ).toMatch(/^\d+ms$/);
    act(() => vi.advanceTimersByTime(700));
    expect(list.hasAttribute("data-shade-preview")).toBe(false);

    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    expect(
      column.style.getPropertyValue(
        "--eliza-home-notification-settle-duration",
      ),
    ).toBe("460ms");
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
    expect(apps.parentElement?.className).toContain("flex-1");
    expect(apps.hasAttribute("inert")).toBe(false);
  });

  it("opens the empty notification center from a warm shell request", () => {
    __setHydratedForTests(true);
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const list = screen.getByTestId("home-notification-list");
    const empty = screen.getByTestId("notifications-empty");
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(empty.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      requestNotificationCenterOpen();
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(empty.getAttribute("aria-hidden")).toBeNull();
    expect(empty.style.opacity).toBe("1");
  });

  it("consumes a retained cold-launch request after Home mounts without replaying it", () => {
    __setHydratedForTests(true);
    requestNotificationCenterOpen();

    const firstMount = render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");
    expect(
      screen.getByTestId("notifications-empty").getAttribute("aria-hidden"),
    ).toBeNull();
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("1");

    firstMount.unmount();
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("rested");
    expect(
      screen.getByTestId("notifications-empty").getAttribute("aria-hidden"),
    ).toBe("true");
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
    expect(apps.className).toContain("overflow-y-auto");
  });

  it("moves and restores app focus when a notification arrives in an expanded empty shade", () => {
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
    act(() => vi.advanceTimersByTime(700));

    const calendarButton = screen.getByRole("button", {
      name: "Open Calendar",
    });
    calendarButton.focus();
    act(() => {
      __ingestNotificationForTests(
        makeNotification({ title: "Priority alert", priority: "urgent" }),
      );
    });

    expect(apps.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByTestId("home-notification-center"),
    );

    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));
    expect(apps.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(calendarButton);
  });

  it("does not steal focus back from chat when the expanded shade collapses", () => {
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
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));
    calendarButton.focus();
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(apps.hasAttribute("inert")).toBe(true);
    act(() => vi.advanceTimersByTime(700));

    const chatComposer = screen.getByRole("textbox", {
      name: "Chat composer",
    });
    chatComposer.focus();
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));

    expect(apps.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(chatComposer);
  });

  it("lets an empty-inbox vertical pull start below the notification band", () => {
    __setHydratedForTests(true);
    render(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<button type="button">Open Calendar</button>}
      />,
    );
    const apps = screen.getByTestId("home-apps-scroll");
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(apps, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notifications-empty").textContent).toBe(
      "No Notifications",
    );

    act(() => vi.advanceTimersByTime(700));
    fireEvent.wheel(apps, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(apps, { deltaY: PULL_COMMIT_PX + 10 });
    act(() => vi.advanceTimersByTime(700));
    expect(list.getAttribute("data-shade-mode")).toBe("rested");

    fireEvent.touchStart(apps, {
      touches: [{ clientX: 200, clientY: 300 }],
    });
    fireEvent.touchMove(apps, {
      touches: [{ clientX: 202, clientY: 440 }],
    });
    fireEvent.touchEnd(apps, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("yields a horizontal drag below the empty notification band to the home pager", () => {
    __setHydratedForTests(true);
    render(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<button type="button">Open Calendar</button>}
      />,
    );
    const apps = screen.getByTestId("home-apps-scroll");
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(apps, {
      touches: [{ clientX: 280, clientY: 320 }],
    });
    fireEvent.touchMove(apps, {
      touches: [{ clientX: 100, clientY: 324 }],
    });
    fireEvent.touchEnd(apps, { touches: [] });

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
