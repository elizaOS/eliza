/** Delivers authenticated proactive messages through the gateway-owned connector. */

import { svcVerify } from "@elizaos/plugin-network/svc-auth";
import { BlooioApiResponseError, blooioAdapter } from "./adapters/blooio";
import { TelegramApiResponseError, telegramAdapter } from "./adapters/telegram";
import { twilioAdapter } from "./adapters/twilio";
import { type ChatEvent, PlatformDeliveryError } from "./adapters/types";
import { resolveConnectorAccountId } from "./connector-account";
import { logger } from "./logger";
import {
  isNetworkAddressOptedOut,
  isNetworkProject,
  type NetworkConsentLedger,
  redisNetworkConsentLedger,
} from "./network-compliance";
import type { GatewayRedis } from "./redis";
import {
  isCanonicalTelegramProject,
  requireCanonicalTelegramIdentity,
  telegramIdentityNotReadyResponse,
} from "./telegram-identity";
import { resolveSharedWebhookConfig } from "./webhook-config";

interface InternalDeliveryDependencies {
  redis: GatewayRedis;
  /** Network consent ledger; defaults to the Redis ledger on `redis`. */
  networkConsentLedger?: NetworkConsentLedger;
}

type InternalWebhookDelivery = (
  | {
      platform: "telegram";
      project: string;
      connectorAccountId: string;
      chatId: string;
      providerThreadId?: string;
      text: string;
      idempotencyKey: string;
    }
  | {
      platform: "blooio";
      project: string;
      phoneNumber: string;
      text: string;
      idempotencyKey: string;
    }
  | {
      platform: "blooio";
      project: string;
      connectorAccountId: string;
      chatId: string;
      text: string;
      idempotencyKey: string;
    }
  | {
      // Proactive SMS for The Network only (risk 5 in the Network fit spike).
      platform: "twilio";
      project: string;
      phoneNumber: string;
      text: string;
      idempotencyKey: string;
    }
) & {
  app?: "ntwrk" | "slop" | "peon" | "friends";
  networkCompliance?: { command: "stop" | "help" | "start"; messageId: string };
};

const DELIVERY_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;

type DeliveryReceipt = (
  | { state: "indeterminate" }
  | { state: "abandoned" }
  | {
      state: "complete";
      acceptedAt?: string;
      providerMessageIds: string[];
    }
) & { hash?: string };

