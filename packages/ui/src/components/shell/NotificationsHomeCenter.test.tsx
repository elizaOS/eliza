// @vitest-environment jsdom

// Dashboard notification center behavior against the real notification store
// (driven via the test-only ingest; HTTP mutations mocked at the API client).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutations are optimistic writes through the API client — mock the transport,
// not the store, so mark-read/dismiss/clear exercise the real store paths.
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
vi.mock("../../state/notifications/navigate-deep-link", async (orig) => ({
  ...(await orig()),
  navigateDeepLink,
}));

import type { AgentNotification } from "@elizaos/core";
import {
  __getStateForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import {
  NotificationsHomeCenter,
  orderDashboardNotifications,
} from "./NotificationsHomeCenter";

let seq = 0;
function makeNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  seq += 1;
  const hex = String(seq).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${hex}` as AgentNotification["id"],
    title: `Notification ${seq}`,
    category: "general",
    priority: "normal",
    source: "test",
    createdAt: 1_700_000_000_000 + seq * 1000,
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
});

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
  navigateDeepLink.mockClear();
});

describe("orderDashboardNotifications", () => {
  it("orders by priority bucket then recency, ignoring read state", () => {
    const low = makeNotification({ priority: "low" });
    const urgentOld = makeNotification({
      priority: "urgent",
      createdAt: 1_600_000_000_000,
      readAt: 1_600_000_500_000, // read — must NOT sink below unread lows
    });
    const normalNew = makeNotification({ priority: "normal" });
    const ordered = orderDashboardNotifications([low, urgentOld, normalNew]);
    expect(ordered.map((n) => n.id)).toEqual([
      urgentOld.id,
      normalNew.id,
      low.id,
    ]);
  });

  it("is a stable total order (id tiebreak) so equal rows never reshuffle", () => {
    const a = makeNotification({ createdAt: 5 });
    const b = makeNotification({ createdAt: 5 });
    const once = orderDashboardNotifications([a, b]).map((n) => n.id);
    const twice = orderDashboardNotifications([b, a]).map((n) => n.id);
    expect(once).toEqual(twice);
  });
});

describe("NotificationsHomeCenter", () => {
  it("renders nothing while the inbox is empty", () => {
    const { container } = render(<NotificationsHomeCenter />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the inbox rows with unread badge once notifications arrive", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Reminder fired", category: "reminder" }),
    );
    __ingestNotificationForTests(
      makeNotification({
        title: "Deploy approved",
        readAt: Date.now(),
      }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    // One unread → badge shows 1.
    expect(screen.getByTestId("notifications-unread-badge").textContent).toBe(
      "1",
    );
    expect(screen.getByText("Reminder fired")).toBeTruthy();
  });

  it("styles urgent rows with the danger tone and unread dot", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Disk almost full" }),
    );
    render(<NotificationsHomeCenter />);
    const row = screen.getByTestId("notification-row");
    expect(row.getAttribute("data-unread")).toBe("true");
    expect(screen.getByTestId("notification-unread-dot")).toBeTruthy();
  });

  it("marks a row read on tap and follows a safe deep link", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Open settings" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(__getStateForTests().unreadCount).toBe(0);
  });

  it("never navigates an unsafe deep link (tap still marks read)", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "javascript:alert(1)" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).not.toHaveBeenCalled();
    expect(__getStateForTests().unreadCount).toBe(0);
  });

  it("dismisses a single row via its X", () => {
    __ingestNotificationForTests(makeNotification({ title: "Keep me" }));
    __ingestNotificationForTests(makeNotification({ title: "Dismiss me" }));
    render(<NotificationsHomeCenter />);
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(2);
    const target = screen.getByText("Dismiss me").closest("li") as HTMLElement;
    fireEvent.click(
      target.querySelector(
        '[data-testid="notification-row-dismiss"]',
      ) as HTMLElement,
    );
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.queryByText("Dismiss me")).toBeNull();
  });

  it("marks all read and clears all from the header actions", () => {
    __ingestNotificationForTests(makeNotification());
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notifications-mark-all-read"));
    expect(__getStateForTests().unreadCount).toBe(0);
    // With nothing unread, mark-all disappears; clear-all empties + hides.
    expect(screen.queryByTestId("notifications-mark-all-read")).toBeNull();
    fireEvent.click(screen.getByTestId("notifications-clear-all"));
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("keeps a tapped (now read) row in place — order ignores read state", () => {
    const urgent = makeNotification({ priority: "urgent", title: "First" });
    __ingestNotificationForTests(makeNotification({ title: "Second" }));
    __ingestNotificationForTests(urgent);
    render(<NotificationsHomeCenter />);
    const titles = () =>
      screen
        .getAllByTestId("notification-row")
        .map((el) => el.textContent ?? "");
    expect(titles()[0]).toContain("First");
    fireEvent.click(screen.getAllByTestId("notification-row")[0]);
    // Still first after being marked read.
    expect(titles()[0]).toContain("First");
  });

  it("caps rendering at 100 rows", () => {
    for (let i = 0; i < 120; i++) {
      __ingestNotificationForTests(makeNotification());
    }
    render(<NotificationsHomeCenter />);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(100);
  });
});
