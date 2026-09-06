import { randomUUID } from "node:crypto";
import { logger } from "@elizaos/logger";
import {
  and,
  eq,
  waitUntilRequestDatabaseTask,
  webhookConfigs,
  webhookDeliveries,
} from "../../../db/src/index.ts";
import {
  redactedThrownDiagnostics,
  type WebhookEvent,
} from "../../../shared/src/index.ts";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  isEncryptedWebhookSecret,
  WebhookDispatcher,
} from "../../../webhooks/src/index.ts";
import { db } from "./context";
import {
  acceptsConfiguredWebhookEvent,
  type ConfiguredWebhookEventType,
  type DispatchableWebhookEventType,
  toConfiguredWebhookEventType,
  webhookEventRegistry,
} from "./webhook-events";
import { redactWebhookSecrets } from "./webhook-redaction";
import { validateWebhookUrlResolved } from "./webhook-url";

const INLINE_DELIVERY_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;

export { redactWebhookSecrets } from "./webhook-redaction";

export function dispatchWebhook(
  tenantId: string,
  agentId: string,
  type: DispatchableWebhookEventType,
  data: Record<string, unknown>,
): void {
  const configuredType = toConfiguredWebhookEventType(type);
  // EMISSION-PATH WIDENING (Phase 2b): a plugin-declared event is one that is NOT
  // a core configured/alias type but IS present in the runtime
  // WebhookEventRegistry (core ∪ plugin-declared) because the plugin host merged
  // it in. We thread the raw plugin event name into the configured fan-out so a
  // tenant can subscribe to a plugin event specifically (events: ["plugin.evt"]).
  // The configured fan-out only ever matches a plugin event when it is
  // registry-valid AND a config explicitly lists it, so an arbitrary
  // unregistered string can never masquerade as a configured event.
  const isPluginEvent =
    configuredType === null && webhookEventRegistry.has(type);
  const redactedData = redactWebhookSecrets(data) as Record<string, unknown>;
  // `type` has passed the emission gate above (it is a configured/aliasable core
  // event OR a plugin event registered in the runtime registry). The widened
  // DispatchableWebhookEventType carries the `(string & {})` arm for plugin
  // events; cast to the WebhookEvent field type now that the name is validated.
  const eventType = (configuredType ?? type) as WebhookEvent["type"];
  const event: WebhookEvent = {
    type: eventType,
    tenantId,
    agentId,
    data: redactedData,
    timestamp: new Date(),
  };
  // Route callers intentionally do not await webhook delivery. In a Worker,
  // register that detached promise with the request-owned database lease so
  // its reads/writes finish before the WebSocket pool is closed. Bun keeps its
  // existing process-owned fire-and-forget behavior when no request lease is
  // active.
  void waitUntilRequestDatabaseTask(() =>
    dispatchConfiguredWebhooks(
      event,
      configuredType,
      isPluginEvent ? type : null,
    ).catch((error) => {
      logger.error(
        {
          details: [
            "[webhooks] Failed to dispatch configured webhooks",
            redactedThrownDiagnostics(error),
          ],
        },
        "[Login:webhook-dispatch] error",
      );
    }),
  );

  // SEC-101: the unverifiable tenant-route webhookUrl field is retired. The
  // former second fan-out through a bare URL both duplicate-delivered each
  // event and could only sign with a process-wide key. Persisted /webhooks
  // endpoints with receiver-known per-endpoint secrets are now the sole path.
}

export async function dispatchTestWebhook(config: {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: string[];
  actorId?: string | null;
}): Promise<typeof webhookDeliveries.$inferSelect> {
  const event: WebhookEvent = {
    type: "webhook.test",
    tenantId: config.tenantId,
    agentId: "dashboard",
    data: {
      test: true,
      webhookConfigId: config.id,
      actorId: config.actorId ?? null,
    },
    timestamp: new Date(),
  };

  return dispatchConfiguredWebhook(event, {
    ...config,
    maxRetries: 0,
    retryBackoffMs: 0,
    visibilityTimeoutMs: 0,
  });
}

export async function dispatchReplayWebhook(config: {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: string[];
  maxRetries: number;
  retryBackoffMs: number;
  replayedFromDeliveryId: string;
  originalPayload: Record<string, unknown>;
  originalEventType: string;
  originalAgentId?: string | null;
  originalCreatedAt: Date | string;
}): Promise<typeof webhookDeliveries.$inferSelect> {
  const originalTimestamp =
    typeof config.originalPayload.timestamp === "string" ||
    config.originalPayload.timestamp instanceof Date
      ? new Date(config.originalPayload.timestamp)
      : new Date(config.originalCreatedAt);
  const event: WebhookEvent = {
    type: config.originalEventType as WebhookEvent["type"],
    tenantId: config.tenantId,
    agentId:
      typeof config.originalPayload.agentId === "string"
        ? config.originalPayload.agentId
        : (config.originalAgentId ?? undefined),
    data:
      config.originalPayload.data &&
      typeof config.originalPayload.data === "object"
        ? (redactWebhookSecrets(config.originalPayload.data) as Record<
            string,
            unknown
          >)
        : {},
    timestamp: Number.isNaN(originalTimestamp.getTime())
      ? new Date(config.originalCreatedAt)
      : originalTimestamp,
  };

  return dispatchConfiguredWebhook(event, {
    ...config,
    replayedFromDeliveryId: config.replayedFromDeliveryId,
  });
}

