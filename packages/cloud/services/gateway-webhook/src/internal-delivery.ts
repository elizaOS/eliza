/** Delivers authenticated proactive messages through the gateway-owned connector. */

import { telegramAdapter } from "./adapters/telegram";
import type { ChatEvent } from "./adapters/types";
import { logger } from "./logger";
import type { GatewayRedis } from "./redis";
import { resolveWebhookConfig } from "./webhook-config";

interface InternalDeliveryDependencies {
  redis: GatewayRedis;
  cloudBaseUrl: string;
  getAuthHeader(): Record<string, string>;
}

interface InternalTelegramDelivery {
  platform: "telegram";
  project: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

function parseDelivery(value: unknown): InternalTelegramDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.platform !== "telegram" ||
    typeof input.project !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.project) ||
    typeof input.chatId !== "string" ||
    !/^-?\d{1,20}$/.test(input.chatId) ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 4096 ||
    typeof input.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9:._-]{1,200}$/.test(input.idempotencyKey)
  ) {
    return undefined;
  }
  return {
    platform: "telegram",
    project: input.project,
    chatId: input.chatId,
    text: input.text.trim(),
    idempotencyKey: input.idempotencyKey,
  };
}

export async function deliverInternalMessage(
  request: Request,
  dependencies: InternalDeliveryDependencies,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // error-policy:J3 malformed internal input is explicitly rejected.
    return Response.json(
      { success: false, error: "invalid delivery" },
      { status: 400 },
    );
  }
  const delivery = parseDelivery(raw);
  if (!delivery) {
    return Response.json(
      { success: false, error: "invalid delivery" },
      { status: 400 },
    );
  }

  const dedupeKey = `internal-delivery:${delivery.platform}:${delivery.project}:${delivery.idempotencyKey}`;
  const existing = await dependencies.redis.get<string>(dedupeKey);
  if (existing === "complete") {
    return Response.json({
      success: true,
      replayed: true,
      idempotencyKey: delivery.idempotencyKey,
    });
  }
  if (existing) {
    return Response.json(
      { success: false, error: "delivery in progress", retryable: true },
      { status: 409, headers: { "Retry-After": "1" } },
    );
  }
  const claimed = await dependencies.redis.set(dedupeKey, "pending", {
    ex: 60,
    nx: true,
  });
  if (claimed === null) {
    return Response.json(
      { success: false, error: "delivery in progress", retryable: true },
      { status: 409, headers: { "Retry-After": "1" } },
    );
  }

  try {
    const config = await resolveWebhookConfig(
      dependencies.redis,
      dependencies.cloudBaseUrl,
      dependencies.getAuthHeader(),
      "telegram",
      delivery.project,
    );
    if (!config) {
      await dependencies.redis.del(dedupeKey);
      return Response.json(
        { success: false, error: "connector unavailable", retryable: true },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    const event: ChatEvent = {
      platform: "telegram",
      messageId: delivery.idempotencyKey,
      chatId: delivery.chatId,
      chatType: "private",
      senderId: delivery.chatId,
      text: delivery.text,
      rawPayload: { source: "shared-reminder" },
    };
    await telegramAdapter.sendReply(config, event, delivery.text);
    await dependencies.redis.set(dedupeKey, "complete", {
      ex: 14 * 24 * 60 * 60,
    });
    const acceptedAt = new Date().toISOString();
    logger.info("Shared reminder delivered", {
      project: delivery.project,
      platform: delivery.platform,
      idempotencyKey: delivery.idempotencyKey,
    });
    return Response.json({
      success: true,
      replayed: false,
      idempotencyKey: delivery.idempotencyKey,
      acceptedAt,
    });
  } catch (error) {
    // error-policy:J1 the connector boundary releases ownership and returns a retryable failure.
    await dependencies.redis.del(dedupeKey);
    logger.error("Shared reminder delivery failed", {
      project: delivery.project,
      idempotencyKey: delivery.idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: "delivery failed", retryable: true },
      { status: 502, headers: { "Retry-After": "1" } },
    );
  }
}
