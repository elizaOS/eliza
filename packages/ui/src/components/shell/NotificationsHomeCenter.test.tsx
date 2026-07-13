// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  client: {
    listNotifications: vi.fn(async () => ({
      notifications: [],
      unreadCount: 0,
    })),
    onWsEvent: vi.fn(),
    markNotificationRead: vi.fn(async () => ({})),
    markAllNotificationsRead: vi.fn(async () => ({})),
    removeNotification: vi.fn(async () => ({})),
    clearNotifications: vi.fn(async () => ({})),
  },
}));

const navigateDeepLink = vi.hoisted(() => vi.fn());
vi.mock("../../state/notifications/navigate-deep-link", async (original) => ({
  ...(await original()),
  navigateDeepLink,
}));

import type { AgentNotification } from "@elizaos/core";
import {
  __getStateForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../../state/notifications/notification-store";
import {
  groupDashboardNotifications,
  isInterruptPriority,
  NOTIFICATION_LIST_MAX_HEIGHT,
  NotificationsHomeCenter,
  notificationGroupKey,
  notificationGroupLabel,
  orderDashboardNotifications,
  STACK_FAN_GESTURE_PX,
} from "./NotificationsHomeCenter";

let sequence = 0;
function notification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}` as AgentNotification["id"],
    title: `Notification ${sequence}`,
    category: "general",
    priority: "high",
    source: "test",
    createdAt: 1_700_000_000_000 + sequence * 1000,
    readAt: null,
    ...overrides,
  };
}

function seedPriorityAndQuietSameProducer(): void {
  __ingestNotificationForTests(
    notification({ title: "Quiet detail", priority: "normal" }),
  );
  __ingestNotificationForTests(
    notification({ title: "Priority alert", priority: "urgent" }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  sequence = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  __resetNotificationStoreForTests();
  navigateDeepLink.mockClear();
});

describe("notification ordering and grouping", () => {
  it("orders by priority, recency, then id", () => {
    const low = notification({ priority: "low", createdAt: 100 });
    const urgent = notification({ priority: "urgent", createdAt: 50 });
    const normal = notification({ priority: "normal", createdAt: 200 });

    expect(orderDashboardNotifications([low, urgent, normal])).toEqual([
      urgent,
      normal,
      low,
    ]);
  });

  it("groups normalized producers while retaining priority order", () => {
    const githubNormal = notification({
      source: "github",
      priority: "normal",
    });
    const calendar = notification({ source: "calendar", priority: "high" });
    const githubUrgent = notification({
      source: "github",
      priority: "urgent",
    });
    const groups = groupDashboardNotifications([
      githubNormal,
      calendar,
      githubUrgent,
    ]);

    expect(groups.map((group) => group.key)).toEqual(["github", "calendar"]);
    expect(groups[0]?.rows).toEqual([githubUrgent, githubNormal]);
    expect(notificationGroupKey(githubUrgent)).toBe("github");
    expect(notificationGroupLabel(githubUrgent)).toBe("Github");
  });

  it("uses the core interrupt tier for the resting projection", () => {
    expect(isInterruptPriority(notification({ priority: "urgent" }))).toBe(
      true,
    );
    expect(isInterruptPriority(notification({ priority: "high" }))).toBe(true);
    expect(isInterruptPriority(notification({ priority: "normal" }))).toBe(
      false,
    );
    expect(isInterruptPriority(notification({ priority: "low" }))).toBe(false);
  });
});

describe("NotificationsHomeCenter mode", () => {
  it("occupies no space before hydration or when the hydrated inbox is empty", () => {
    const { rerender } = render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("home-notification-center")).toBeNull();

    __setHydratedForTests(true);
    rerender(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
  });

  it("rests on interrupt notifications and exposes one persistent mode toggle", () => {
    __ingestNotificationForTests(
      notification({ title: "Low", priority: "low", source: "system" }),
    );
    __ingestNotificationForTests(
      notification({
        title: "Normal",
        priority: "normal",
        source: "calendar",
      }),
    );
    __ingestNotificationForTests(
      notification({ title: "Urgent", priority: "urgent", source: "github" }),
    );
    render(<NotificationsHomeCenter />);

    const list = screen.getByTestId("home-notification-list");
    const toggle = screen.getByTestId("notifications-mode-toggle");
    expect(list.getAttribute("data-inbox-mode")).toBe("priority");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByText("Urgent")).toBeTruthy();
    expect(toggle.textContent).toContain("2 More");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(list.getAttribute("data-inbox-mode")).toBe("all");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(
      screen.getByTestId("notifications-mode-toggle").textContent,
    ).toContain("Show Less");
    expect(
      screen
        .getByTestId("notifications-mode-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("notifications-mode-toggle"));
    expect(list.getAttribute("data-inbox-mode")).toBe("priority");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByText("Urgent")).toBeTruthy();
  });

  it("never changes whole-inbox mode from list wheel, pointer drag, or outside click", () => {
    __ingestNotificationForTests(
      notification({ priority: "urgent", source: "github" }),
    );
    __ingestNotificationForTests(
      notification({ priority: "normal", source: "calendar" }),
    );
    render(
      <div>
        <NotificationsHomeCenter />
        <button type="button">Outside</button>
      </div>,
    );
    const list = screen.getByTestId("home-notification-list");

    fireEvent.wheel(list, { deltaY: -400 });
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 20,
      clientY: 180,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 20,
      clientY: 180,
    });
    fireEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(list.getAttribute("data-inbox-mode")).toBe("priority");

    fireEvent.click(screen.getByTestId("notifications-mode-toggle"));
    fireEvent.wheel(list, { deltaY: 600 });
    fireEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(list.getAttribute("data-inbox-mode")).toBe("all");
  });

  it("is natural-height and bounded, with native vertical scrolling semantics", () => {
    __ingestNotificationForTests(notification());
    render(<NotificationsHomeCenter />);

    const center = screen.getByTestId("home-notification-center");
    const list = screen.getByTestId("home-notification-list");
    expect(center.className).not.toContain("flex-1");
    expect(list.style.maxHeight).toBe(NOTIFICATION_LIST_MAX_HEIGHT);
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("overscroll-y-contain");
    expect(list.className).toContain("touch-pan-y");
  });

  it("starts scrolling toward the first newly revealed quiet group after explicit expansion", () => {
    __ingestNotificationForTests(
      notification({ priority: "urgent", source: "github" }),
    );
    __ingestNotificationForTests(
      notification({ priority: "normal", source: "calendar" }),
    );
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 200,
    });
    const scrollTo = vi.fn();
    Object.defineProperty(list, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    fireEvent.click(screen.getByTestId("notifications-mode-toggle"));
    const newlyRevealed = list.querySelector<HTMLElement>(
      "[data-inbox-newly-revealed]",
    );
    expect(newlyRevealed).toBeTruthy();
    Object.defineProperty(newlyRevealed as HTMLElement, "offsetTop", {
      configurable: true,
      value: 300,
    });
    act(() => vi.advanceTimersByTime(20));

    expect(scrollTo).toHaveBeenCalledWith({ top: 250, behavior: "smooth" });
  });
});

describe("NotificationsHomeCenter producer stacks", () => {
  it("fans a producer independently and reveals its complete quiet rows in priority mode", () => {
    seedPriorityAndQuietSameProducer();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");

    expect(list.getAttribute("data-inbox-mode")).toBe("priority");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(
      screen.getByTestId("notifications-mode-toggle").textContent,
    ).toContain("1 More");
    fireEvent.click(screen.getByTestId("notification-row"));

    expect(list.getAttribute("data-inbox-mode")).toBe("priority");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.getByText("Priority alert")).toBeTruthy();
    expect(screen.getByText("Quiet detail")).toBeTruthy();
    expect(screen.queryByTestId("notifications-mode-toggle")).toBeNull();
    expect(navigateDeepLink).not.toHaveBeenCalled();
  });

  it("fans only the targeted stack from a vertical mouse drag", () => {
    seedPriorityAndQuietSameProducer();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    const swipeSurface = screen.getByTestId("notification-row-swipe");

    fireEvent.pointerDown(swipeSurface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 3,
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerMove(swipeSurface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 3,
      clientX: 42,
      clientY: 40 + STACK_FAN_GESTURE_PX + 4,
    });
    fireEvent.pointerUp(swipeSurface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 3,
      clientX: 42,
      clientY: 40 + STACK_FAN_GESTURE_PX + 4,
    });

    expect(list.getAttribute("data-inbox-mode")).toBe("priority");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.queryByTestId("notification-stack")).toBeNull();
    fireEvent.click(
      screen.getAllByTestId("notification-row")[0] as HTMLElement,
    );
    expect(__getStateForTests().notifications).toHaveLength(2);
    fireEvent.click(
      screen.getAllByTestId("notification-row")[0] as HTMLElement,
    );
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("fans only the targeted stack from a vertical trackpad run", () => {
    seedPriorityAndQuietSameProducer();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    const swipeSurface = screen.getByTestId("notification-row-swipe");

    fireEvent.wheel(swipeSurface, { deltaX: 0, deltaY: 24 });
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    fireEvent.wheel(swipeSurface, { deltaX: 1, deltaY: 26 });

    expect(list.getAttribute("data-inbox-mode")).toBe("priority");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);

    // Wheel input has no compatibility click to suppress. The next deliberate
    // row click must act immediately rather than being swallowed.
    fireEvent.click(
      screen.getAllByTestId("notification-row")[0] as HTMLElement,
    );
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("does not fan a stack for horizontal-dominant wheel motion", () => {
    seedPriorityAndQuietSameProducer();
    render(<NotificationsHomeCenter />);
    fireEvent.wheel(screen.getByTestId("notification-row-swipe"), {
      deltaX: 80,
      deltaY: 20,
    });
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
  });

  it("keeps horizontal row swipe dismissal independent from stack fanning", () => {
    seedPriorityAndQuietSameProducer();
    render(<NotificationsHomeCenter />);
    const swipeSurface = screen.getByTestId("notification-row-swipe");
    fireEvent.pointerDown(swipeSurface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 9,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerMove(swipeSurface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 9,
      clientX: 140,
      clientY: 32,
    });
    fireEvent.pointerUp(swipeSurface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 9,
      clientX: 140,
      clientY: 32,
    });
    act(() => vi.advanceTimersByTime(200));

    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(screen.queryByTestId("notification-stack-controls")).toBeNull();
  });

  it("folds an individual producer without changing whole-inbox mode", () => {
    seedPriorityAndQuietSameProducer();
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-stack-peek"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("notification-stack-collapse"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-inbox-mode"),
    ).toBe("priority");
  });
});

describe("NotificationsHomeCenter row behavior", () => {
  it("keeps liquid-glass cards, capped stack depth, and no destructive X controls", () => {
    for (let index = 0; index < 5; index += 1) {
      __ingestNotificationForTests(notification());
    }
    render(<NotificationsHomeCenter />);

    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByTestId("notification-row-swipe").className).toContain(
      "eliza-notif-glass",
    );
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
    expect(screen.queryByTestId("notification-stack-clear")).toBeNull();
  });

  it("opens and removes a flat notification through its safe deep link", () => {
    __ingestNotificationForTests(
      notification({ title: "Open Settings", deepLink: "/settings" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));

    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("caps a fanned producer at 100 rendered rows", () => {
    for (let index = 0; index < 120; index += 1) {
      __ingestNotificationForTests(
        notification({ priority: index === 0 ? "urgent" : "normal" }),
      );
    }
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(100);
  });
});
