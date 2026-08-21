/** Verifies notification-store through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * The notification store (`notification-store`): list/read/remove/clear flows,
 * unread counting, WebSocket-event ingestion, and the native-first delivery
 * policy. The persistent Home inbox remains the sole in-app surface. jsdom
 * with the API client and bridges mocked — deterministic, no real server.
 */
import type { AgentNotification } from "@elizaos/core";
import {
  clearStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import {
  STEWARD_SESSION_CHANGE_EVENT,
  type StewardSessionChangeDetail,
} from "../../events/steward-session-event";

let stewardSessionEpoch = 0;
function publishStewardSession(state: "present" | "cleared"): void {
  stewardSessionEpoch += 1;
  window.dispatchEvent(
    new CustomEvent<StewardSessionChangeDetail>(STEWARD_SESSION_CHANGE_EVENT, {
      detail: { state, sessionEpoch: stewardSessionEpoch },
    }),
  );
}

const listNotifications = vi.fn();
const markNotificationReadApi = vi.fn();
const markAllNotificationsReadApi = vi.fn();
const removeNotificationApi = vi.fn();
const clearNotificationsApi = vi.fn();
const seedDevNotificationsApi = vi.fn();
const onWsEvent = vi.fn();
const getBaseUrl = vi.fn((..._args: unknown[]) => "http://mock.local");
const onBaseUrlChange = vi.fn((..._args: unknown[]) => () => {});
const hasToken = vi.fn((..._args: unknown[]) => true);
const rotateConnection = vi.fn((..._args: unknown[]) => {});

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
    getBaseUrl: (...args: unknown[]) => getBaseUrl(...args),
    onBaseUrlChange: (...args: unknown[]) => onBaseUrlChange(...args),
    hasToken: (...args: unknown[]) => hasToken(...args),
    rotateConnection: (...args: unknown[]) => rotateConnection(...args),
  },
}));

const invokeDesktopBridgeRequest = vi.fn();
vi.mock("../../bridge/electrobun-rpc", () => ({
  getElectrobunRendererRpc: vi.fn(() => null),
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

import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
  type AuthStatusState,
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
  retryNotificationHydration,
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

function notificationServiceStartingError(retryAfter: number): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/notifications",
    status: 503,
    code: "NOTIFICATION_SERVICE_NOT_READY",
    retryAfter,
    message: "Notification service is still starting",
  });
}

