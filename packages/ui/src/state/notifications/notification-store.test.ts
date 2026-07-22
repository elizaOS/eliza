// @vitest-environment jsdom
/**
 * The notification store (`notification-store`): list/read/remove/clear flows,
 * unread counting, WebSocket-event ingestion, and the native-first delivery
 * policy (OS surface on desktop/mobile, glass banner as the web fallback).
 * jsdom with the API client and bridges mocked — deterministic, no real server.
 */
import type { AgentNotification } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";

const listNotifications = vi.fn();
const markNotificationReadApi = vi.fn();
const markAllNotificationsReadApi = vi.fn();
const removeNotificationApi = vi.fn();
const clearNotificationsApi = vi.fn();
const seedDevNotificationsApi = vi.fn();
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
    seedDevNotifications: (...args: unknown[]) =>
      seedDevNotificationsApi(...args),
    onWsEvent: (...args: unknown[]) => onWsEvent(...args),
  },
}));

const invokeDesktopBridgeRequest = vi.fn();
vi.mock("../../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: (...args: unknown[]) =>
    invokeDesktopBridgeRequest(...args),
}));

const showNativeNotification = vi.fn();
const showWebNotification = vi.fn();
vi.mock("../../bridge/native-notifications", () => ({
  showNativeNotification: (...args: unknown[]) =>
    showNativeNotification(...args),
  showWebNotification: (...args: unknown[]) => showWebNotification(...args),
}));

const pushNotificationBanner = vi.fn();
vi.mock("./notification-banner-store", () => ({
  pushNotificationBanner: (...args: unknown[]) =>
    pushNotificationBanner(...args),
}));

