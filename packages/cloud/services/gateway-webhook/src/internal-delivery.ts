/** Delivers authenticated proactive messages through the gateway-owned connector. */

import { BlooioApiResponseError, blooioAdapter } from "./adapters/blooio";
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

type InternalWebhookDelivery =
  | {
      platform: "telegram";
      project: string;
      chatId: string;
      text: string;
      idempotencyKey: string;
    }
  | {
      platform: "blooio";
      project: string;
      phoneNumber: string;
      text: string;
      idempotencyKey: string;
    };

const DELIVERY_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;

type DeliveryReceipt =
  | { state: "indeterminate" }
  | { state: "complete"; providerMessageIds: string[] };

function parseReceipt(value: string | null): DeliveryReceipt | undefined {
  if (value === "complete")
    return { state: "complete", providerMessageIds: [] };
  if (value === "dispatching" || value === "indeterminate") {
    return { state: "indeterminate" };
  }
  if (!value?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.state === "dispatching" || parsed.state === "indeterminate") {
      return { state: "indeterminate" };
    }
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

function parseDelivery(value: unknown): InternalWebhookDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (
    typeof input.project !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.project) ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 4096 ||
    typeof input.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9:._-]{1,200}$/.test(input.idempotencyKey)
  ) {
    return undefined;
  }
  if (
    input.platform === "telegram" &&
    typeof input.chatId === "string" &&
    /^-?\d{1,20}$/.test(input.chatId)
  ) {
    return {
      platform: "telegram",
      project: input.project,
      chatId: input.chatId,
      text: input.text.trim(),
      idempotencyKey: input.idempotencyKey,
    };
  }
  if (
    input.platform === "blooio" &&
    typeof input.phoneNumber === "string" &&
    /^\+[1-9]\d{6,14}$/.test(input.phoneNumber)
  ) {
    return {
      platform: "blooio",
      project: input.project,
      phoneNumber: input.phoneNumber,
      text: input.text.trim(),
      idempotencyKey: input.idempotencyKey,
    };
  }
  return undefined;
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
  if (existing?.state === "indeterminate") {
    return Response.json(
      {
        success: false,
        replayed: true,
        acceptanceUnknown: true,
        acceptance: "unknown",
        retryable: false,
        error: "delivery acceptance is indeterminate",
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
      delivery.platform,
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
      platform: delivery.platform,
      messageId: delivery.idempotencyKey,
      chatId:
        delivery.platform === "telegram"
          ? delivery.chatId
          : delivery.phoneNumber,
      chatType: "private",
      senderId:
        delivery.platform === "telegram"
          ? delivery.chatId
          : delivery.phoneNumber,
      text: delivery.text,
      rawPayload: { source: "shared-reminder" },
    };
    const adapter =
      delivery.platform === "telegram" ? telegramAdapter : blooioAdapter;
    if (!adapter.sendReplyWithReceipt) {
      throw new Error(`${delivery.platform} receipt delivery is unavailable`);
    }
    if (delivery.platform === "telegram") {
      // Telegram has no provider idempotency key. Persist an indeterminate
      // tombstone before dispatch so a process death can never duplicate it.
      await dependencies.redis.set(dedupeKey, "indeterminate", {
        ex: DELIVERY_RECEIPT_TTL_SECONDS,
      });
    }
    connectorAttempted = true;
    const receipt = await adapter.sendReplyWithReceipt(
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
    if (
      error instanceof TelegramApiResponseError ||
      error instanceof BlooioApiResponseError
    ) {
      await dependencies.redis.del(dedupeKey);
      const providerStatus =
        error instanceof TelegramApiResponseError
          ? error.errorCode
          : error.status;
      const status =
        providerStatus === 401 ||
        providerStatus === 403 ||
        providerStatus === 429
          ? providerStatus
          : 422;
      logger.warn("Provider explicitly rejected Shared reminder delivery", {
        project: delivery.project,
        platform: delivery.platform,
        idempotencyKey: delivery.idempotencyKey,
        errorCode: providerStatus,
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
                  "Retry-After": String(
                    error instanceof TelegramApiResponseError
                      ? (error.retryAfterSeconds ?? 1)
                      : 1,
                  ),
                }
              : undefined,
        },
      );
    }
    // error-policy:J1 once connector dispatch starts, the provider may have
    // accepted the message even if its response or our receipt write failed.
    if (!connectorAttempted || delivery.platform === "blooio") {
      // Blooio enforces the stable provider idempotency key, so clearing this
      // process-local claim permits a safe operator retry after an unknown response.
      await dependencies.redis.del(dedupeKey);
    }
    logger.error("Shared reminder delivery failed", {
      project: delivery.project,
      idempotencyKey: delivery.idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
    if (connectorAttempted) {
      return Response.json(
        {
          success: false,
          replayed: false,
          acceptanceUnknown: true,
          acceptance: "unknown",
          retryable: false,
          error: "delivery acceptance is indeterminate",
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
