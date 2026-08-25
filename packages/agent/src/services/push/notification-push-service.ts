/**
 * NotificationPushService
 *
 * The server-side bridge between the unified notification rail and remote push
 * transports (APNs / FCM). It subscribes to the AgentEventService bus and, for
 * every `stream:"notification"` event, delivers the notification to the device
 * push tokens owned by the notification's canonical RECIPIENT (#23106).
 *
 * DELIVERY POLICY (inbox-before-push, fail-closed — #23106 first tranche):
 *   - A notification ALWAYS lands in the inbox first; NotificationService owns
 *     that path and this service never gates it. Whether it may ALSO leave the
 *     process as a remote push is decided per-principal by the PushPolicyStore
 *     seam (push-policy.ts): no recipient → inbox-only; no policy → inbox-only
 *     (the principal never opted in); policy denied → inbox-only. Only an
 *     explicit per-principal policy allowing push permits delivery, and only to
 *     tokens registered BY that same principal.
 *   - Legacy tokens registered without an ownerEntityId never match a
 *     recipient-bound push: they can be listed and unregistered, but delivery
 *     to them is over until the device re-registers with a principal. This is
 *     the deliberate fail-closed default — privacy errs inbox-only.
 *   - A "only push when the device isn't actively connected over WebSocket"
 *     optimization is a future refinement; it is deliberately not implemented
 *     here to keep the seam single-pathed.
 *   - Digests (batched/deferred delivery) are NOT owned here: there is one
 *     clock (core TaskService) and `plugin-scheduling` owns the scheduled-item
 *     state machine. The recipient/policy seam is the typed surface a future
 *     digest queue consults; this service creates no scheduler.
 *
 * CREDENTIAL GATING: a provider is only used when `isConfigured()` is true.
 * With NO provider configured the service still starts (so the registry/routes
 * stay live) but logs once at debug and does nothing on each notification.
 *
 * VERIFIABILITY: subscription, no-op-when-unconfigured, recipient/owner token
 * matching, the fail-closed policy matrix (no recipient / no policy / denied /
 * allowed), dispatch routing (ios→apns, android→fcm), and dead-token removal
 * are unit-tested with an injected fake provider and store. Real network
 * delivery is NOT tested — it needs live APNs/FCM credentials and a physical
 * device.
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
import {
  decidePushDelivery,
  type PushDeliveryDecision,
  PushPolicyStore,
} from "./push-policy.ts";
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
    "Delivers recipient-bound notifications to backgrounded/killed devices via APNs and FCM, behind a per-principal fail-closed push policy";

  private readonly registry: PushTokenRegistry;
  private readonly policies: PushPolicyStore;
  private readonly providers: PushProviderSet;
  private unsubscribe: (() => void) | null = null;

  constructor(
    runtime: IAgentRuntime,
    options?: {
      registry?: PushTokenRegistry;
      policies?: PushPolicyStore;
      providers?: PushProviderSet;
    },
  ) {
    super(runtime);
    this.registry = options?.registry ?? new PushTokenRegistry(runtime);
    this.policies = options?.policies ?? new PushPolicyStore(runtime);
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
      void (async () => {
        try {
          await this.onNotification(event);
        } catch (error) {
          // error-policy:J7 best-effort fan-out must not escape as an
          // unhandled rejection; log + report and drop the event.
          logger.error(
            { src: "service:notification_push", error },
            "[NotificationPushService] fan-out failed",
          );
          if (typeof this.runtime.reportError === "function") {
            this.runtime.reportError(
              "NotificationPushService.fanOut",
              error as Error,
              { stream: NOTIFICATION_STREAM },
            );
          }
        }
      })();
    });
  }

  /** The registry instance (used by the routes layer). */
  getRegistry(): PushTokenRegistry {
    return this.registry;
  }

  /** The per-principal policy store (used by the routes layer). */
  getPolicies(): PushPolicyStore {
    return this.policies;
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

    // #23106 inbox-before-push seam: the inbox delivery already happened (the
    // event we are reacting to IS the inbox rail). Push is the add-on, gated
    // per-principal and FAIL-CLOSED: no recipient, no policy, or a denied
    // policy all mean inbox-only — never a push.
    const recipientId = notification.recipientId;
    if (!recipientId || recipientId.length === 0) {
      logger.debug(
        { src: "service:notification_push" },
        "[NotificationPushService] no recipient; inbox-only (fail-closed)",
      );
      return;
    }
    const policy = await this.policies.load(recipientId);
    const decision: PushDeliveryDecision = decidePushDelivery(
      notification,
      policy,
    );
    if (decision.outcome !== "allow") {
      logger.debug(
        {
          src: "service:notification_push",
          reason: decision.reason,
          policyVersion: decision.policyVersion,
        },
        "[NotificationPushService] push policy denied; inbox-only (fail-closed)",
      );
      return;
    }

    // Recipient-bound delivery: only tokens registered by this principal.
    const tokens = await this.registry.listByOwner(recipientId);
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
