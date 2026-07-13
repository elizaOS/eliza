// @vitest-environment jsdom

/** Render-count lock for the leaf-owned relative-time ticker. */
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

vi.mock("../../state/notifications/navigate-deep-link", async (original) => ({
  ...(await original()),
  navigateDeepLink: vi.fn(),
}));

import type { AgentNotification } from "@elizaos/core";
import { __resetSharedNowForTests, MINUTE_MS } from "../../hooks/useSharedNow";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import {
  __setNotificationRowRenderObserverForTests,
  __setNotificationsHomeCenterRenderObserverForTests,
  NotificationsHomeCenter,
  rowPropsEqual,
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
    source: `test-${sequence}`,
    createdAt: Date.now() - sequence * 5 * MINUTE_MS,
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  sequence = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
});

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
  __resetSharedNowForTests();
  __setNotificationRowRenderObserverForTests(null);
  __setNotificationsHomeCenterRenderObserverForTests(null);
  vi.useRealTimers();
});

describe("NotificationsHomeCenter render count", () => {
  it("updates RelativeTime leaves without rebuilding the inbox or rows", () => {
    for (let index = 0; index < 8; index += 1) {
      __ingestNotificationForTests(notification());
    }
    let centerRenders = 0;
    let rowRenders = 0;
    __setNotificationsHomeCenterRenderObserverForTests(() => {
      centerRenders += 1;
    });
    __setNotificationRowRenderObserverForTests(() => {
      rowRenders += 1;
    });
    render(<NotificationsHomeCenter />);
    const before = screen
      .getAllByTestId("notification-row-time")
      .map((element) => element.textContent);
    centerRenders = 0;
    rowRenders = 0;

    act(() => vi.advanceTimersByTime(MINUTE_MS));

    const after = screen
      .getAllByTestId("notification-row-time")
      .map((element) => element.textContent);
    expect(after).not.toEqual(before);
    expect(centerRenders).toBe(0);
    expect(rowRenders).toBe(0);
  });

  it("changes priority/all mode only from the explicit toggle", () => {
    __ingestNotificationForTests(
      notification({ title: "Priority", priority: "urgent", source: "github" }),
    );
    __ingestNotificationForTests(
      notification({ title: "Quiet", priority: "normal", source: "calendar" }),
    );
    let centerRenders = 0;
    __setNotificationsHomeCenterRenderObserverForTests(() => {
      centerRenders += 1;
    });
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    centerRenders = 0;

    fireEvent.wheel(list, { deltaY: -500 });
    expect(centerRenders).toBe(0);
    expect(list.getAttribute("data-inbox-mode")).toBe("priority");

    fireEvent.click(screen.getByTestId("notifications-mode-toggle"));
    expect(centerRenders).toBe(1);
    expect(list.getAttribute("data-inbox-mode")).toBe("all");
  });

  it("fans a producer without remounting its priority top row", () => {
    __ingestNotificationForTests(
      notification({ title: "Quiet", priority: "normal", source: "github" }),
    );
    __ingestNotificationForTests(
      notification({ title: "Priority", priority: "urgent", source: "github" }),
    );
    render(<NotificationsHomeCenter />);
    const priorityRow = screen.getByTestId("notification-row");
    fireEvent.click(priorityRow);

    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.getAllByTestId("notification-row")[0]).toBe(priorityRow);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-inbox-mode"),
    ).toBe("priority");
  });

  it("rowPropsEqual ignores timestamp-only changes but tracks rendered identity", () => {
    const base = notification({ title: "Title", body: "Body", deepLink: "/x" });
    const onOpen = () => {};
    const onDismiss = () => {};
    const props = { notification: base, onOpen, onDismiss };

    expect(
      rowPropsEqual(props, {
        ...props,
        notification: { ...base, createdAt: base.createdAt + MINUTE_MS },
      }),
    ).toBe(true);
    expect(
      rowPropsEqual(props, {
        ...props,
        notification: { ...base, title: "Changed" },
      }),
    ).toBe(false);
    expect(rowPropsEqual(props, { ...props, onOpen: () => {} })).toBe(false);
  });
});
