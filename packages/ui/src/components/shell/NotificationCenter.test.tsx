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

const appState = {
  setActionNotice: vi.fn(),
};

const listNotifications = vi.fn();
const markNotificationReadApi = vi.fn();
const markAllNotificationsReadApi = vi.fn();
const removeNotificationApi = vi.fn();
const clearNotificationsApi = vi.fn();
const onWsEvent = vi.fn();

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (state: typeof appState) => T): T =>
    selector(appState),
}));

vi.mock("../../api/client", () => ({
  client: {
    listNotifications: (...args: unknown[]) => listNotifications(...args),
    markNotificationRead: (...args: unknown[]) =>
      markNotificationReadApi(...args),
    markAllNotificationsRead: (...args: unknown[]) =>
      markAllNotificationsReadApi(...args),
    removeNotification: (...args: unknown[]) => removeNotificationApi(...args),
    clearNotifications: (...args: unknown[]) => clearNotificationsApi(...args),
    onWsEvent: (...args: unknown[]) => onWsEvent(...args),
  },
}));

const invokeDesktopBridgeRequest = vi.fn();
vi.mock("../../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: (...args: unknown[]) =>
    invokeDesktopBridgeRequest(...args),
}));

const showNativeNotification = vi.fn();
vi.mock("../../bridge/native-notifications", () => ({
  showNativeNotification: (...args: unknown[]) =>
    showNativeNotification(...args),
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

describe("NotificationCenter", () => {
  beforeEach(() => {
    __resetNotificationStoreForTests();
    appState.setActionNotice.mockReset();
    listNotifications.mockReset().mockResolvedValue({
      notifications: [],
      unreadCount: 0,
    });
    markNotificationReadApi.mockReset().mockResolvedValue({ ok: true });
    markAllNotificationsReadApi.mockReset().mockResolvedValue({ changed: 0 });
    removeNotificationApi.mockReset().mockResolvedValue({ ok: true });
    clearNotificationsApi.mockReset().mockResolvedValue({ ok: true });
    onWsEvent.mockReset();
    invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
    showNativeNotification.mockReset().mockResolvedValue("none");
  });

  afterEach(() => {
    cleanup();
    __resetNotificationStoreForTests();
    vi.restoreAllMocks();
  });

  it("filters notification rows by category without losing the all view", async () => {
    const notifications = [
      notification("reminder-1", "Take medication", "reminder"),
      notification("message-1", "Discord reply waiting", "message"),
      notification("system-1", "Update installed", "system"),
    ];
    listNotifications.mockResolvedValue({
      notifications,
      unreadCount: notifications.length,
    });
    for (const item of notifications) {
      __ingestNotificationForTests(item, notifications.length);
    }

    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await screen.findByText("Take medication");
    expect(screen.queryByText("Discord reply waiting")).not.toBeNull();
    expect(screen.queryByText("Update installed")).not.toBeNull();

    await user.click(screen.getByRole("tab", { name: /reminders\s*1/i }));
    expect(screen.queryByText("Take medication")).not.toBeNull();
    expect(screen.queryByText("Discord reply waiting")).toBeNull();
    expect(screen.queryByText("Update installed")).toBeNull();

    await user.click(screen.getByRole("tab", { name: /all\s*3/i }));
    expect(screen.queryByText("Take medication")).not.toBeNull();
    expect(screen.queryByText("Discord reply waiting")).not.toBeNull();
    expect(screen.queryByText("Update installed")).not.toBeNull();
  });

  it("resets an active category filter when that category disappears", async () => {
    const notifications = [
      notification("reminder-1", "Take medication", "reminder"),
      notification("system-1", "Update installed", "system"),
    ];
    listNotifications.mockResolvedValue({
      notifications,
      unreadCount: notifications.length,
    });
    for (const item of notifications) {
      __ingestNotificationForTests(item, notifications.length);
    }

    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await user.click(screen.getByRole("tab", { name: /reminders\s*1/i }));
    expect(screen.queryByText("Update installed")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: /all\s*1/i })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(screen.queryByText("Update installed")).not.toBeNull();
  });
});
