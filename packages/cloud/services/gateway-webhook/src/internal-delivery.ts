/** Delivers authenticated proactive messages through the gateway-owned connector. */

import { TelegramApiResponseError, telegramAdapter } from "./adapters/telegram";
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

const DELIVERY_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;

type DeliveryReceipt =
  | { state: "dispatching" }
  | { state: "complete"; providerMessageIds: string[] };

function parseReceipt(value: string | null): DeliveryReceipt | undefined {
  if (value === "complete")
    return { state: "complete", providerMessageIds: [] };
  if (value === "dispatching") return { state: "dispatching" };
  if (!value?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.state === "dispatching") return { state: "dispatching" };
    if (
      parsed.state === "complete" &&
      Array.isArray(parsed.providerMessageIds) &&
      parsed.providerMessageIds.every((id) => typeof id === "string")
    ) {
      return {
        state: "complete",
        providerMessageIds: parsed.providerMessageIds as string[],
      };
    }
  } catch {
    // error-policy:J3 malformed Redis state is not accepted as a delivery receipt.
  }
  return undefined;
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
  const existingValue = await dependencies.redis.get<string>(dedupeKey);
  const existing = parseReceipt(existingValue);
  if (existing?.state === "complete") {
    return Response.json({
      success: true,
      replayed: true,
      idempotencyKey: delivery.idempotencyKey,
      providerMessageIds: existing.providerMessageIds,
    });
  }
  if (existing?.state === "dispatching") {
    return Response.json(
      {
        success: true,
        replayed: true,
        acceptanceUnknown: true,
        idempotencyKey: delivery.idempotencyKey,
      },
      { status: 202 },
    );
  }
  if (existingValue) {
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

  let connectorAttempted = false;
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
    if (!telegramAdapter.sendReplyWithReceipt) {
      throw new Error("Telegram receipt delivery is unavailable");
    }
    await dependencies.redis.set(dedupeKey, "dispatching", {
      ex: DELIVERY_RECEIPT_TTL_SECONDS,
    });
    connectorAttempted = true;
    const receipt = await telegramAdapter.sendReplyWithReceipt(
      config,
      event,
      delivery.text,
    );
    await dependencies.redis.set(
      dedupeKey,
      JSON.stringify({
        state: "complete",
        providerMessageIds: receipt.providerMessageIds,
      } satisfies DeliveryReceipt),
      { ex: DELIVERY_RECEIPT_TTL_SECONDS },
    );
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
      providerMessageIds: receipt.providerMessageIds,
    });
  } catch (error) {
    if (error instanceof TelegramApiResponseError) {
      await dependencies.redis.del(dedupeKey);
      const status =
        error.errorCode === 401 ||
        error.errorCode === 403 ||
        error.errorCode === 429
          ? error.errorCode
          : 422;
      logger.warn("Telegram explicitly rejected Shared reminder delivery", {
        project: delivery.project,
        idempotencyKey: delivery.idempotencyKey,
        errorCode: error.errorCode,
      });
      return Response.json(
        {
          success: false,
          error: "provider rejected delivery",
          retryable: true,
          acceptance: "not_accepted",
          idempotencyKey: delivery.idempotencyKey,
        },
        {
          status,
          headers:
            status === 429
              ? {
                  "Retry-After": String(error.retryAfterSeconds ?? 1),
                }
              : undefined,
        },
      );
    }
    // error-policy:J1 once connector dispatch starts, the provider may have
    // accepted the message even if its response or our receipt write failed.
    if (!connectorAttempted) await dependencies.redis.del(dedupeKey);
    logger.error("Shared reminder delivery failed", {
      project: delivery.project,
      idempotencyKey: delivery.idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
    if (connectorAttempted) {
      return Response.json(
        {
          success: true,
          replayed: false,
          acceptanceUnknown: true,
          idempotencyKey: delivery.idempotencyKey,
        },
        { status: 202 },
      );
    }
    return Response.json(
      { success: false, error: "delivery failed", retryable: true },
      { status: 502, headers: { "Retry-After": "1" } },
    );
  }
}
