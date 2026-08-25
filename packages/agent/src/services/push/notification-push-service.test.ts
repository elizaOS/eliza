/**
 * Covers the notification push service: it subscribes to the agent event bus,
 * routes notification-stream events to per-platform providers (ios→apns,
 * android→fcm) only when configured, carries notification id/deepLink/category
 * in the push data, prunes dead tokens on an unregistered error, and — since
 * #23106 — delivers recipient-bound behind the fail-closed inbox-before-push
 * policy seam (no recipient / no policy / denied policy / unowned token all
 * mean inbox-only). Harness is in-memory — a fake network-free provider, an
 * in-memory event bus, a Map-backed cache — no real push send.
 */
import type {
  AgentEventListener,
  AgentEventPayload,
  AgentNotification,
  IAgentRuntime,
} from "@elizaos/core";
import { logger, NOTIFICATION_STREAM, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPushService } from "./notification-push-service.ts";
import { PushPolicyStore } from "./push-policy.ts";
import { PushTokenRegistry } from "./push-token-registry.ts";
import {
  type PushMessage,
  type PushProvider,
  PushUnregisteredError,
} from "./push-types.ts";

const OWNER = "owner-a";
const OTHER_OWNER = "owner-b";

/**
 * A fake provider with NO network — it records the (token, message) pairs it is
 * asked to send and can be told to reject specific tokens as unregistered. This
 * lets us verify dispatch routing + dead-token removal without faking a real
 * push delivery.
 */
class FakeProvider implements PushProvider {
  sent: Array<{ token: string; message: PushMessage }> = [];
  constructor(
    readonly name: string,
    private configured: boolean,
    private readonly unregisteredTokens: Set<string> = new Set(),
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async send(token: string, message: PushMessage): Promise<void> {
    if (this.unregisteredTokens.has(token)) {
      throw new PushUnregisteredError(token, "dead");
    }
    this.sent.push({ token, message });
  }
}

interface Harness {
  runtime: IAgentRuntime;
  emit: (notification: AgentNotification) => void;
  emitRaw: (event: AgentEventPayload) => void;
  registry: PushTokenRegistry;
  policies: PushPolicyStore;
  listenerCount: () => number;
}

function makeHarness(): Harness {
  const cache = new Map<string, unknown>();
  const listeners = new Set<AgentEventListener>();
  const bus = {
    subscribe(listener: AgentEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
    getService: (t: string) => (t === ServiceType.AGENT_EVENT ? bus : null),
    reportError: () => {},
  } as unknown as IAgentRuntime;

  const emitRaw = (event: AgentEventPayload) => {
    for (const listener of listeners) listener(event);
  };
  const emit = (notification: AgentNotification) =>
    emitRaw({
      runId: notification.id,
      seq: 1,
      ts: Date.now(),
      stream: NOTIFICATION_STREAM,
      data: { type: "notification", notification, unreadCount: 1 },
    });

  return {
    runtime,
    emit,
    emitRaw,
    registry: new PushTokenRegistry(runtime),
    policies: new PushPolicyStore(runtime),
    listenerCount: () => listeners.size,
  };
}

function notification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "Build finished",
    body: "Deploy #42 is live",
    category: "workflow",
    priority: "high",
    source: "workflow",
    deepLink: "/tasks",
    createdAt: Date.now(),
    readAt: null,
    recipientId: OWNER,
    ...overrides,
  };
}

/** Allow push for a principal in the harness policy store. */
async function allowPush(h: Harness, owner: string): Promise<void> {
  await h.policies.save(owner, {
    pushEnabled: true,
    version: 1,
    updatedAt: Date.now(),
  });
}