/**
 * Delivery is fire-and-forget async (desktop → native → browser); settle its
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

  // ── Delivery policy: native-first, persistent inbox fallback ──────────────

  it("desktop bridge owns the alert without a second native or web delivery", async () => {
    invokeDesktopBridgeRequest.mockResolvedValue({ id: "os-1" });
    __ingestNotificationForTests(makeNotification({ priority: "normal" }), 1);
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
    expect(showNativeNotification).not.toHaveBeenCalled();
    expect(showWebNotification).not.toHaveBeenCalled();
  });

  it("desktop OS notification fires even while the window is focused", async () => {
    invokeDesktopBridgeRequest.mockResolvedValue({ id: "os-2" });
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent" }),
      1,
    );
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledTimes(1);
  });

  it("Capacitor native channel owns the alert on mobile", async () => {
    showNativeNotification.mockResolvedValue("local");
    __ingestNotificationForTests(makeNotification({ priority: "high" }), 1);
    await flushDelivery();
    expect(showNativeNotification).toHaveBeenCalledTimes(1);
    expect(showWebNotification).not.toHaveBeenCalled();
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

  it("focused web keeps the arrival in the Home inbox without a duplicate interrupt", async () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Deploy done", body: "Build #42" }),
      1,
    );
    await flushDelivery();
    expect(showWebNotification).not.toHaveBeenCalled();
    expect(__getStateForTests().notifications[0]?.title).toBe("Deploy done");
  });

  it("web hidden tab raises a browser Notification when available", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    showWebNotification.mockReturnValue(true);
    __ingestNotificationForTests(makeNotification({ priority: "urgent" }), 1);
    await flushDelivery();
    expect(showWebNotification).toHaveBeenCalledTimes(1);
  });

  it("web hidden tab without Notification permission retains the persistent inbox row", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    showWebNotification.mockReturnValue(false);
    __ingestNotificationForTests(makeNotification({ priority: "urgent" }), 1);
    await flushDelivery();
    expect(showWebNotification).toHaveBeenCalledTimes(1);
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("a rejecting desktop bridge still retains the persistent inbox row", async () => {
    invokeDesktopBridgeRequest.mockRejectedValue(new Error("bridge gone"));
    __ingestNotificationForTests(makeNotification({ priority: "high" }), 1);
    await flushDelivery();
    expect(showNativeNotification).toHaveBeenCalledTimes(1);
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("a rejecting native channel still retains the persistent inbox row", async () => {
    showNativeNotification.mockRejectedValue(new Error("plugin broke"));
    __ingestNotificationForTests(makeNotification({ priority: "high" }), 1);
    await flushDelivery();
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("silent tier is inbox-only: no desktop, native, or web interrupt", async () => {
    __ingestNotificationForTests(makeNotification({ priority: "low" }), 1);
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(showNativeNotification).not.toHaveBeenCalled();
    expect(showWebNotification).not.toHaveBeenCalled();
  });

  it("silent tier stays inbox-only even while unfocused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    __ingestNotificationForTests(makeNotification({ priority: "low" }));
    await flushDelivery();
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(showNativeNotification).not.toHaveBeenCalled();
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
      .mockRejectedValueOnce(notificationServiceStartingError(2))
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
  });

  it("keeps explicit service startup transient beyond the general attempt cap", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    listNotifications.mockRejectedValue(notificationServiceStartingError(1));

    initNotifications();
    await flushDelivery();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await vi.runOnlyPendingTimersAsync();
      await flushDelivery();
    }

    expect(listNotifications).toHaveBeenCalledTimes(5);
    expect(__getStateForTests()).toMatchObject({
      hydrated: false,
      hydrationStatus: "retrying",
      hydrationAttempts: 5,
    });
    expect(vi.getTimerCount()).toBe(1);

    listNotifications.mockResolvedValueOnce({
      notifications: [makeNotification({ id: "after-cold-start" })],
      unreadCount: 1,
      serviceStatus: "ready",
    });
    await vi.runOnlyPendingTimersAsync();
    await flushDelivery();

    expect(listNotifications).toHaveBeenCalledTimes(6);
    expect(__getStateForTests()).toMatchObject({
      hydrated: true,
      hydrationStatus: "ready",
      hydrationAttempts: 6,
      hydrationError: null,
    });
  });

  it("fails visibly when the service startup readiness window expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    listNotifications.mockRejectedValue(notificationServiceStartingError(30));

    initNotifications();
    await flushDelivery();
    for (let interval = 0; interval < 3; interval += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushDelivery();
    }

    expect(listNotifications).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(__getStateForTests()).toMatchObject({
      hydrated: false,
      hydrationStatus: "failed",
      hydrationAttempts: 4,
      hydrationError: "Notification service is still starting",
    });
  });

  it("manual Retry resets expired service-startup recovery and hydrates", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    listNotifications.mockRejectedValue(notificationServiceStartingError(30));

    initNotifications();
    await flushDelivery();
    for (let interval = 0; interval < 3; interval += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushDelivery();
    }
    expect(__getStateForTests().hydrationStatus).toBe("failed");

    listNotifications.mockResolvedValueOnce({
      notifications: [makeNotification({ id: "after-manual-retry" })],
      unreadCount: 1,
      serviceStatus: "ready",
    });
    await retryNotificationHydration();
    await flushDelivery();

    expect(listNotifications).toHaveBeenCalledTimes(5);
    expect(__getStateForTests()).toMatchObject({
      hydrated: true,
      hydrationStatus: "ready",
      hydrationAttempts: 1,
      hydrationError: null,
    });
    expect(
      __getStateForTests().notifications.map((notification) => notification.id),
    ).toEqual(["after-manual-retry"]);
  });

  it("fails non-retryable authorization errors immediately", async () => {
    vi.useFakeTimers();
    listNotifications.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/notifications",
        status: 401,
        code: "UNAUTHORIZED",
        message: "Authentication required",
      }),
    );

    initNotifications();
    await flushDelivery();

    expect(listNotifications).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(__getStateForTests()).toMatchObject({
      hydrated: false,
      hydrationStatus: "failed",
      hydrationAttempts: 1,
      hydrationError: "Authentication required",
    });
  });

  it("keeps non-readiness 503 failures on the general attempt cap", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    listNotifications.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/notifications",
        status: 503,
        code: "NOTIFICATION_SERVICE_FAILED",
        retryAfter: 1,
        message: "Notification inbox is temporarily unavailable",
      }),
    );

    initNotifications();
    await flushDelivery();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await vi.runOnlyPendingTimersAsync();
      await flushDelivery();
    }

    expect(listNotifications).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(__getStateForTests()).toMatchObject({
      hydrated: false,
      hydrationStatus: "failed",
      hydrationAttempts: 5,
      hydrationError: "Notification inbox is temporarily unavailable",
    });
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
    expect(__getStateForTests().notifications).toHaveLength(0);
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
    expect(__getStateForTests().notifications[0]?.title).toBe("From WS");
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

  it("restores only the failed member of a partially successful producer batch", async () => {
    removeNotificationApi
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("network"));
    __ingestNotificationForTests(makeNotification({ id: "batch-1" }), 1);
    __ingestNotificationForTests(makeNotification({ id: "batch-2" }), 2);
    await removeNotifications(["batch-1", "batch-2"]);
    expect(__getStateForTests().notifications.map((n) => n.id)).toEqual([
      "batch-2",
    ]);
    expect(__getStateForTests().unreadCount).toBe(1);
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
    getBaseUrl.mockReset().mockReturnValue("");
    onBaseUrlChange.mockReset().mockReturnValue(() => {});
    invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
    if (originalLocation) {
      Object.defineProperty(window, "location", originalLocation);
    }
  });

  it("holds the inbox on a bare Cloud authority after sign-in, then hydrates exactly once when a Dedicated agent is selected", async () => {
    setOrigin("https://app.elizacloud.ai/");
    initNotifications();
    // WS subscriptions still wire up; only the protected hydrate is held.
    await Promise.resolve();
    expect(listNotifications).not.toHaveBeenCalled();
    expect(onWsEvent).toHaveBeenCalled();
    expect(__getStateForTests().hydrationStatus).toBe("disabled");

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
    await Promise.resolve();
    expect(listNotifications).not.toHaveBeenCalled();
    expect(__getStateForTests().hydrationStatus).toBe("disabled");

    const baseUrlHandler = onBaseUrlChange.mock.calls[0][0] as () => void;
    getBaseUrl.mockReturnValue(
      "https://api.eliza.app/api/v1/eliza/agents/11111111-1111-4111-8111-111111111111",
    );
    baseUrlHandler();
    await Promise.resolve();
    expect(listNotifications).not.toHaveBeenCalled();
    expect(__getStateForTests().hydrationStatus).toBe("disabled");

    getBaseUrl.mockReturnValue(
      "https://11111111-1111-4111-8111-111111111111.cloud.eliza.app",
    );
    baseUrlHandler();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));
    expect(__getStateForTests().hydrationStatus).toBe("ready");
  });

  it("keeps an authenticated managed Shared agent capability-disabled", async () => {
    setOrigin("https://cloud-staging.eliza.app/");
    getBaseUrl.mockReturnValue(
      "https://api-staging.eliza.app/api/v1/eliza/agents/11111111-1111-4111-8111-111111111111",
    );
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

    initNotifications();
    await Promise.resolve();

    expect(listNotifications).not.toHaveBeenCalled();
    expect(onWsEvent).toHaveBeenCalled();
    expect(__getStateForTests()).toMatchObject({
      notifications: [],
      unreadCount: 0,
      hydrated: false,
      hydrationStatus: "disabled",
      hydrationError: null,
    });
  });

  it("hydrates on mount on a non-Cloud origin regardless of auth (unchanged)", async () => {
    setOrigin("http://localhost:2138/");
    initNotifications();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));
  });
});

describe("notification-store — authority isolation (#18391)", () => {
  function authenticated(userId: string, sessionId: string): AuthStatusState {
    return {
      phase: "authenticated",
      identity: { id: userId, displayName: userId, kind: "owner" },
      session: { id: sessionId, kind: "browser", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
        role: "OWNER",
      },
    };
  }

  function agentEventHandlers(): Array<
    (data: Record<string, unknown>) => void
  > {
    return onWsEvent.mock.calls
      .filter((call) => call[0] === "agent_event")
      .map((call) => call[1] as (data: Record<string, unknown>) => void);
  }

  beforeEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
    listNotifications
      .mockReset()
      .mockResolvedValue({ notifications: [], unreadCount: 0 });
    onWsEvent.mockReset().mockReturnValue(() => {});
    getBaseUrl.mockReset().mockReturnValue("http://agent-a.local");
    onBaseUrlChange.mockReset().mockReturnValue(() => {});
    hasToken.mockReset().mockReturnValue(true);
    rotateConnection.mockReset();
    invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
  });

  it("Agent A -> Agent B: clears A's rows synchronously and hydrates fresh B rows", async () => {
    const notifA = makeNotification({ id: "from-a", title: "From A" });
    const notifB = makeNotification({ id: "from-b", title: "From B" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifA],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );
    expect(__getStateForTests().notifications[0]?.id).toBe("from-a");

    const baseUrlHandler = onBaseUrlChange.mock.calls[0][0] as () => void;
    getBaseUrl.mockReturnValue("http://agent-b.local");
    listNotifications.mockResolvedValueOnce({
      notifications: [notifB],
      unreadCount: 1,
    });
    baseUrlHandler();

    // Synchronous clear happens before the fresh fetch resolves.
    expect(__getStateForTests().notifications).toHaveLength(0);

    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );
    expect(__getStateForTests().notifications[0]?.id).toBe("from-b");
  });

  it("User A -> logout -> User B: isolates rows across the switch", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    const notifA = makeNotification({ id: "a-row", title: "A's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifA],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );

    listNotifications.mockResolvedValueOnce({
      notifications: [],
      unreadCount: 0,
    });
    __setAuthStatusForTests({ phase: "unauthenticated" });
    // Synchronous clear on logout, before the anon-authority refetch resolves.
    expect(__getStateForTests().notifications).toHaveLength(0);

    const notifB = makeNotification({ id: "b-row", title: "B's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifB],
      unreadCount: 1,
    });
    __setAuthStatusForTests(authenticated("user-b", "session-b"));
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );
    expect(__getStateForTests().notifications[0]?.id).toBe("b-row");
  });

  it("discards a stale in-flight hydration completion from the prior authority", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    type HydrationResponse = {
      notifications: AgentNotification[];
      unreadCount: number;
    };
    let resolveA!: (value: HydrationResponse) => void;
    listNotifications.mockReturnValueOnce(
      new Promise<HydrationResponse>((resolve) => {
        resolveA = resolve;
      }),
    );
    initNotifications();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));

    const notifB = makeNotification({ id: "b-row", title: "B's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifB],
      unreadCount: 1,
    });
    __setAuthStatusForTests(authenticated("user-b", "session-b"));
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );
    expect(__getStateForTests().notifications[0]?.id).toBe("b-row");

    // The stale A response resolves after B has already hydrated.
    const notifA = makeNotification({ id: "a-row", title: "A's row" });
    resolveA({ notifications: [notifA], unreadCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(__getStateForTests().notifications[0]?.id).toBe("b-row");
  });

  // A defense-in-depth guard, not the primary protection: real dispatch
  // always calls whichever handler is currently bound, so this only
  // matters if something holds and invokes an orphaned handler reference
  // directly (client-base.ts never does, for "agent_event" today). The real
  // protection against a message delivered through the CURRENT handler
  // after an auth-only switch is the connection rotation covered by the
  // "rotates the connection" tests below (#18542, review finding 2).
  it("an orphaned handler reference self-drops after rebind, even if invoked directly", async () => {
    initNotifications();
    await vi.waitFor(() => expect(agentEventHandlers()).toHaveLength(1));
    const handlerA = agentEventHandlers()[0];

    getBaseUrl.mockReturnValue("http://agent-b.local");
    const baseUrlHandler = onBaseUrlChange.mock.calls[0][0] as () => void;
    baseUrlHandler();
    await vi.waitFor(() => expect(agentEventHandlers()).toHaveLength(2));
    const handlerB = agentEventHandlers()[1];

    handlerA({
      stream: "notification",
      payload: {
        notification: makeNotification({ id: "stale", title: "Stale" }),
        unreadCount: 9,
      },
    });
    expect(__getStateForTests().notifications).toHaveLength(0);

    handlerB({
      stream: "notification",
      payload: {
        notification: makeNotification({ id: "fresh", title: "Fresh" }),
        unreadCount: 1,
      },
    });
    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(__getStateForTests().notifications[0]?.id).toBe("fresh");
  });

  it("a same-authority auth refresh does not clear or refetch", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    const notifA = makeNotification({ id: "a-row", title: "A's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifA],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );

    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    await Promise.resolve();
    expect(listNotifications).toHaveBeenCalledTimes(1);
    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(__getStateForTests().notifications[0]?.id).toBe("a-row");
  });

  // #18542 review finding 2: neither setBaseUrl nor repointBaseUrl runs for
  // an auth-only switch, so nothing else closes the socket that could still
  // deliver a message from the outgoing authority through the freshly-bound
  // (and therefore current-looking) handler. rotateConnection() closes it.
  it("rotates the connection on a subsequent auth-only switch (same base)", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    initNotifications();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));
    expect(rotateConnection).not.toHaveBeenCalled();

    __setAuthStatusForTests(authenticated("user-b", "session-b"));
    expect(rotateConnection).toHaveBeenCalledTimes(1);
  });

  it("does not rotate the connection on the first resolution from boot", async () => {
    // No auth status set before init: the store seeds from the boot-time
    // "anon" snapshot, which never hydrated anything worth protecting.
    initNotifications();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));

    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    expect(rotateConnection).not.toHaveBeenCalled();
  });

  it("rotates the connection on logout even though the base is unchanged", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    initNotifications();
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(1));

    publishStewardSession("cleared");
    expect(rotateConnection).toHaveBeenCalledTimes(1);
  });

  // #18542 review finding 3: useAuthStatus intentionally keeps the previous
  // authenticated snapshot until the async /api/auth/me probe resolves, so a
  // real logout would otherwise be invisible to reconcileAuthority (which
  // only reacts to that eventual publish) for the whole round-trip.
  // steward-token-sync fires synchronously on the token clear itself.
  describe("credential-sync invalidation ahead of the async auth probe", () => {
    it("clears account A immediately when a present token is replaced before the auth probe resolves", async () => {
      __setAuthStatusForTests(authenticated("user-a", "session-a"));
      const notifA = makeNotification({ id: "a-row", title: "A's row" });
      listNotifications.mockResolvedValueOnce({
        notifications: [notifA],
        unreadCount: 1,
      });
      initNotifications();
      await vi.waitFor(() =>
        expect(__getStateForTests().notifications).toHaveLength(1),
      );
      rotateConnection.mockClear();

      // The canonical token writer knows that the credential changed before
      // /api/auth/me can publish B's non-secret identity.
      await writeStoredStewardToken("account-b-token");

      expect(__getStateForTests().notifications).toHaveLength(0);
      expect(rotateConnection).toHaveBeenCalledTimes(1);
    });

    it("clears immediately on a cleared token, before the auth-status probe catches up", async () => {
      __setAuthStatusForTests(authenticated("user-a", "session-a"));
      const notifA = makeNotification({ id: "a-row", title: "A's row" });
      listNotifications.mockResolvedValueOnce({
        notifications: [notifA],
        unreadCount: 1,
      });
      initNotifications();
      await vi.waitFor(() =>
        expect(__getStateForTests().notifications).toHaveLength(1),
      );

      // The token is cleared, but the auth-status snapshot has NOT been
      // updated yet — this is exactly the gap useAuthStatus leaves open.
      // Invalidation deliberately does not fetch (identity is unknown), so
      // no response needs to be queued for it.
      publishStewardSession("cleared");

      // Synchronous: no await before this assertion.
      expect(__getStateForTests().notifications).toHaveLength(0);
      expect(__getStateForTests().hydrationStatus).toBe("idle");
      // Identity is unknown at this point, so no fetch is started yet.
      expect(listNotifications).toHaveBeenCalledTimes(1);

      // The probe eventually resolves — the real reconcile runs normally.
      const notifB = makeNotification({ id: "b-row", title: "B's row" });
      listNotifications.mockResolvedValueOnce({
        notifications: [notifB],
        unreadCount: 1,
      });
      __setAuthStatusForTests({ phase: "unauthenticated" });
      await vi.waitFor(() =>
        expect(__getStateForTests().notifications).toHaveLength(1),
      );
      expect(__getStateForTests().notifications[0]?.id).toBe("b-row");
    });

    it("clears immediately when a canonical rejected-token path removes the Steward credential", async () => {
      __setAuthStatusForTests(authenticated("user-a", "session-a"));
      await writeStoredStewardToken("rejected-steward-token");
      const notifA = makeNotification({ id: "a-row", title: "A's row" });
      listNotifications.mockResolvedValueOnce({
        notifications: [notifA],
        unreadCount: 1,
      });
      initNotifications();
      await vi.waitFor(() =>
        expect(__getStateForTests().notifications).toHaveLength(1),
      );
      rotateConnection.mockClear();

      // client-cloud's dedicated-agent 401 path calls this canonical clear
      // while the unrelated Eliza API bearer remains present.
      expect(hasToken()).toBe(true);
      clearStoredStewardToken();

      expect(__getStateForTests().notifications).toHaveLength(0);
      expect(__getStateForTests().hydrationStatus).toBe("idle");
      expect(rotateConnection).toHaveBeenCalledTimes(1);
    });

    it("drops a stale WS event delivered during the credential-invalidated window", async () => {
      __setAuthStatusForTests(authenticated("user-a", "session-a"));
      initNotifications();
      await vi.waitFor(() => expect(agentEventHandlers()).toHaveLength(1));
      const handlerA = agentEventHandlers()[0];

      publishStewardSession("cleared");

      handlerA({
        stream: "notification",
        payload: {
          notification: makeNotification({ id: "stale", title: "Stale" }),
          unreadCount: 9,
        },
      });
      expect(__getStateForTests().notifications).toHaveLength(0);
    });

    it("keeps a token handoff invalidated until the typed auth probe confirms its identity", async () => {
      __setAuthStatusForTests(authenticated("user-a", "session-a"));
      initNotifications();
      await vi.waitFor(() =>
        expect(listNotifications).toHaveBeenCalledTimes(1),
      );

      // Simulates repointBaseUrl: onBaseUrlChange fires first (same tick, a
      // real handoff) and already reconciles to the new base correctly;
      // steward-token-sync fires afterward with a present token.
      getBaseUrl.mockReturnValue("http://agent-b.local");
      const baseUrlHandler = onBaseUrlChange.mock.calls[0][0] as () => void;
      baseUrlHandler();
      await vi.waitFor(() =>
        expect(listNotifications).toHaveBeenCalledTimes(2),
      );
      rotateConnection.mockClear();

      publishStewardSession("present");
      await Promise.resolve();

      // The new credential has no non-secret identity yet. Do not hydrate
      // under A's stale auth snapshot; the auth-status subscriber will
      // reconcile and fetch after the probe confirms the new authority.
      expect(listNotifications).toHaveBeenCalledTimes(2);
      expect(__getStateForTests().notifications).toHaveLength(0);
      expect(rotateConnection).toHaveBeenCalledTimes(1);
    });
  });
});

describe("notification-store mutations — authority-scoped rollback (#18542)", () => {
  function authenticated(userId: string, sessionId: string): AuthStatusState {
    return {
      phase: "authenticated",
      identity: { id: userId, displayName: userId, kind: "owner" },
      session: { id: sessionId, kind: "browser", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
        role: "OWNER",
      },
    };
  }

  beforeEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
    listNotifications
      .mockReset()
      .mockResolvedValue({ notifications: [], unreadCount: 0 });
    onWsEvent.mockReset().mockReturnValue(() => {});
    getBaseUrl.mockReset().mockReturnValue("http://agent-a.local");
    onBaseUrlChange.mockReset().mockReturnValue(() => {});
    hasToken.mockReset().mockReturnValue(true);
    rotateConnection.mockReset();
    markNotificationReadApi.mockReset();
    invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
    stewardSessionEpoch = 0;
  });

  afterEach(() => {
    __resetNotificationStoreForTests();
    __resetAuthStatusForTests();
  });

  it("discards a stale-authority optimistic rollback instead of overwriting the new authority's rows", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    const notifA = makeNotification({ id: "a-row", title: "A's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifA],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );

    // Start a mutation against A's row, but hold its HTTP response open.
    let rejectMarkRead!: (err: unknown) => void;
    markNotificationReadApi.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMarkRead = reject;
      }),
    );
    const mutationPromise = markNotificationRead("a-row");

    // Authority switches to B before the mutation settles.
    const notifB = makeNotification({ id: "b-row", title: "B's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifB],
      unreadCount: 1,
    });
    __setAuthStatusForTests(authenticated("user-b", "session-b"));
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications[0]?.id).toBe("b-row"),
    );

    // A's mutation now fails — its optimistic-rollback snapshot belongs to a
    // superseded authority and must not overwrite B's freshly-hydrated rows.
    rejectMarkRead(new Error("network"));
    await mutationPromise;
    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(__getStateForTests().notifications[0]?.id).toBe("b-row");
  });

  it("still reverts normally when the mutation fails within the same authority", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    const notifA = makeNotification({ id: "a-row", title: "A's row" });
    listNotifications.mockResolvedValueOnce({
      notifications: [notifA],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );

    markNotificationReadApi.mockRejectedValueOnce(new Error("network"));
    await markNotificationRead("a-row");

    expect(__getStateForTests().notifications[0]?.readAt).toBeNull();
  });

  it("does not let an older failed mutation erase a newer confirmed mutation", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    const notif = makeNotification({ id: "same-row", readAt: null });
    listNotifications.mockResolvedValueOnce({
      notifications: [notif],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );

    let rejectFirst!: (error: unknown) => void;
    markNotificationReadApi
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockResolvedValueOnce({ ok: true });
    const first = markNotificationRead("same-row");
    await markNotificationRead("same-row");
    rejectFirst(new Error("late failure"));
    await first;

    expect(__getStateForTests().notifications[0]?.readAt).not.toBeNull();
  });

  it("discards a rollback after an A-to-X-to-A authority round trip", async () => {
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    const original = makeNotification({ id: "a-row", readAt: null });
    listNotifications.mockResolvedValueOnce({
      notifications: [original],
      unreadCount: 1,
    });
    initNotifications();
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(1),
    );
    let rejectMutation!: (error: unknown) => void;
    markNotificationReadApi.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMutation = reject;
      }),
    );
    const mutation = markNotificationRead("a-row");

    listNotifications
      .mockResolvedValueOnce({ notifications: [], unreadCount: 0 })
      .mockResolvedValueOnce({
        notifications: [{ ...original, title: "fresh A" }],
        unreadCount: 1,
      });
    __setAuthStatusForTests(authenticated("user-x", "session-x"));
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications).toHaveLength(0),
    );
    __setAuthStatusForTests(authenticated("user-a", "session-a"));
    await vi.waitFor(() =>
      expect(__getStateForTests().notifications[0]?.title).toBe("fresh A"),
    );
    rejectMutation(new Error("late failure"));
    await mutation;
    expect(__getStateForTests().notifications[0]?.title).toBe("fresh A");
  });
});
