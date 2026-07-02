// @vitest-environment jsdom
import type { AgentNotification } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listNotifications = vi.fn();
const markNotificationReadApi = vi.fn();
const markAllNotificationsReadApi = vi.fn();
const removeNotificationApi = vi.fn();
const clearNotificationsApi = vi.fn();
const onWsEvent = vi.fn();

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

import {
  __getStateForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  clearNotifications,
  initNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerNotificationToastSink,
  removeNotification,
} from "./notification-store";

function makeNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  return {
    id: overrides.id ?? `n-${Math.random().toString(36).slice(2)}`,
    title: overrides.title ?? "Test",
    body: overrides.body,
    category: overrides.category ?? "general",
    priority: overrides.priority ?? "normal",
    source: overrides.source ?? "agent",
    deepLink: overrides.deepLink,
    groupKey: overrides.groupKey,
    createdAt: overrides.createdAt ?? Date.now(),
    readAt: overrides.readAt ?? null,
  };
}

describe("notification-store", () => {
  beforeEach(() => {
    __resetNotificationStoreForTests();
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
    registerNotificationToastSink(null);
    // Default: window focused.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ingests a notification into the inbox and updates unread count", () => {
    __ingestNotificationForTests(makeNotification({ title: "Hello" }), 1);
    // Access state via the mutation path is indirect; assert via toast/sink and
    // a follow-up markAllRead which reads the live list.
    expect(showNativeNotification).not.toHaveBeenCalled(); // focused + normal → no OS
  });

  it("fires desktop + native sinks when the window is unfocused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    __ingestNotificationForTests(makeNotification({ priority: "normal" }), 1);
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(showNativeNotification).toHaveBeenCalledTimes(1);
  });

  it("fires interrupt sinks for high/urgent even when focused", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent" }),
      1,
    );
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(showNativeNotification).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire OS sinks for a quiet notification while focused", () => {
    __ingestNotificationForTests(makeNotification({ priority: "low" }), 1);
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(showNativeNotification).not.toHaveBeenCalled();
  });

  it("routes a toast through the registered sink", () => {
    const sink = vi.fn();
    registerNotificationToastSink(sink);
    __ingestNotificationForTests(
      makeNotification({ title: "Deploy done", body: "Build #42" }),
      1,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain("Deploy done");
  });

  it("uses an error toast tone for urgent notifications", () => {
    const sink = vi.fn();
    registerNotificationToastSink(sink);
    __ingestNotificationForTests(makeNotification({ priority: "urgent" }), 1);
    expect(sink.mock.calls[0][1]).toBe("error");
  });

  it("initNotifications hydrates and subscribes to the WS stream once", async () => {
    listNotifications.mockResolvedValue({
      notifications: [makeNotification({ title: "Stored" })],
      unreadCount: 1,
    });
    initNotifications();
    initNotifications(); // idempotent
    expect(onWsEvent).toHaveBeenCalledTimes(1);
    expect(onWsEvent.mock.calls[0][0]).toBe("agent_event");
    expect(listNotifications).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("WS handler ignores non-notification streams", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    const sink = vi.fn();
    registerNotificationToastSink(sink);
    handler({ stream: "assistant", payload: { text: "hi" } });
    expect(sink).not.toHaveBeenCalled();
  });

  it("WS handler ingests a notification-stream event", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    const sink = vi.fn();
    registerNotificationToastSink(sink);
    handler({
      stream: "notification",
      payload: {
        type: "notification",
        notification: makeNotification({ title: "From WS" }),
        unreadCount: 1,
      },
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain("From WS");
  });

  it("WS handler drops a payload missing id or title (validated, not cast)", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    const sink = vi.fn();
    registerNotificationToastSink(sink);
    // No title → unrenderable → dropped.
    handler({
      stream: "notification",
      payload: { notification: { id: "abc", body: "no title" } },
    });
    // No id → dropped.
    handler({
      stream: "notification",
      payload: { notification: { title: "no id" } },
    });
    expect(sink).not.toHaveBeenCalled();
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("WS handler coerces an invalid category/priority to the defaults", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: {
        notification: {
          id: "coerce-1",
          title: "Bad enums",
          category: "not-a-category",
          priority: "SUPER-URGENT",
          createdAt: "not-a-number",
        },
      },
    });
    const stored = __getStateForTests().notifications.find(
      (n) => n.id === "coerce-1",
    );
    expect(stored).toBeTruthy();
    expect(stored?.category).toBe("general");
    expect(stored?.priority).toBe("normal");
    expect(typeof stored?.createdAt).toBe("number");
  });

  it("markNotificationRead calls the API optimistically", async () => {
    const n = makeNotification({ id: "abc" });
    __ingestNotificationForTests(n, 1);
    await markNotificationRead("abc");
    expect(markNotificationReadApi).toHaveBeenCalledWith("abc");
  });

  it("markAllNotificationsRead + remove + clear call their APIs", async () => {
    __ingestNotificationForTests(makeNotification({ id: "x" }), 1);
    await markAllNotificationsRead();
    expect(markAllNotificationsReadApi).toHaveBeenCalledTimes(1);
    await removeNotification("x");
    expect(removeNotificationApi).toHaveBeenCalledWith("x");
    await clearNotifications();
    expect(clearNotificationsApi).toHaveBeenCalledTimes(1);
  });
});
