// @vitest-environment jsdom
import type { AgentNotification } from "@elizaos/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import { NotificationCenter } from "./NotificationCenter";

const mocks = vi.hoisted(() => ({
  appState: {
    setActionNotice: vi.fn(),
  },
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  removeNotification: vi.fn(),
  clearNotifications: vi.fn(),
  onWsEvent: vi.fn(),
  invokeDesktopBridgeRequest: vi.fn(),
  showNativeNotification: vi.fn(),
  navigateDeepLink: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (state: typeof mocks.appState) => T): T =>
    selector(mocks.appState),
}));

vi.mock("../../api/client", () => ({
  client: {
    listNotifications: (...args: unknown[]) => mocks.listNotifications(...args),
    markNotificationRead: (...args: unknown[]) =>
      mocks.markNotificationRead(...args),
    markAllNotificationsRead: (...args: unknown[]) =>
      mocks.markAllNotificationsRead(...args),
    removeNotification: (...args: unknown[]) =>
      mocks.removeNotification(...args),
    clearNotifications: (...args: unknown[]) =>
      mocks.clearNotifications(...args),
    onWsEvent: (...args: unknown[]) => mocks.onWsEvent(...args),
  },
}));

vi.mock("../../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: (...args: unknown[]) =>
    mocks.invokeDesktopBridgeRequest(...args),
}));

vi.mock("../../bridge/native-notifications", () => ({
  showNativeNotification: (...args: unknown[]) =>
    mocks.showNativeNotification(...args),
}));

vi.mock("../../state/notifications/navigate-deep-link", () => ({
  navigateDeepLink: (...args: unknown[]) => mocks.navigateDeepLink(...args),
}));

function notification(
  id: string,
  title: string,
  category: AgentNotification["category"],
): AgentNotification {
  return {
    id: id as AgentNotification["id"],
    title,
    category,
    priority: "normal",
    source: "test",
    createdAt: Date.UTC(2026, 0, 1),
    readAt: null,
  };
}

function seedNotifications(notifications: AgentNotification[]): void {
  mocks.listNotifications.mockResolvedValue({
    notifications,
    unreadCount: notifications.length,
  });
  for (const item of notifications) {
    __ingestNotificationForTests(item, notifications.length);
  }
}