import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
} from "../../hooks/useAuthStatus";
import {
  __getStateForTests,
  __ingestEphemeralNotificationForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  clearNotifications,
  initNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  removeNotification,
  removeNotifications,
  seedDevNotificationsIfEmpty,
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

/**
 * Delivery is fire-and-forget async (desktop → native → glass); settle its
 * promise chain before asserting which sink fired.
 */
async function flushDelivery(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
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
    seedDevNotificationsApi.mockReset().mockResolvedValue({
      count: 0,
      notifications: [],
    });
    onWsEvent.mockReset().mockReturnValue(() => {});
    // Defaults model the plain web platform: no desktop bridge (null), no
    // Capacitor channel ("none"), web Notification unavailable (false).
    invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
    showNativeNotification.mockReset().mockResolvedValue("none");
    showWebNotification.mockReset().mockReturnValue(false);
    pushNotificationBanner.mockReset();
    // Default: window focused.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps silent-tier notifications in the inbox without badge weight", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Silent", priority: "low" }),
    );
    const state = __getStateForTests();
    expect(state.notifications).toHaveLength(1);
    expect(state.unreadCount).toBe(0);
  });

  // ── Delivery policy: native-first, glass fallback ─────────────────────────

  it("desktop bridge owns the alert: no native, web, or banner double-fire", async () => {
    invokeDesktopBridgeRequest.mockResolvedValue({ id: "os-1" });
    __ingestNotificationForTests(makeNotification({ priority: "normal" }), 1);
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(showNativeNotification).not.toHaveBeenCalled();
    expect(showWebNotification).not.toHaveBeenCalled();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("desktop OS notification fires even while the window is focused", async () => {
    invokeDesktopBridgeRequest.mockResolvedValue({ id: "os-2" });
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent" }),
      1,
    );
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("Capacitor native channel owns the alert on mobile: no banner", async () => {
    showNativeNotification.mockResolvedValue("local");
    __ingestNotificationForTests(makeNotification({ priority: "high" }), 1);
    await flushDelivery();
    expect(showNativeNotification).toHaveBeenCalledTimes(1);
    expect(showWebNotification).not.toHaveBeenCalled();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("threads groupKey into the native request so the OS surface coalesces", async () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "high", groupKey: "files" }),
      1,
    );
    await flushDelivery();
    expect(showNativeNotification).toHaveBeenCalledTimes(1);
    expect(showNativeNotification.mock.calls[0][0]).toMatchObject({
      groupKey: "files",
    });
  });

  it("web focused: the glass banner is the surface (no web Notification)", async () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Deploy done", body: "Build #42" }),
      1,
    );
    await flushDelivery();
    expect(pushNotificationBanner).toHaveBeenCalledTimes(1);
    expect(pushNotificationBanner.mock.calls[0][0].title).toBe("Deploy done");
    expect(showWebNotification).not.toHaveBeenCalled();
  });

  it("web hidden tab: browser Notification replaces the unseen glass banner", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    showWebNotification.mockReturnValue(true);
    __ingestNotificationForTests(makeNotification({ priority: "urgent" }), 1);
    await flushDelivery();
    expect(showWebNotification).toHaveBeenCalledTimes(1);
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("web hidden tab without Notification permission still queues the banner", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    showWebNotification.mockReturnValue(false);
    __ingestNotificationForTests(makeNotification({ priority: "urgent" }), 1);
    await flushDelivery();
    expect(pushNotificationBanner).toHaveBeenCalledTimes(1);
    expect(pushNotificationBanner.mock.calls[0][0].priority).toBe("urgent");
  });

  it("a rejecting desktop bridge falls through to the glass fallback", async () => {
    invokeDesktopBridgeRequest.mockRejectedValue(new Error("bridge gone"));
    __ingestNotificationForTests(makeNotification({ priority: "high" }), 1);
    await flushDelivery();
    expect(pushNotificationBanner).toHaveBeenCalledTimes(1);
  });

  it("a rejecting native channel falls through to the glass fallback", async () => {
    showNativeNotification.mockRejectedValue(new Error("plugin broke"));
    __ingestNotificationForTests(makeNotification({ priority: "high" }), 1);
    await flushDelivery();
    expect(pushNotificationBanner).toHaveBeenCalledTimes(1);
  });

  it("silent tier is inbox-only: no desktop, native, web, or banner", async () => {
    __ingestNotificationForTests(makeNotification({ priority: "low" }), 1);
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(showNativeNotification).not.toHaveBeenCalled();
    expect(showWebNotification).not.toHaveBeenCalled();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("silent tier stays inbox-only even while unfocused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    __ingestNotificationForTests(makeNotification({ priority: "low" }));
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(showNativeNotification).not.toHaveBeenCalled();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("normal priority reaches the native surface regardless of focus", async () => {
    // The old policy suppressed the OS sink for a focused normal-priority
    // arrival; native platforms now always alert natively (the OS owns
    // loudness via the urgency mapping).
    invokeDesktopBridgeRequest.mockResolvedValue({ id: "os-3" });
    __ingestNotificationForTests(makeNotification({ priority: "normal" }), 1);
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(invokeDesktopBridgeRequest.mock.calls[0][0]).toMatchObject({
      rpcMethod: "desktopShowNotification",
      params: expect.objectContaining({ urgency: "normal", silent: false }),
    });
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("initNotifications hydrates and subscribes to the WS stream once", async () => {
    listNotifications.mockResolvedValue({
      notifications: [makeNotification({ title: "Stored" })],
      unreadCount: 1,
    });
    initNotifications();
    initNotifications(); // idempotent
    expect(onWsEvent).toHaveBeenCalledTimes(2);
    expect(onWsEvent.mock.calls[0][0]).toBe("agent_event");
    expect(onWsEvent.mock.calls[1][0]).toBe("ws-reconnected");
    expect(listNotifications).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("honors Retry-After, preserves live WS rows, and merges recovered history once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const live = makeNotification({ id: "live", title: "From WS" });
    const persisted = makeNotification({
      id: "persisted",
      title: "Persisted history",
      createdAt: live.createdAt - 1,
    });
    listNotifications
      .mockRejectedValueOnce(
        new ApiError({
          kind: "http",
          path: "/api/notifications",
          status: 503,
          code: "NOTIFICATION_SERVICE_NOT_READY",
          retryAfter: 2,
          message: "Notification service is still starting",
        }),
      )
      .mockResolvedValueOnce({
        notifications: [live, persisted],
        unreadCount: 2,
        serviceStatus: "ready",
      });

    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      data: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: { notification: live, unreadCount: 1 },
    });
    await flushDelivery();

    expect(listNotifications).toHaveBeenCalledTimes(1);
    expect(__getStateForTests()).toMatchObject({
      notifications: [live],
      hydrationStatus: "retrying",
      hydrationAttempts: 1,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(listNotifications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushDelivery();

    const recovered = __getStateForTests();
    expect(recovered.hydrationStatus).toBe("ready");
    expect(recovered.hydrationError).toBeNull();
    expect(
      recovered.notifications.map((notification) => notification.id),
    ).toEqual(["live", "persisted"]);
    expect(recovered.unreadCount).toBe(2);
    expect(listNotifications).toHaveBeenCalledTimes(2);
    expect(onWsEvent).toHaveBeenCalledTimes(2);
    expect(pushNotificationBanner).toHaveBeenCalledTimes(1);
  });

  it("stops after the bounded hydrate retry budget and exposes terminal failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    listNotifications.mockRejectedValue(new Error("transport unavailable"));

    initNotifications();
    await flushDelivery();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await vi.runOnlyPendingTimersAsync();
      await flushDelivery();
    }

    expect(listNotifications).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(onWsEvent).toHaveBeenCalledTimes(2);
    expect(__getStateForTests()).toMatchObject({
      hydrated: false,
      hydrationStatus: "failed",
      hydrationAttempts: 5,
      hydrationError: "transport unavailable",
    });

    listNotifications.mockResolvedValueOnce({
      notifications: [makeNotification({ id: "after-reconnect" })],
      unreadCount: 1,
      serviceStatus: "ready",
    });
    const reconnectHandler = onWsEvent.mock.calls.find(
      ([event]) => event === "ws-reconnected",
    )?.[1] as () => void;
    reconnectHandler();
    await flushDelivery();
    expect(listNotifications).toHaveBeenCalledTimes(6);
    expect(__getStateForTests()).toMatchObject({
      hydrated: true,
      hydrationStatus: "ready",
      hydrationAttempts: 1,
      hydrationError: null,
    });
  });

  it("WS handler ignores non-notification streams", async () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({ stream: "assistant", payload: { text: "hi" } });
    await flushDelivery();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("WS handler ingests a notification-stream event", async () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: {
        type: "notification",
        notification: makeNotification({ title: "From WS" }),
        unreadCount: 1,
      },
    });
    await flushDelivery();
    expect(pushNotificationBanner).toHaveBeenCalledTimes(1);
    expect(pushNotificationBanner.mock.calls[0][0].title).toBe("From WS");
  });

  it("WS handler drops a payload missing id or title (validated, not cast)", async () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
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
    await flushDelivery();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
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

  it("WS handler applies notification_update without re-delivering sinks", async () => {
    initNotifications();
    // Settle the boot hydrate (mocked empty) first — flushing after the ingest
    // would let it land late and wipe the row under assertion.
    await flushDelivery();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: {
        type: "notification_update",
        notification: makeNotification({
          id: "update-1",
          title: "Approval needed",
          priority: "high",
          readAt: 123,
        }),
        unreadCount: 0,
      },
    });
    await flushDelivery();
    const stored = __getStateForTests().notifications.find(
      (n) => n.id === "update-1",
    );
    expect(stored?.readAt).toBe(123);
    expect(__getStateForTests().unreadCount).toBe(0);
    expect(pushNotificationBanner).not.toHaveBeenCalled();
    expect(showNativeNotification).not.toHaveBeenCalled();
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(showWebNotification).not.toHaveBeenCalled();
  });

  it("WS handler applies notification_update without reordering existing rows", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    __ingestNotificationForTests(makeNotification({ id: "old", title: "Old" }));
    __ingestNotificationForTests(makeNotification({ id: "new", title: "New" }));
    expect(__getStateForTests().notifications.map((n) => n.id)).toEqual([
      "new",
      "old",
    ]);

    handler({
      stream: "notification",
      payload: {
        type: "notification_update",
        notification: makeNotification({
          id: "old",
          title: "Old",
          readAt: 123,
        }),
      },
    });
    expect(__getStateForTests().notifications.map((n) => n.id)).toEqual([
      "new",
      "old",
    ]);
    expect(
      __getStateForTests().notifications.find((n) => n.id === "old")?.readAt,
    ).toBe(123);
  });

  it("WS handler carries data.count through for the coalesced count chip (§C.3)", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: {
        notification: {
          id: "count-1",
          title: "3 new files",
          groupKey: "files",
          data: { count: 3 },
        },
      },
    });
    const stored = __getStateForTests().notifications.find(
      (n) => n.id === "count-1",
    );
    expect(stored?.data?.count).toBe(3);
  });

  it("WS handler drops a non-object data field rather than passing garbage", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: {
        notification: { id: "bad-data", title: "x", data: "nope" },
      },
    });
    const stored = __getStateForTests().notifications.find(
      (n) => n.id === "bad-data",
    );
    expect(stored).toBeTruthy();
    expect(stored?.data).toBeUndefined();
  });

  it("WS handler collapses same-groupKey, surviving the newer count (§C.3)", () => {
    initNotifications();
    const handler = onWsEvent.mock.calls[0][1] as (
      d: Record<string, unknown>,
    ) => void;
    handler({
      stream: "notification",
      payload: {
        notification: { id: "c1", title: "1 file", groupKey: "g" },
      },
    });
    handler({
      stream: "notification",
      payload: {
        notification: {
          id: "c2",
          title: "2 files",
          groupKey: "g",
          data: { count: 2 },
        },
      },
    });
    const list = __getStateForTests().notifications.filter(
      (n) => n.groupKey === "g",
    );
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c2");
    expect(list[0].data?.count).toBe(2);
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

  it("removes a producer batch with one optimistic state update", async () => {
    __ingestNotificationForTests(makeNotification({ id: "b1" }));
    __ingestNotificationForTests(makeNotification({ id: "b2" }));
    __ingestNotificationForTests(makeNotification({ id: "keep" }));
    await removeNotifications(["b1", "b2"]);
    expect(__getStateForTests().notifications.map((n) => n.id)).toEqual([
      "keep",
    ]);
    expect(removeNotificationApi).toHaveBeenCalledWith("b1");
    expect(removeNotificationApi).toHaveBeenCalledWith("b2");
  });

  it("keeps browser-QA notification mutations local", async () => {
    __ingestEphemeralNotificationForTests(
      makeNotification({ id: "ephemeral" }),
    );
    await removeNotification("ephemeral");
    await flushDelivery();
    expect(__getStateForTests().notifications).toHaveLength(0);
    expect(removeNotificationApi).not.toHaveBeenCalled();
    expect(pushNotificationBanner).not.toHaveBeenCalled();
  });

  it("reverts the optimistic read when the write rejects (no silent divergence)", async () => {
    markNotificationReadApi.mockRejectedValueOnce(new Error("500"));
    __ingestNotificationForTests(makeNotification({ id: "r1" }), 1);
    await markNotificationRead("r1");
    // Write failed → item must return to unread, not stay optimistically read.
    const stored = __getStateForTests().notifications.find(
      (n) => n.id === "r1",
    );
    expect(stored?.readAt).toBeFalsy();
    expect(__getStateForTests().unreadCount).toBe(1);
  });

  it("restores a removed notification when the delete rejects", async () => {
    removeNotificationApi.mockRejectedValueOnce(new Error("network"));
    __ingestNotificationForTests(makeNotification({ id: "r2" }), 1);
    await removeNotification("r2");
    // Failed delete must NOT leave the item visibly gone-but-still-on-server.
    expect(__getStateForTests().notifications.some((n) => n.id === "r2")).toBe(
      true,
    );
    expect(__getStateForTests().unreadCount).toBe(1);
  });

  it("restores an entire producer batch when one delete rejects", async () => {
    removeNotificationApi
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("network"));
    __ingestNotificationForTests(makeNotification({ id: "batch-1" }), 1);
    __ingestNotificationForTests(makeNotification({ id: "batch-2" }), 2);
    await removeNotifications(["batch-1", "batch-2"]);
    expect(__getStateForTests().notifications).toHaveLength(2);
    expect(__getStateForTests().unreadCount).toBe(2);
  });

  it("restores the inbox when clear rejects", async () => {
    clearNotificationsApi.mockRejectedValueOnce(new Error("boom"));
    __ingestNotificationForTests(makeNotification({ id: "c1" }), 1);
    __ingestNotificationForTests(makeNotification({ id: "c2" }), 2);
    await clearNotifications();
    expect(__getStateForTests().notifications).toHaveLength(2);
    expect(__getStateForTests().unreadCount).toBe(2);
  });

  it("reverts markAll when the write rejects", async () => {
    markAllNotificationsReadApi.mockRejectedValueOnce(new Error("down"));
    __ingestNotificationForTests(makeNotification({ id: "a1" }), 1);
    __ingestNotificationForTests(makeNotification({ id: "a2" }), 2);
    await markAllNotificationsRead();
    expect(__getStateForTests().unreadCount).toBe(2);
    expect(__getStateForTests().notifications.every((n) => !n.readAt)).toBe(
      true,
    );
  });

  describe("seedDevNotificationsIfEmpty (dev default-active)", () => {
    it("seeds the demo spread when the inbox hydrates empty", async () => {
      const seeded = [
        makeNotification({ id: "s1", priority: "urgent" }),
        makeNotification({ id: "s2", priority: "normal", readAt: Date.now() }),
      ];
      seedDevNotificationsApi.mockResolvedValueOnce({
        count: 2,
        notifications: seeded,
      });
      await seedDevNotificationsIfEmpty();
      expect(seedDevNotificationsApi).toHaveBeenCalledTimes(1);
      expect(__getStateForTests().notifications).toHaveLength(2);
      // Unread count is derived from the seeded rows (one is pre-read).
      expect(__getStateForTests().unreadCount).toBe(1);
    });

    it("never seeds over a real inbox", async () => {
      listNotifications.mockResolvedValueOnce({
        notifications: [makeNotification({ id: "real" })],
        unreadCount: 1,
      });
      await seedDevNotificationsIfEmpty();
      expect(seedDevNotificationsApi).not.toHaveBeenCalled();
      expect(__getStateForTests().notifications).toHaveLength(1);
      expect(__getStateForTests().notifications[0]?.id).toBe("real");
    });

    it("runs at most once per session", async () => {
      await seedDevNotificationsIfEmpty();
      await seedDevNotificationsIfEmpty();
      expect(seedDevNotificationsApi).toHaveBeenCalledTimes(1);
    });

    it("stays data-driven when the seed route 404s (no throw)", async () => {
      seedDevNotificationsApi.mockRejectedValueOnce(new Error("404"));
      await expect(seedDevNotificationsIfEmpty()).resolves.toBeUndefined();
      expect(__getStateForTests().notifications).toHaveLength(0);
    });
  });
});

