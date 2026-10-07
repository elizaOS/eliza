// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  clear: vi.fn(async () => ({})),
  readAll: vi.fn(async () => ({})),
  events: new Map<string, (event: never) => void>(),
  auth: {
    phase: "authenticated",
    identity: { id: "owner" },
    session: { id: "session" },
    access: { mode: "session" },
  },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("../../api/client", () => ({
  client: {
    listNotifications: fixture.list,
    getBaseUrl: () => "http://127.0.0.1",
    onBaseUrlChange: () => () => {},
    clearNotifications: fixture.clear,
    markAllNotificationsRead: fixture.readAll,
    markNotificationRead: async () => ({}),
    removeNotification: async () => ({}),
    rotateConnection: vi.fn(),
    onWsEvent: (name: string, callback: (event: never) => void) => {
      fixture.events.set(name, callback);
      return () => {};
    },
  },
}));
vi.mock("../../hooks/useAuthStatus", () => ({
  getAuthStatusSnapshot: () => fixture.auth,
  subscribeAuthStatus: () => () => {},
}));
vi.mock("../../bridge/notification-delivery", () => ({
  deliverSystemNotification: vi.fn(async () => "none"),
}));
vi.mock("./push-registration", () => ({
  hasAndroidPushDelivery: async () => false,
  captureNativeNotificationOwner: () => null,
}));

import {
  __getStateForTests,
  __resetNotificationStoreForTests,
  clearNotifications,
  initNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  removeNotification,
  retryNotificationHydration,
} from "./notification-store";