/** Wait a microtask turn so the service's async onNotification settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NotificationPushService", () => {
  let h: Harness;
  let ios: FakeProvider;
  let android: FakeProvider;

  beforeEach(() => {
    h = makeHarness();
    ios = new FakeProvider("apns", true);
    android = new FakeProvider("fcm", true);
  });

  it("subscribes to the bus on start", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    expect(h.listenerCount()).toBe(1);
  });

  it("no-ops cleanly when no provider is configured", async () => {
    const unconfiguredIos = new FakeProvider("apns", false);
    const unconfiguredAndroid = new FakeProvider("fcm", false);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios: unconfiguredIos, android: unconfiguredAndroid },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await allowPush(h, OWNER);

    // Must not throw and must not attempt a send.
    h.emit(notification());
    await flush();
    expect(unconfiguredIos.sent).toHaveLength(0);
    expect(unconfiguredAndroid.sent).toHaveLength(0);
  });

  it("dispatches ios→apns and android→fcm only for configured providers", async () => {
    const androidUnconfigured = new FakeProvider("fcm", false);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android: androidUnconfigured },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await h.registry.register("android", "tok-android", OWNER);
    await allowPush(h, OWNER);

    h.emit(notification());
    await flush();

    expect(ios.sent).toHaveLength(1);
    expect(ios.sent[0].token).toBe("tok-ios");
    // android provider is unconfigured → its token is skipped.
    expect(androidUnconfigured.sent).toHaveLength(0);
  });

  it("carries the notification id + deepLink in the push custom data", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await allowPush(h, OWNER);

    h.emit(notification({ id: "abc-123", deepLink: "/calendar" }));
    await flush();

    expect(ios.sent[0].message.data).toMatchObject({
      notificationId: "abc-123",
      deepLink: "/calendar",
      category: "workflow",
    });
    expect(ios.sent[0].message.title).toBe("Build finished");
  });

  it("drops a token from the registry on an unregistered error", async () => {
    const pruningIos = new FakeProvider("apns", true, new Set(["dead-token"]));
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios: pruningIos, android },
    });
    await service.attach();
    await h.registry.register("ios", "dead-token", OWNER);
    await h.registry.register("ios", "live-token", OWNER);
    await allowPush(h, OWNER);

    h.emit(notification());
    await flush();

    const remaining = (await h.registry.list()).map((r) => r.token);
    expect(remaining).toEqual(["live-token"]);
    expect(pruningIos.sent.map((s) => s.token)).toEqual(["live-token"]);
  });

  it("ignores non-notification stream events", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await allowPush(h, OWNER);

    h.emitRaw({
      runId: "r1",
      seq: 1,
      ts: Date.now(),
      stream: "lifecycle",
      data: { type: "run_start" },
    });
    await flush();
    expect(ios.sent).toHaveLength(0);
  });

  it("unsubscribes on stop", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    expect(h.listenerCount()).toBe(1);
    await service.stop();
    expect(h.listenerCount()).toBe(0);
  });

  it("starts dormant (no throw) when there is no event bus", async () => {
    const noBusRuntime = {
      ...h.runtime,
      getService: () => null,
    } as unknown as IAgentRuntime;
    const service = new NotificationPushService(noBusRuntime, {
      registry: new PushTokenRegistry(noBusRuntime),
      providers: { ios, android },
    });
    await expect(service.attach()).resolves.toBeUndefined();
  });

  // ── #23106 inbox-before-push, fail-closed matrix ──────────────────

  it("fails closed: a notification without a recipient is never pushed", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await allowPush(h, OWNER);

    h.emit(notification({ recipientId: undefined }));
    await flush();
    expect(ios.sent).toHaveLength(0);
    expect(android.sent).toHaveLength(0);
  });

  it("fails closed: no policy means inbox-only even for an owned token", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    // No policy saved for OWNER.

    h.emit(notification());
    await flush();
    expect(ios.sent).toHaveLength(0);
  });

  it("fails closed: an explicitly denied policy means inbox-only", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await h.policies.save(OWNER, {
      pushEnabled: false,
      version: 1,
      updatedAt: Date.now(),
    });

    h.emit(notification());
    await flush();
    expect(ios.sent).toHaveLength(0);
  });

  it("delivers only to the recipient's own tokens — never another principal's", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-owner", OWNER);
    await h.registry.register("ios", "tok-other", OTHER_OWNER);
    await h.registry.register("ios", "tok-unowned"); // legacy, no owner
    await allowPush(h, OWNER);
    await allowPush(h, OTHER_OWNER);

    h.emit(notification({ recipientId: OWNER }));
    await flush();

    expect(ios.sent.map((s) => s.token)).toEqual(["tok-owner"]);
  });

  it("fails closed: a legacy unowned token never receives a recipient-bound push", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-unowned");
    await allowPush(h, OWNER);

    h.emit(notification());
    await flush();
    expect(ios.sent).toHaveLength(0);
  });

  it("delivers when recipient, policy, and owned token all align", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await h.registry.register("android", "tok-android", OWNER);
    await allowPush(h, OWNER);

    h.emit(notification());
    await flush();

    expect(ios.sent.map((s) => s.token)).toEqual(["tok-ios"]);
    expect(android.sent.map((s) => s.token)).toEqual(["tok-android"]);
  });

  // ── failure-path diagnostics (restored from the pre-#23106 suite, adapted
  // to the recipient-bound pipeline so the J7 reporting cannot regress) ──

  it("logs and drops fan-out failures from the recipient token lookup", async () => {
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios", OWNER);
    await allowPush(h, OWNER);
    const listByOwnerSpy = vi
      .spyOn(h.registry, "listByOwner")
      .mockRejectedValueOnce(new Error("db down"));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const reportErrorSpy = vi
      .spyOn(h.runtime, "reportError")
      .mockImplementation(() => {});

    h.emit(notification());
    await flush();

    expect(listByOwnerSpy).toHaveBeenCalledTimes(1);
    expect(loggerSpy).toHaveBeenCalledWith(
      { src: "service:notification_push", error: expect.any(Error) },
      "[NotificationPushService] fan-out failed",
    );
    expect(reportErrorSpy).toHaveBeenCalledWith(
      "NotificationPushService.fanOut",
      expect.any(Error),
      { stream: NOTIFICATION_STREAM },
    );
    expect(ios.sent).toHaveLength(0);
  });

  it("logs and drops fan-out failures from dead-token unregister()", async () => {
    const pruningIos = new FakeProvider("apns", true, new Set(["dead-token"]));
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios: pruningIos, android },
    });
    await service.attach();
    await h.registry.register("ios", "dead-token", OWNER);
    await allowPush(h, OWNER);
    const unregisterSpy = vi
      .spyOn(h.registry, "unregister")
      .mockRejectedValueOnce(new Error("durable write rejected"));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const reportErrorSpy = vi
      .spyOn(h.runtime, "reportError")
      .mockImplementation(() => {});

    h.emit(notification());
    await flush();

    expect(unregisterSpy).toHaveBeenCalledWith("dead-token");
    expect(loggerSpy).toHaveBeenCalledWith(
      { src: "service:notification_push", error: expect.any(Error) },
      "[NotificationPushService] fan-out failed",
    );
    expect(reportErrorSpy).toHaveBeenCalledWith(
      "NotificationPushService.fanOut",
      expect.any(Error),
      { stream: NOTIFICATION_STREAM },
    );
  });
});
