// @vitest-environment jsdom

// Dashboard notification center behavior against the real notification store
// (driven via the test-only ingest; HTTP mutations mocked at the API client).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutations are optimistic writes through the API client - mock the transport,
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
      readAt: 1_600_000_500_000, // read - must NOT sink below unread lows
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

  it("marks all read from the header, and has no clear-all trash button", () => {
    __ingestNotificationForTests(makeNotification());
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    // The bulk delete/trash affordance is gone: rows are dismissed one at a
    // time (hover X / swipe / row menu), never nuked wholesale from the header.
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
    fireEvent.click(screen.getByTestId("notifications-mark-all-read"));
    expect(__getStateForTests().unreadCount).toBe(0);
    // With nothing unread, mark-all disappears.
    expect(screen.queryByTestId("notifications-mark-all-read")).toBeNull();
  });

  it("opens a contextual menu on right-click with dismiss + mark-read actions", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Menu me", deepLink: "/x" }),
    );
    render(<NotificationsHomeCenter />);
    const li = screen.getByText("Menu me").closest("li") as HTMLElement;
    fireEvent.contextMenu(li);
    expect(screen.getByTestId("notification-row-menu")).toBeTruthy();
    // Unread + safe deep link → open, mark-read, and dismiss are all present.
    expect(screen.getByTestId("notification-menu-open")).toBeTruthy();
    expect(screen.getByTestId("notification-menu-mark-read")).toBeTruthy();
    fireEvent.click(screen.getByTestId("notification-menu-dismiss"));
    expect(screen.queryByText("Menu me")).toBeNull();
  });

  it("no longer has a border/background chrome box on the inbox card", () => {
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    const card = screen.getByTestId("home-notification-center");
    // Item 1: the inbox floats on the shade's surface — no card fill / border.
    expect(card.className).not.toMatch(/border|bg-black|backdrop-blur/);
  });

  it("keeps a tapped (now read) row in place - order ignores read state", () => {
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

  it("renders a normal row with no priority rail (lock-screen restraint)", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", title: "Quiet one" }),
    );
    render(<NotificationsHomeCenter />);
    // A normal notification is just its line + time - no leading accent rail,
    // no per-row icon chip (the box-in-a-box slop is gone).
    expect(screen.queryByTestId("notification-row-accent")).toBeNull();
    expect(screen.queryByTestId("notification-row-icon")).toBeNull();
  });

  it("shows a priority rail only for urgent/high rows", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "high", title: "High" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "low", title: "Low" }),
    );
    render(<NotificationsHomeCenter />);
    // Two elevated rows carry the rail; the low row does not.
    expect(screen.getAllByTestId("notification-row-accent")).toHaveLength(2);
  });

  it("carries no glass/blur/border chrome — the shade owns the surface", () => {
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    const card = screen.getByTestId("home-notification-center");
    // Item 1: the inbox is bare — no fill, no border, no blur of its own.
    expect(card.className).not.toContain("backdrop-blur");
    expect(card.className).not.toContain("border");
    expect(card.className).not.toMatch(/bg-black|bg-white/);
  });

  it("renders a count chip when data.count > 1 (§C.3 coalescing)", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "3 new files", data: { count: 3 } }),
    );
    render(<NotificationsHomeCenter />);
    const chip = screen.getByTestId("notification-count-chip");
    // The visible glyph is the count; a visually-hidden suffix names it for AT.
    expect(chip.textContent).toContain("3");
    expect(chip.querySelector(".sr-only")?.textContent).toContain("grouped");
  });

  it("omits the count chip for a single (count ≤ 1 or absent) notification", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "one", data: { count: 1 } }),
    );
    __ingestNotificationForTests(makeNotification({ title: "plain" }));
    render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("notification-count-chip")).toBeNull();
  });
});
