/**
 * Covers the notification push service: it subscribes to the agent event bus,
 * routes notification-stream events to per-platform providers (ios→apns,
 * android→fcm) only when configured, carries notification id/deepLink/category
 * in the push data, prunes dead tokens on an unregistered error, and
 * subscribes/unsubscribes cleanly. Harness is in-memory — a fake network-free
 * provider, an in-memory event bus, and a Map-backed cache — no real push send.
 */
import type {
  AgentEventListener,
  AgentEventPayload,
  AgentNotification,
  IAgentRuntime,
} from "@elizaos/core";
import { NOTIFICATION_STREAM, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationPushService } from "./notification-push-service.ts";
import { PushTokenRegistry } from "./push-token-registry.ts";
import {
  type PushMessage,
  type PushProvider,
  PushUnregisteredError,
} from "./push-types.ts";

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
    ...overrides,
  };
}

/** Wait a microtask turn so the service's async onNotification settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NotificationPushService", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it("subscribes to the bus on start", async () => {
    const ios = new FakeProvider("apns", false);
    const android = new FakeProvider("fcm", false);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    expect(h.listenerCount()).toBe(1);
  });

  it("no-ops cleanly when no provider is configured", async () => {
    const ios = new FakeProvider("apns", false);
    const android = new FakeProvider("fcm", false);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios");

    // Must not throw and must not attempt a send.
    h.emit(notification());
    await flush();
    expect(ios.sent).toHaveLength(0);
    expect(android.sent).toHaveLength(0);
  });

  it("dispatches ios→apns and android→fcm only for configured providers", async () => {
    const ios = new FakeProvider("apns", true);
    const android = new FakeProvider("fcm", false); // not configured
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios");
    await h.registry.register("android", "tok-android");

    h.emit(notification());
    await flush();

    expect(ios.sent).toHaveLength(1);
    expect(ios.sent[0].token).toBe("tok-ios");
    // android provider is unconfigured → its token is skipped.
    expect(android.sent).toHaveLength(0);
  });

  it("carries the notification id + deepLink in the push custom data", async () => {
    const ios = new FakeProvider("apns", true);
    const android = new FakeProvider("fcm", true);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios");

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
    const ios = new FakeProvider("apns", true, new Set(["dead-token"]));
    const android = new FakeProvider("fcm", false);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "dead-token");
    await h.registry.register("ios", "live-token");

    h.emit(notification());
    await flush();

    const remaining = (await h.registry.list()).map((r) => r.token);
    expect(remaining).toEqual(["live-token"]);
    expect(ios.sent.map((s) => s.token)).toEqual(["live-token"]);
  });

  it("ignores non-notification stream events", async () => {
    const ios = new FakeProvider("apns", true);
    const android = new FakeProvider("fcm", true);
    const service = new NotificationPushService(h.runtime, {
      registry: h.registry,
      providers: { ios, android },
    });
    await service.attach();
    await h.registry.register("ios", "tok-ios");

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
    const ios = new FakeProvider("apns", true);
    const android = new FakeProvider("fcm", true);
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
    const ios = new FakeProvider("apns", true);
    const android = new FakeProvider("fcm", true);
    const service = new NotificationPushService(noBusRuntime, {
      registry: new PushTokenRegistry(noBusRuntime),
      providers: { ios, android },
    });
    await expect(service.attach()).resolves.toBeUndefined();
  });
});
