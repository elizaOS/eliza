/**
 * NotificationPushService
 *
 * The server-side bridge between the unified notification rail and remote push
 * transports (APNs / FCM). It subscribes to the AgentEventService bus and, for
 * every `stream:"notification"` event, fans the notification out to all
 * registered device push tokens via the matching provider.
 *
 * DELIVERY POLICY (intentionally simple, documented):
 *   - Every notification is pushed to every registered token of the matching
 *     platform. The app dedupes by the notification `id` carried in the push
 *     custom data against its in-app notification center, and the OS only
 *     surfaces it when the app is backgrounded/killed.
 *   - A "only push when the device isn't actively connected over WebSocket"
 *     optimization is a future refinement; it is deliberately not implemented
 *     here to keep the seam single-pathed.
 *
 * CREDENTIAL GATING: a provider is only used when `isConfigured()` is true.
 * With NO provider configured the service still starts (so the registry/routes
 * stay live) but logs once at debug and does nothing on each notification.
 *
 * VERIFIABILITY: subscription, no-op-when-unconfigured, token lookup, dispatch
 * routing (ios→apns, android→fcm), and dead-token removal are unit-tested with
 * an injected fake provider. Real network delivery is NOT tested — it needs
 * live APNs/FCM credentials and a physical device.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type AgentEventListener,
  type AgentEventPayload,
  type AgentNotification,
  logger,
  NOTIFICATION_STREAM,
  Service,
  ServiceType,
} from "@elizaos/core";
import { ApnsProvider } from "./apns-provider.ts";
import { FcmProvider } from "./fcm-provider.ts";
import { type PushPlatform, PushTokenRegistry } from "./push-token-registry.ts";
import {
  type PushMessage,
  type PushProvider,
  PushUnregisteredError,
} from "./push-types.ts";

/** Service type identifier for the push delivery service. */
export const NOTIFICATION_PUSH_SERVICE_TYPE = "notification_push";

/** Minimal structural view of the event bus we subscribe to. */
interface SubscribableBus {
  subscribe(listener: AgentEventListener): () => void;
}

function isSubscribableBus(value: unknown): value is SubscribableBus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SubscribableBus).subscribe === "function"
  );
}

function isAgentNotification(value: unknown): value is AgentNotification {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AgentNotification).id === "string" &&
    typeof (value as AgentNotification).title === "string"
  );
}

/** Providers the service can dispatch through, by platform. */
export interface PushProviderSet {
  ios: PushProvider;
  android: PushProvider;
}

export class NotificationPushService extends Service {
  static serviceType: string = NOTIFICATION_PUSH_SERVICE_TYPE;
  capabilityDescription =
    "Delivers notifications to backgrounded/killed devices via APNs and FCM";

  private readonly registry: PushTokenRegistry;
  private readonly providers: PushProviderSet;
  private unsubscribe: (() => void) | null = null;

  constructor(
    runtime: IAgentRuntime,
    options?: { registry?: PushTokenRegistry; providers?: PushProviderSet },
  ) {
    super(runtime);
    this.registry = options?.registry ?? new PushTokenRegistry(runtime);
    this.providers = options?.providers ?? {
      ios: new ApnsProvider(),
      android: new FcmProvider(),
    };
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new NotificationPushService(runtime);
    await service.attach();
    return service;
  }

  /** Subscribe to the notification rail (idempotent). */
  async attach(): Promise<void> {
    const anyConfigured =
      this.providers.ios.isConfigured() ||
      this.providers.android.isConfigured();
    if (!anyConfigured) {
      logger.debug(
        { src: "service:notification_push" },
        "[NotificationPushService] push delivery inactive (no APNs/FCM credentials)",
      );
    }

    const bus = this.runtime.getService(ServiceType.AGENT_EVENT);
    if (!isSubscribableBus(bus)) {
      // No event bus (headless/test boot without AgentEventService): nothing to
      // subscribe to. The registry + routes still function for diagnostics.
      logger.debug(
        { src: "service:notification_push" },
        "[NotificationPushService] no agent event bus; push delivery dormant",
      );
      return;
    }

    this.unsubscribe = bus.subscribe((event) => {
      if (event.stream !== NOTIFICATION_STREAM) return;
      void this.onNotification(event);
    });
  }

  /** The registry instance (used by the routes layer). */
  getRegistry(): PushTokenRegistry {
    return this.registry;
  }

  private async onNotification(event: AgentEventPayload): Promise<void> {
    const notification = event.data?.notification;
    if (!isAgentNotification(notification)) return;

    // Skip work entirely when neither transport is configured.
    if (
      !this.providers.ios.isConfigured() &&
      !this.providers.android.isConfigured()
    ) {
      return;
    }

    const tokens = await this.registry.list();
    if (tokens.length === 0) return;

    const message = toPushMessage(notification);
    for (const record of tokens) {
      const provider = this.providers[record.platform];
      if (!provider.isConfigured()) continue;
      await this.dispatch(provider, record.platform, record.token, message);
    }
  }

  private async dispatch(
    provider: PushProvider,
    platform: PushPlatform,
    token: string,
    message: PushMessage,
  ): Promise<void> {
    try {
      await provider.send(token, message);
    } catch (error) {
      if (error instanceof PushUnregisteredError) {
        await this.registry.unregister(token);
        logger.debug(
          { src: "service:notification_push", platform },
          "[NotificationPushService] dropped unregistered push token",
        );
        return;
      }
      logger.error(
        { src: "service:notification_push", platform, error },
        "[NotificationPushService] push delivery failed",
      );
    }
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

/**
 * Map an AgentNotification onto a PushMessage. The notification `id` and
 * `deepLink` ride in custom data so the app can deep-link on tap and dedupe
 * against the in-app center.
 */
function toPushMessage(notification: AgentNotification): PushMessage {
  const data: PushMessage["data"] = {
    notificationId: notification.id,
    category: notification.category,
  };
  if (notification.deepLink) data.deepLink = notification.deepLink;
  if (notification.groupKey) data.groupKey = notification.groupKey;
  return {
    title: notification.title,
    body: notification.body,
    data,
  };
}

export default NotificationPushService;
