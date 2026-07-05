/**
 * End-to-end wiring of the push pipeline the client leg unblocks: a device token
 * POSTed through the real `handlePushTokenRoute` lands in the service's registry,
 * and a notification emitted on the agent event bus then fans out to the matching
 * provider's `send()`. This is the loop that was dead before a client ever
 * registered a token — the HTTP boundary and the bus are real; only the network
 * provider (`send`) is a recording fake, so no push leaves the process.
 */
import type http from "node:http";
import type {
  AgentEventListener,
  AgentEventPayload,
  AgentNotification,
  IAgentRuntime,
} from "@elizaos/core";
import { NOTIFICATION_STREAM, ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handlePushTokenRoute } from "../../api/push-token-routes.ts";
import { NotificationPushService } from "./notification-push-service.ts";
import type { PushMessage, PushProvider } from "./push-types.ts";

class RecordingProvider implements PushProvider {
  sent: Array<{ token: string; message: PushMessage }> = [];
  constructor(
    readonly name: string,
    private readonly configured: boolean,
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async send(token: string, message: PushMessage): Promise<void> {
    this.sent.push({ token, message });
  }
}

function makeBus() {
  const listeners = new Set<AgentEventListener>();
  return {
    bus: {
      subscribe(listener: AgentEventListener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event: AgentEventPayload) {
      for (const listener of listeners) listener(event);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const notification = (): AgentNotification => ({
  id: "22222222-2222-2222-2222-222222222222",
  title: "Reminder",
  body: "Standup in 5 minutes",
  category: "reminder",
  priority: "high",
  source: "scheduler",
  deepLink: "/calendar",
  createdAt: Date.now(),
  readAt: null,
});

describe("push registration → delivery loop", () => {
  it("routes a route-registered token to the configured provider on a notification", async () => {
    const { bus, emit } = makeBus();
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000bb",
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, v: T): Promise<boolean> => {
        cache.set(k, v);
        return true;
      },
      deleteCache: async (k: string): Promise<boolean> => cache.delete(k),
      getService: (t: string) => (t === ServiceType.AGENT_EVENT ? bus : null),
    } as unknown as IAgentRuntime;

    const ios = new RecordingProvider("apns", true);
    const android = new RecordingProvider("fcm", true);
    const service = new NotificationPushService(runtime, {
      providers: { ios, android },
    });
    await service.attach();

    // The route dispatcher resolves the push service off the runtime, exactly
    // as the live server does.
    const routeRuntime = {
      getService: (t: string) =>
        t === NotificationPushService.serviceType ? service : null,
    };

    // A device registers its APNs token through the real HTTP route.
    const json = vi.fn();
    const error = vi.fn();
    const readJsonBody = vi.fn().mockResolvedValue({
      platform: "ios",
      token: "device-apns-token",
    });
    const handled = await handlePushTokenRoute(
      { url: "/api/notifications/push-tokens" } as http.IncomingMessage,
      {} as http.ServerResponse,
      "/api/notifications/push-tokens",
      "POST",
      { runtime: routeRuntime },
      { json, error, readJsonBody },
    );
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith({}, { ok: true }, 201);
    expect(await service.getRegistry().count()).toBe(1);

    // A notification is emitted on the bus; it must reach the iOS provider.
    emit({
      runId: "r1",
      seq: 1,
      ts: Date.now(),
      stream: NOTIFICATION_STREAM,
      data: {
        type: "notification",
        notification: notification(),
        unreadCount: 1,
      },
    });
    await flush();

    expect(ios.sent).toHaveLength(1);
    expect(ios.sent[0].token).toBe("device-apns-token");
    expect(ios.sent[0].message).toMatchObject({
      title: "Reminder",
      body: "Standup in 5 minutes",
      data: { notificationId: notification().id, deepLink: "/calendar" },
    });
    // No android token was registered → FCM provider is untouched.
    expect(android.sent).toHaveLength(0);
  });
});