describe("notification-store — protected hydrate gate (#16242)", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

  function setOrigin(url: string): void {
    const u = new URL(url);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: u.href,
        origin: u.origin,
        protocol: u.protocol,
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        assign: () => {},
        replace: () => {},
        reload: () => {},
        toString: () => u.href,
      },
    });
  }

  beforeEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
    listNotifications
      .mockReset()
      .mockResolvedValue({ notifications: [], unreadCount: 0 });
    onWsEvent.mockReset().mockReturnValue(() => {});
    invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
    if (originalLocation) {
      Object.defineProperty(window, "location", originalLocation);
    }
  });

  it("holds GET /api/notifications on the unauthenticated Cloud origin, then hydrates after sign-in", async () => {
    setOrigin("https://app.elizacloud.ai/");
    initNotifications();
    // WS subscriptions still wire up; only the protected hydrate is held.
    await Promise.resolve();
    expect(listNotifications).not.toHaveBeenCalled();
    expect(onWsEvent).toHaveBeenCalled();

    __setAuthStatusForTests({
      phase: "authenticated",
      identity: { id: "u-1", displayName: "Owner", kind: "owner" },
      session: { id: "s-1", kind: "browser", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
        role: "OWNER",
      },
    });
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));
  });

  it("hydrates on mount on a non-Cloud origin regardless of auth (unchanged)", async () => {
    setOrigin("http://localhost:2138/");
    initNotifications();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));
  });
});
