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
});