describe("NotificationCenter", () => {
  beforeEach(() => {
    __resetNotificationStoreForTests();
    mocks.appState.setActionNotice.mockReset();
    mocks.listNotifications.mockReset().mockResolvedValue({
      notifications: [],
      unreadCount: 0,
    });
    mocks.markNotificationRead.mockReset().mockResolvedValue({ ok: true });
    mocks.markAllNotificationsRead
      .mockReset()
      .mockResolvedValue({ changed: 0 });
    mocks.removeNotification.mockReset().mockResolvedValue({ ok: true });
    mocks.clearNotifications.mockReset().mockResolvedValue({ ok: true });
    mocks.onWsEvent.mockReset();
    mocks.invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
    mocks.showNativeNotification.mockReset().mockResolvedValue("none");
    mocks.navigateDeepLink.mockReset();
  });

  afterEach(() => {
    cleanup();
    __resetNotificationStoreForTests();
  });

  it("filters notification rows by category without losing the all view", async () => {
    seedNotifications([
      notification("reminder-1", "Take medication", "reminder"),
      notification("message-1", "Discord reply waiting", "message"),
      notification("system-1", "Update installed", "system"),
    ]);

    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await screen.findByText("Take medication");
    expect(screen.queryByText("Discord reply waiting")).not.toBeNull();
    expect(screen.queryByText("Update installed")).not.toBeNull();

    await user.click(screen.getByRole("tab", { name: "Reminders" }));
    expect(screen.queryByText("Take medication")).not.toBeNull();
    expect(screen.queryByText("Discord reply waiting")).toBeNull();
    expect(screen.queryByText("Update installed")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "All" }));
    expect(screen.queryByText("Take medication")).not.toBeNull();
    expect(screen.queryByText("Discord reply waiting")).not.toBeNull();
    expect(screen.queryByText("Update installed")).not.toBeNull();
  });

  it("falls back to all notifications when an active category disappears", async () => {
    seedNotifications([
      notification("reminder-1", "Take medication", "reminder"),
      notification("system-1", "Update installed", "system"),
    ]);

    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await user.click(screen.getByRole("tab", { name: "Reminders" }));
    expect(screen.queryByText("Update installed")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Take medication")).toBeNull();
      expect(screen.queryByText("Update installed")).not.toBeNull();
    });
    expect(
      screen.queryByRole("tablist", {
        name: "Filter notifications by category",
      }),
    ).toBeNull();
  });

  // Mutation coverage (#10719): the panel's write actions — mark-all-read,
  // clear-all, row-open (mark-read + deep-link nav), and per-row dismiss — were
  // wired but unasserted; only category filtering was tested. Each mutation
  // flows through the real notification store into the mocked `client`, so a
  // fired `mocks.client.*` proves the real store path ran.
  describe("mutations", () => {
    async function openPanel() {
      const user = userEvent.setup();
      render(<NotificationCenter />);
      await user.click(screen.getByRole("button", { name: /notifications/i }));
      await screen.findByRole("button", { name: "Mark all read" });
      return user;
    }

    it("mark-all-read fires the store write (idempotent under a double-click)", async () => {
      seedNotifications([
        notification("reminder-1", "Take medication", "reminder"),
        notification("message-1", "Discord reply waiting", "message"),
      ]);
      const user = await openPanel();

      const markAll = screen.getByRole("button", { name: "Mark all read" });
      await user.click(markAll);
      // The button unmounts once there's nothing unread (hasUnread gate), so the
      // second click is a no-op — assert EXACTLY one write, so a regression that
      // dropped that gate and double-wrote would fail (not just >= 1).
      if (screen.queryByRole("button", { name: "Mark all read" })) {
        await user.click(markAll); // QA: mashing it must not corrupt state
      }
      expect(mocks.markAllNotificationsRead).toHaveBeenCalledTimes(1);
      // Never routes a mark-all through the single-row endpoint.
      expect(mocks.markNotificationRead).not.toHaveBeenCalled();
    });

    it("clear-all fires the store write and empties the list", async () => {
      seedNotifications([
        notification("reminder-1", "Take medication", "reminder"),
        notification("system-1", "Update installed", "system"),
      ]);
      const user = await openPanel();

      await user.click(screen.getByRole("button", { name: "Clear all" }));
      expect(mocks.clearNotifications).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.queryByText("Take medication")).toBeNull();
        expect(screen.queryByText("Update installed")).toBeNull();
      });
    });

    it("opening an UNREAD row marks it read and navigates its deep link", async () => {
      const withLink: AgentNotification = {
        ...notification("reminder-1", "Take medication", "reminder"),
        deepLink: "/apps/health",
      };
      seedNotifications([withLink]);
      const user = await openPanel();

      await user.click(screen.getByText("Take medication"));
      expect(mocks.markNotificationRead).toHaveBeenCalledWith("reminder-1");
      expect(mocks.navigateDeepLink).toHaveBeenCalledWith("/apps/health");
    });

    it("opening an ALREADY-READ row navigates but does NOT re-mark it read", async () => {
      const readWithLink: AgentNotification = {
        ...notification("reminder-1", "Take medication", "reminder"),
        readAt: Date.UTC(2026, 0, 2),
        deepLink: "/apps/health",
      };
      seedNotifications([readWithLink]);
      const user = await openPanel();

      await user.click(screen.getByText("Take medication"));
      expect(mocks.markNotificationRead).not.toHaveBeenCalled();
      expect(mocks.navigateDeepLink).toHaveBeenCalledWith("/apps/health");
    });

    it("per-row dismiss removes only that row and does not open its deep link", async () => {
      const withLink: AgentNotification = {
        ...notification("reminder-1", "Take medication", "reminder"),
        deepLink: "/apps/health",
      };
      seedNotifications([
        withLink,
        notification("system-1", "Update installed", "system"),
      ]);
      const user = await openPanel();

      await user.click(
        screen.getAllByRole("button", { name: "Dismiss notification" })[0],
      );
      // Dismiss must stopPropagation — it removes, it does NOT navigate.
      expect(mocks.removeNotification).toHaveBeenCalledWith("reminder-1");
      expect(mocks.navigateDeepLink).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByText("Take medication")).toBeNull();
        expect(screen.queryByText("Update installed")).not.toBeNull();
      });
    });

    it("caps the unread badge at 99+ for large inboxes", async () => {
      const many = Array.from({ length: 150 }, (_, i) =>
        notification(`n-${i}`, `Item ${i}`, "system"),
      );
      seedNotifications(many);
      render(<NotificationCenter />);
      // The bell's aria-label reports the true unread count…
      await screen.findByRole("button", { name: /150 unread/i });
      // …while the on-badge text is capped so it never overflows the pill.
      expect(screen.getByText("99+")).not.toBeNull();
    });
  });
});