async function dispatchConfiguredWebhooks(
  event: WebhookEvent,
  configuredType: ConfiguredWebhookEventType | null,
  pluginEventType: string | null = null,
): Promise<void> {
  const configs = await db
    .select()
    .from(webhookConfigs)
    .where(
      and(
        eq(webhookConfigs.tenantId, event.tenantId),
        eq(webhookConfigs.enabled, true),
      ),
    );

  await Promise.all(
    configs
      .filter((config) => {
        // Plugin-declared event (registry-valid, not a core configured type): a
        // config matches when it explicitly lists the event OR is a catch-all
        // (no events filter). It can never match by being a core configured type.
        if (pluginEventType) {
          return (
            config.events.length === 0 ||
            config.events.includes(pluginEventType)
          );
        }
        return configuredType
          ? acceptsConfiguredWebhookEvent(config.events, configuredType)
          : config.events.length === 0;
      })
      .map((config) =>
        dispatchConfiguredWebhook(event, {
          id: config.id,
          url: config.url,
          secret: config.secret,
          events: config.events,
          maxRetries: config.maxRetries,
          retryBackoffMs: config.retryBackoffMs,
        }),
      ),
  );
}

async function dispatchConfiguredWebhook(
  event: WebhookEvent,
  config: {
    id: string;
    url: string;
    secret: string;
    events: string[];
    maxRetries: number;
    retryBackoffMs: number;
    visibilityTimeoutMs?: number;
    replayedFromDeliveryId?: string | null;
  },
): Promise<typeof webhookDeliveries.$inferSelect> {
  const signingSecret = decryptWebhookSecret(config.secret);
  // Plaintext compatibility rows are upgraded lazily with a compare-and-set.
  // This avoids requiring the encryption key during migrations or racing
  // concurrently booting replicas; delivery rows snapshot only ciphertext.
  // A dormant compatibility row remains plaintext until delivery or rotation.
  const encryptedSecret = isEncryptedWebhookSecret(config.secret)
    ? config.secret
    : encryptWebhookSecret(signingSecret);
  if (encryptedSecret !== config.secret) {
    await db
      .update(webhookConfigs)
      .set({ secret: encryptedSecret, updatedAt: new Date() })
      .where(
        and(
          eq(webhookConfigs.id, config.id),
          eq(webhookConfigs.secret, config.secret),
        ),
      );
  }
  const deliveryId = randomUUID();
  const signedAt = Math.floor(Date.now() / 1000);
  const eventWithDelivery: WebhookEvent & {
    deliveryId: string;
    webhookConfigId: string;
    signedAt: number;
  } = {
    ...event,
    deliveryId,
    webhookConfigId: config.id,
    signedAt,
    ...(config.replayedFromDeliveryId
      ? { replayedFromDeliveryId: config.replayedFromDeliveryId }
      : {}),
  };
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      id: deliveryId,
      tenantId: event.tenantId,
      webhookConfigId: config.id,
      agentId: event.agentId,
      eventType: event.type,
      replayedFromDeliveryId: config.replayedFromDeliveryId ?? null,
      payload: eventWithDelivery as unknown as Record<string, unknown>,
      url: config.url,
      secret: encryptedSecret,
      events: config.events,
      status: "processing",
      attempts: 0,
      maxAttempts: config.maxRetries + 1,
      nextRetryAt:
        config.visibilityTimeoutMs === 0
          ? null
          : new Date(
              Date.now() +
                (config.visibilityTimeoutMs ??
                  INLINE_DELIVERY_VISIBILITY_TIMEOUT_MS),
            ),
    })
    .returning();

  if (!delivery) {
    throw new Error("Failed to create webhook delivery record");
  }

  // SEC-017: re-validate the destination at delivery time with FRESH DNS
  // answers — registration-time validation cannot see DNS rebinding (public A
  // record at config time, private at fetch time). Fail closed: no fetch.
  const deliveryUrlError = await validateWebhookUrlResolved(config.url);
  if (deliveryUrlError) {
    const [rejected] = await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        attempts: 0,
        lastError: `delivery blocked: ${deliveryUrlError}`,
        payload: eventWithDelivery as unknown as Record<string, unknown>,
      })
      .where(eq(webhookDeliveries.id, delivery.id))
      .returning();
    return rejected ?? delivery;
  }

  const dispatcher = new WebhookDispatcher({
    maxRetries: 0,
    retryDelayMs: 0,
  });
  const result = await dispatcher.dispatch(eventWithDelivery, {
    ...config,
    secret: signingSecret,
  });
  const retryable = !result.success && config.maxRetries > 0;

  const [updated] = await db
    .update(webhookDeliveries)
    .set({
      status: result.success ? "delivered" : retryable ? "pending" : "failed",
      attempts: result.attempts,
      deliveredAt: result.deliveredAt ?? null,
      lastError: result.error ?? null,
      nextRetryAt: retryable
        ? new Date(Date.now() + config.retryBackoffMs)
        : null,
      payload: eventWithDelivery as unknown as Record<string, unknown>,
    })
    .where(eq(webhookDeliveries.id, delivery.id))
    .returning();

  return updated ?? delivery;
}