function parseReceipt(value: unknown): DeliveryReceipt | undefined {
  if (value === "complete")
    return { state: "complete", providerMessageIds: [] };
  if (value === "dispatching" || value === "indeterminate") {
    return { state: "indeterminate" };
  }
  // Both GatewayRedis adapters (and Upstash's default deserialization) hand
  // back an already-parsed object for a JSON receipt; a raw string is parsed.
  if (
    !(value && typeof value === "object") &&
    !(typeof value === "string" && value.startsWith("{"))
  ) {
    return undefined;
  }
  try {
    const parsed = (
      typeof value === "string" ? JSON.parse(value) : value
    ) as Record<string, unknown>;
    if (parsed.state === "abandoned" && typeof parsed.hash === "string")
      return { state: "abandoned", hash: parsed.hash };
    if (parsed.state === "dispatching" || parsed.state === "indeterminate") {
      return {
        state: "indeterminate",
        ...(typeof parsed.hash === "string" ? { hash: parsed.hash } : {}),
      };
    }
    if (
      parsed.state === "complete" &&
      Array.isArray(parsed.providerMessageIds) &&
      parsed.providerMessageIds.every((id) => typeof id === "string")
    ) {
      return {
        state: "complete",
        ...(typeof parsed.hash === "string" ? { hash: parsed.hash } : {}),
        ...(typeof parsed.acceptedAt === "string" &&
        Number.isFinite(Date.parse(parsed.acceptedAt))
          ? { acceptedAt: parsed.acceptedAt }
          : {}),
        providerMessageIds: parsed.providerMessageIds as string[],
      };
    }
  } catch {
    // error-policy:J3 malformed Redis state is not accepted as a delivery receipt.
    return undefined;
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
    input.text.length > 2000 ||
    typeof input.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9:._-]{1,200}$/.test(input.idempotencyKey)
  ) {
    return undefined;
  }
  if (
    input.app !== undefined &&
    !["ntwrk", "slop", "peon", "friends"].includes(String(input.app))
  )
    return undefined;
  if (
    input.platform === "telegram" &&
    typeof input.connectorAccountId === "string" &&
    input.connectorAccountId.trim().length >= 3 &&
    input.connectorAccountId.length <= 160 &&
    typeof input.chatId === "string" &&
    /^-?\d{1,20}$/.test(input.chatId) &&
    (input.providerThreadId === undefined ||
      (typeof input.providerThreadId === "string" &&
        /^[1-9]\d{0,15}$/.test(input.providerThreadId) &&
        Number.isSafeInteger(Number(input.providerThreadId))))
  ) {
    return {
      platform: "telegram",
      project: input.project,
      ...(typeof input.app === "string"
        ? { app: input.app as InternalWebhookDelivery["app"] }
        : {}),
      connectorAccountId: input.connectorAccountId,
      chatId: input.chatId,
      ...(typeof input.providerThreadId === "string"
        ? { providerThreadId: input.providerThreadId }
        : {}),
      text: input.text.trim(),
      idempotencyKey: input.idempotencyKey,
    };
  }
  if (
    input.platform === "blooio" &&
    input.providerThreadId === undefined &&
    typeof input.phoneNumber === "string" &&
    /^\+[1-9]\d{6,14}$/.test(input.phoneNumber)
  ) {
    return {
      platform: "blooio",
      project: input.project,
      ...(typeof input.app === "string"
        ? { app: input.app as InternalWebhookDelivery["app"] }
        : {}),
      phoneNumber: input.phoneNumber,
      text: input.text.trim(),
      idempotencyKey: input.idempotencyKey,
    };
  }
  // Twilio proactive delivery is enabled only for The Network's project, so
  // every existing project keeps rejecting a Twilio payload exactly as before.
  if (
    input.platform === "twilio" &&
    isNetworkProject(input.project) &&
    input.providerThreadId === undefined &&
    input.chatId === undefined &&
    typeof input.phoneNumber === "string" &&
    /^\+[1-9]\d{6,14}$/.test(input.phoneNumber)
  ) {
    return {
      platform: "twilio",
      project: input.project,
      ...(typeof input.app === "string"
        ? { app: input.app as InternalWebhookDelivery["app"] }
        : {}),
      phoneNumber: input.phoneNumber,
      text: input.text.trim(),
      idempotencyKey: input.idempotencyKey,
    };
  }
  // A `chat_*` id addresses a provider-owned Blooio group thread; the adapter
  // sends it through `/v4/chats/{id}/messages` with no `to`/`from` pair.
  if (
    input.platform === "blooio" &&
    input.providerThreadId === undefined &&
    typeof input.connectorAccountId === "string" &&
    input.connectorAccountId.trim().length >= 3 &&
    input.connectorAccountId.length <= 160 &&
    typeof input.chatId === "string" &&
    /^chat_[A-Za-z0-9_-]{1,120}$/i.test(input.chatId)
  ) {
    return {
      platform: "blooio",
      project: input.project,
      ...(typeof input.app === "string"
        ? { app: input.app as InternalWebhookDelivery["app"] }
        : {}),
      connectorAccountId: input.connectorAccountId,
      chatId: input.chatId,
      text: input.text.trim(),
      idempotencyKey: input.idempotencyKey,
    };
  }
  return undefined;
}