const id = (n: number) =>
  `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const row = (n: number, readAt: number | null = null) => ({
  id: id(n),
  title: `Row ${n}`,
  category: "reminder",
  priority: "normal",
  source: "qa",
  createdAt: n,
  readAt,
});
function event(n: number, removed = false) {
  fixture.events.get("agent_event")?.({
    stream: "notification",
    payload: {
      type: "notification_update",
      notification: row(n, 99),
      removed,
      unreadCount: 0,
    },
  } as never);
}
afterEach(() => {
  __resetNotificationStoreForTests();
  fixture.events.clear();
  fixture.list.mockReset();
  fixture.clear.mockReset().mockResolvedValue({});
  fixture.readAll.mockReset().mockResolvedValue({});
});
it("healthy resume refreshes authoritative rows and does not resurrect deleted cache or old read state", async () => {
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1), row(2)],
    unreadCount: 2,
  });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1, 99)],
    unreadCount: 0,
  });
  await retryNotificationHydration();
  expect(__getStateForTests().notifications).toEqual([row(1, 99)]);
  expect(fixture.list).toHaveBeenLastCalledWith({ limit: 300 });
});
it("single-item authoritative deletion removes a row without OS delivery", async () => {
  fixture.list.mockResolvedValue({ notifications: [row(1)], unreadCount: 1 });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
  event(1, true);
  expect(__getStateForTests().notifications).toHaveLength(0);
});
it("newer live read/delete events during hydration override its earlier response", async () => {
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1), row(2)],
    unreadCount: 2,
  });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
  let finish!: (value: unknown) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = retryNotificationHydration();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  event(1);
  event(2, true);
  finish({ notifications: [row(1), row(2)], unreadCount: 2 });
  await refresh;
  expect(__getStateForTests().notifications).toEqual([row(1, 99)]);
});

it("coalesces healthy resume/reconnect refresh and preserves a concurrent optimistic clear", async () => {
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1), row(2)],
    unreadCount: 2,
  });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
  let finish!: (value: unknown) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const one = retryNotificationHydration();
  const two = retryNotificationHydration();
  expect(one).toBe(two);
  await clearNotifications();
  finish({ notifications: [row(1), row(2)], unreadCount: 2 });
  await one;
  expect(__getStateForTests().notifications).toEqual([]);
  expect(__getStateForTests().unreadCount).toBe(0);
  expect(fixture.list).toHaveBeenCalledTimes(2);
});

it("preserves the authoritative global unread count beyond the latest-300 rendered rows", async () => {
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1)],
    unreadCount: 1000,
  });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
  let finish!: (value: unknown) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = retryNotificationHydration();
  fixture.events.get("agent_event")?.({
    stream: "notification",
    payload: { type: "notification", notification: row(2), unreadCount: 1001 },
  } as never);
  finish({ notifications: [row(1)], unreadCount: 1000 });
  await refresh;
  expect(__getStateForTests().unreadCount).toBe(1001);
});
it("a failed concurrent clear rolls back original rows before an older hydration response settles", async () => {
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1)],
    unreadCount: 1000,
  });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
  let finish!: (value: unknown) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = retryNotificationHydration();
  fixture.clear.mockRejectedValueOnce(new Error("Storage unavailable"));
  await clearNotifications();
  expect(__getStateForTests().unreadCount).toBe(1000);
  finish({ notifications: [row(1), row(2)], unreadCount: 1001 });
  await refresh;
  expect(__getStateForTests().notifications).toEqual([row(2), row(1)]);
  expect(__getStateForTests().unreadCount).toBe(1001);
});

it.each(["read", "remove"])(
  "a concurrent local %s preserves the global unread count beyond the rendered page",
  async (op) => {
    fixture.list.mockResolvedValueOnce({
      notifications: [row(1)],
      unreadCount: 1000,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().hydrationStatus).toBe("ready"),
    );
    let finish!: (value: unknown) => void;
    fixture.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = retryNotificationHydration();
    if (op === "read") await markNotificationRead(id(1));
    else await removeNotification(id(1));
    expect(__getStateForTests().unreadCount).toBe(999);
    finish({ notifications: [row(1)], unreadCount: 1000 });
    await refresh;
    expect(__getStateForTests().unreadCount).toBe(999);
  },
);

async function readyGlobalInbox() {
  fixture.list.mockResolvedValueOnce({
    notifications: [row(1)],
    unreadCount: 1000,
  });
  initNotifications();
  await vi.waitFor(() =>
    expect(__getStateForTests().hydrationStatus).toBe("ready"),
  );
}
it("a newer empty successful clear fences an older failed clear rollback", async () => {
  await readyGlobalInbox();
  let reject!: (error: Error) => void;
  fixture.clear.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const first = clearNotifications();
  await clearNotifications();
  reject(new Error("First clear failed"));
  await first;
  expect(__getStateForTests().notifications).toEqual([]);
  expect(__getStateForTests().unreadCount).toBe(0);
});
it.each(["clear", "readAll"])(
  "failed %s keeps newer authoritative live global count",
  async (op) => {
    await readyGlobalInbox();
    let reject!: (error: Error) => void;
    const write = op === "clear" ? fixture.clear : fixture.readAll;
    write.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending =
      op === "clear" ? clearNotifications() : markAllNotificationsRead();
    fixture.events.get("agent_event")?.({
      stream: "notification",
      payload: {
        type: "notification",
        notification: row(2),
        unreadCount: 1001,
      },
    } as never);
    reject(new Error("Bulk write failed"));
    await pending;
    expect(__getStateForTests().notifications).toEqual([row(2), row(1)]);
    expect(__getStateForTests().unreadCount).toBe(1001);
  },
);
it("all-read during stale hydration applies to the global inbox and unseen snapshot rows", async () => {
  await readyGlobalInbox();
  let finish!: (value: unknown) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = retryNotificationHydration();
  await markAllNotificationsRead();
  finish({ notifications: [row(1), row(2)], unreadCount: 1000 });
  await refresh;
  expect(__getStateForTests().unreadCount).toBe(0);
  expect(
    __getStateForTests().notifications.every((n) => Boolean(n.readAt)),
  ).toBe(true);
});
it("failed all-read removes its hydration fence and restores global total", async () => {
  await readyGlobalInbox();
  let finish!: (value: unknown) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = retryNotificationHydration();
  fixture.readAll.mockRejectedValueOnce(new Error("Read failed"));
  await markAllNotificationsRead();
  expect(__getStateForTests().unreadCount).toBe(1000);
  finish({ notifications: [row(1), row(2)], unreadCount: 1001 });
  await refresh;
  expect(__getStateForTests().unreadCount).toBe(1001);
});