async function deliveryHash(
  delivery: InternalWebhookDelivery,
): Promise<string> {
  const body = JSON.stringify([
    delivery.platform,
    delivery.project,
    delivery.app ?? null,
    "phoneNumber" in delivery ? delivery.phoneNumber : delivery.chatId,
    delivery.text,
    delivery.idempotencyKey,
  ]);
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

const notClaimed = () =>
  Response.json(
    {
      success: false,
      acceptance: "not_accepted",
      code: "not_claimed",
      retryable: false,
    },
    { status: 422 },
  );

/**
 * Receipt recovery; never invokes a connector, even when no receipt exists.
 * With `abandonUnclaimed`, a key with no claim at all is closed for good, so
 * the caller can settle "not sent" and a late send of that key is refused.
 * The gateway writes its indeterminate record before any provider call, so
 * an unclaimed key was never sent.
 */
export async function readInternalDeliveryReceipt(
  request: Request,
  dependencies: InternalDeliveryDependencies,
): Promise<Response> {
  const raw = await request.json().catch(() => null);
  const delivery = parseDelivery(raw);
  if (!delivery)
    return Response.json({ success: false, error: "invalid" }, { status: 400 });
  const key = `internal-delivery:${delivery.platform}:${delivery.project}:${delivery.idempotencyKey}`;
  let value = await dependencies.redis.get(key);
  if (
    value == null &&
    (raw as Record<string, unknown>).abandonUnclaimed === true
  ) {
    const abandoned = await dependencies.redis.set(
      key,
      JSON.stringify({
        state: "abandoned",
        hash: await deliveryHash(delivery),
      }),
      { ex: DELIVERY_RECEIPT_TTL_SECONDS, nx: true },
    );
    if (abandoned !== null) return notClaimed();
    value = await dependencies.redis.get(key);
  }
  const receipt = parseReceipt(value);
  if (
    receipt?.state === "abandoned" &&
    receipt.hash === (await deliveryHash(delivery))
  )
    return notClaimed();
  if (!receipt || receipt.hash !== (await deliveryHash(delivery)))
    return Response.json(
      { success: false, acceptance: "unknown", retryable: false },
      { status: 202 },
    );
  if (
    receipt.state !== "complete" ||
    !receipt.acceptedAt ||
    receipt.providerMessageIds.length === 0
  )
    return Response.json(
      { success: false, acceptance: "unknown", retryable: false },
      { status: 202 },
    );
  return Response.json({
    success: true,
    replayed: true,
    idempotencyKey: delivery.idempotencyKey,
    acceptedAt: receipt.acceptedAt,
    providerMessageIds: receipt.providerMessageIds,
  });
}

export async function deliverInternalMessage(
  request: Request,
  dependencies: InternalDeliveryDependencies,
): Promise<Response> {
  let raw: unknown;
  const rawBody = await request.text();
  try {
    raw = JSON.parse(rawBody);
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

  let compliance = false;
  const proof =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).networkCompliance
      : undefined;
  if (proof !== undefined) {
    const p = proof as Record<string, unknown>;
    const verified = await svcVerify(process.env.SERVICE_TURN_SECRET, {
      method: "POST",
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: rawBody,
    });
    if (
      !p ||
      !["stop", "help", "start"].includes(String(p.command)) ||
      typeof p.messageId !== "string" ||
      !p.messageId ||
      !verified.ok ||
      verified.id !== delivery.idempotencyKey ||
      !isNetworkProject(delivery.project) ||
      !("phoneNumber" in delivery)
    )
      return Response.json(
        {
          success: false,
          acceptance: "not_accepted",
          retryable: false,
          error: "invalid compliance proof",
        },
        { status: 403 },
      );
    compliance = true;
  }
  const hash = await deliveryHash(delivery);
  const config = resolveSharedWebhookConfig(
    delivery.platform,
    delivery.project,
  );
  if (
    delivery.platform === "telegram" &&
    isCanonicalTelegramProject(delivery.project)
  ) {
    try {
      await requireCanonicalTelegramIdentity(config);
    } catch (error) {
      // error-policy:J1 the authenticated delivery boundary returns a
      // value-safe failure before connector-account or provider work.
      return telegramIdentityNotReadyResponse(error);
    }
  }
  const configuredConnectorAccountId = resolveConnectorAccountId(
    delivery.platform,
    config,
  );
  if (
    !configuredConnectorAccountId ||
    ("connectorAccountId" in delivery &&
      delivery.connectorAccountId !== configuredConnectorAccountId)
  ) {
    return Response.json(
      {
        success: false,
        error: "connector account mismatch",
        retryable: false,
        acceptance: "not_accepted",
      },
      { status: 422 },
    );
  }

  // The Network's consent ledger wins over every proactive send: an address
  // that replied STOP is refused before any claim or provider work.
  if (
    isNetworkProject(delivery.project) &&
    "phoneNumber" in delivery &&
    !compliance
  ) {
    let optedOut: boolean;
    try {
      optedOut = await isNetworkAddressOptedOut(
        dependencies.networkConsentLedger ??
          redisNetworkConsentLedger(dependencies.redis),
        delivery.project,
        delivery.phoneNumber,
        delivery.app,
      );
    } catch {
      // error-policy:J1 no provider call occurs when consent is unknown.
      return Response.json(
        {
          success: false,
          error: "consent ledger unavailable",
          retryable: true,
          acceptance: "not_accepted",
        },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    if (optedOut) {
      return Response.json(
        {
          success: false,
          error: "recipient opted out",
          code: "recipient_opted_out",
          retryable: false,
          acceptance: "not_accepted",
        },
        { status: 422 },
      );
    }
  }

  // Keep the pre-account key as the monotonic replay fence. Changing this key
  // during rollout would strand complete/indeterminate receipts and could
  // resend a reminder that the provider already accepted.
  const dedupeKey = `internal-delivery:${delivery.platform}:${delivery.project}:${delivery.idempotencyKey}`;
  let existingValue: unknown;
  try {
    existingValue = await dependencies.redis.get<unknown>(dedupeKey);
  } catch {
    // error-policy:J1 no provider call occurs when durable replay state is unavailable.
    return Response.json(
      {
        success: false,
        error: "delivery receipt store unavailable",
        retryable: true,
        acceptance: "not_accepted",
      },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  const existing = parseReceipt(existingValue);
  if (existing?.hash && existing.hash !== hash)
    return Response.json(
      {
        success: false,
        acceptance: "not_accepted",
        retryable: false,
        error: "delivery conflict",
      },
      { status: 409 },
    );
  if (existing?.state === "complete") {
    if (
      delivery.idempotencyKey.startsWith("network:personal:") &&
      (!existing.acceptedAt || existing.providerMessageIds.length === 0)
    )
      return Response.json(
        { success: false, acceptance: "unknown", retryable: false },
        { status: 202 },
      );
    const acceptedAt = existing.acceptedAt ?? new Date().toISOString();
    return Response.json({
      success: true,
      replayed: true,
      idempotencyKey: delivery.idempotencyKey,
      acceptedAt,
      providerMessageIds: existing.providerMessageIds,
    });
  }
  if (existing?.state === "abandoned") return notClaimed();
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
  let claimed: unknown;
  try {
    claimed = await dependencies.redis.set(dedupeKey, "pending", {
      ex: 60,
      nx: true,
    });
  } catch {
    // error-policy:J1 no provider call occurs without a durable dispatch claim.
    return Response.json(
      {
        success: false,
        error: "delivery receipt store unavailable",
        retryable: true,
        acceptance: "not_accepted",
      },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  if (claimed === null) {
    return Response.json(
      { success: false, error: "delivery in progress", retryable: true },
      { status: 409, headers: { "Retry-After": "1" } },
    );
  }

  let connectorAttempted = false;
  try {
    const recipientId =
      "chatId" in delivery ? delivery.chatId : delivery.phoneNumber;
    const event: ChatEvent = {
      platform: delivery.platform,
      messageId: delivery.idempotencyKey,
      chatId: recipientId,
      chatType:
        "chatId" in delivery &&
        (delivery.platform === "blooio" || delivery.chatId.startsWith("-"))
          ? delivery.platform === "telegram"
            ? "supergroup"
            : "group"
          : "private",
      senderId: recipientId,
      text: delivery.text,
      ...(delivery.platform === "telegram" && delivery.providerThreadId
        ? { providerThreadId: delivery.providerThreadId }
        : {}),
      rawPayload: { source: "shared-reminder" },
    };
    const adapter =
      delivery.platform === "telegram"
        ? telegramAdapter
        : delivery.platform === "twilio"
          ? twilioAdapter
          : blooioAdapter;
    if (!adapter.sendReplyWithReceipt) {
      throw new Error(`${delivery.platform} receipt delivery is unavailable`);
    }
    // Provider dispatch may succeed before any transport error becomes visible.
    // Persist the tombstone first for every connector; only a proven rejection
    // or a validated receipt may replace it with retryable/complete state.
    await dependencies.redis.set(
      dedupeKey,
      JSON.stringify({ state: "indeterminate", hash }),
      {
        ex: DELIVERY_RECEIPT_TTL_SECONDS,
      },
    );
    connectorAttempted = true;
    const receipt = await adapter.sendReplyWithReceipt(
      config,
      event,
      delivery.text,
    );
    if (receipt.providerMessageIds.length === 0) {
      throw new Error("Connector accepted delivery without a provider receipt");
    }
    const acceptedAt = new Date().toISOString();
    await dependencies.redis.set(
      dedupeKey,
      JSON.stringify({
        state: "complete",
        hash,
        acceptedAt,
        providerMessageIds: receipt.providerMessageIds,
      } satisfies DeliveryReceipt),
      { ex: DELIVERY_RECEIPT_TTL_SECONDS },
    );
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
    const twilioRejected =
      delivery.platform === "twilio" &&
      error instanceof PlatformDeliveryError &&
      error.deliveryStatus === "failed";
    if (
      error instanceof TelegramApiResponseError ||
      (error instanceof BlooioApiResponseError &&
        error.deliveryStatus === "failed") ||
      twilioRejected
    ) {
      let claimReleased = true;
      try {
        await dependencies.redis.del(dedupeKey);
      } catch {
        // error-policy:J6 the bounded claim expires after this explicit provider rejection.
        claimReleased = false;
      }
      const providerStatus =
        error instanceof TelegramApiResponseError
          ? error.errorCode
          : error instanceof BlooioApiResponseError
            ? error.status
            : (error as PlatformDeliveryError).providerStatus;
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
          claimReleased,
          idempotencyKey: delivery.idempotencyKey,
        },
        {
          status,
          headers:
            status === 429 && claimReleased
              ? {
                  "Retry-After": String(
                    error instanceof TelegramApiResponseError
                      ? (error.retryAfterSeconds ?? 1)
                      : 1,
                  ),
                }
              : !claimReleased
                ? { "Retry-After": "60" }
                : undefined,
        },
      );
    }
    // error-policy:J1 once connector dispatch starts, the provider may have
    // accepted the message even if its response or our receipt write failed.
    if (!connectorAttempted) {
      try {
        await dependencies.redis.del(dedupeKey);
      } catch {
        // error-policy:J6 the bounded claim expires; the primary acceptance result wins.
      }
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
      {
        success: false,
        error: "delivery failed",
        retryable: true,
        acceptance: "not_accepted",
      },
      { status: 502, headers: { "Retry-After": "1" } },
    );
  }
}
