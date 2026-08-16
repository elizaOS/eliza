/**
 * Authenticates proactive Discord DM deliveries and binds each occurrence to
 * Discord's enforced nonce so retries resolve to one provider message.
 */

import { createHash, timingSafeEqual } from "node:crypto";

interface InternalDiscordDelivery {
  platform: "discord";
  discordUserId: string;
  text: string;
  idempotencyKey: string;
}

export interface DiscordInternalDeliveryDependencies {
  getInternalSecret(): string | undefined;
  receipts: {
    get(key: string): Promise<string | null>;
    set(
      key: string,
      value: string,
      options: { ex: number; nx?: boolean },
    ): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  sendDirectMessage(input: {
    discordUserId: string;
    text: string;
    nonce: string;
  }): Promise<
    { accepted: false } | { accepted: true; providerMessageId: string }
  >;
}

const DELIVERY_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;
const DELIVERY_CLAIM_TTL_SECONDS = 60;

type DeliveryReceipt =
  | { state: "indeterminate" }
  | {
      state: "complete";
      acceptedAt: string;
      providerMessageIds: string[];
    };

function receiptKey(delivery: InternalDiscordDelivery): string {
  return `internal-delivery:discord:${delivery.discordUserId}:${delivery.idempotencyKey}`;
}

function parseReceipt(value: string | null): DeliveryReceipt | undefined {
  if (value === "indeterminate") return { state: "indeterminate" };
  if (!value?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.state === "indeterminate") return { state: "indeterminate" };
    if (
      parsed.state === "complete" &&
      typeof parsed.acceptedAt === "string" &&
      Number.isFinite(Date.parse(parsed.acceptedAt)) &&
      Array.isArray(parsed.providerMessageIds) &&
      parsed.providerMessageIds.length > 0 &&
      parsed.providerMessageIds.every(
        (providerMessageId) =>
          typeof providerMessageId === "string" && providerMessageId.length > 0,
      )
    ) {
      return {
        state: "complete",
        acceptedAt: parsed.acceptedAt,
        providerMessageIds: parsed.providerMessageIds as string[],
      };
    }
  } catch {
    // error-policy:J3 malformed Redis state is not a delivery receipt.
    return undefined;
  }
  return undefined;
}

function matchesInternalSecret(
  request: Request,
  configuredSecret: string | undefined,
): boolean {
  const header = request.headers.get("X-Internal-Secret") ?? "";
  const secret = configuredSecret ?? "";
  const headerBytes = Buffer.from(header);
  const secretBytes = Buffer.from(secret);
  const length = Math.max(headerBytes.length, secretBytes.length, 1);
  const paddedHeader = Buffer.alloc(length);
  const paddedSecret = Buffer.alloc(length);
  headerBytes.copy(paddedHeader);
  secretBytes.copy(paddedSecret);
  const matches = timingSafeEqual(paddedHeader, paddedSecret);
  return (
    Boolean(header) &&
    Boolean(secret) &&
    headerBytes.length === secretBytes.length &&
    matches
  );
}

function parseDelivery(value: unknown): InternalDiscordDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.platform !== "discord" ||
    typeof input.discordUserId !== "string" ||
    !/^\d{1,32}$/.test(input.discordUserId) ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 2000 ||
    typeof input.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9:._-]{1,200}$/.test(input.idempotencyKey)
  ) {
    return undefined;
  }
  return {
    platform: "discord",
    discordUserId: input.discordUserId,
    text: input.text.trim(),
    idempotencyKey: input.idempotencyKey,
  };
}

/** Discord accepts decimal nonces up to 25 characters; 64 hash bits fit safely. */
export function discordReminderNonce(idempotencyKey: string): string {
  return createHash("sha256")
    .update(`shared-reminder:${idempotencyKey}`)
    .digest()
    .readBigUInt64BE()
    .toString();
}

export async function deliverInternalDiscordMessage(
  request: Request,
  dependencies: DiscordInternalDeliveryDependencies,
): Promise<Response> {
  if (!matchesInternalSecret(request, dependencies.getInternalSecret())) {
    return Response.json(
      { success: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // error-policy:J3 malformed internal JSON is explicitly rejected.
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

  const key = receiptKey(delivery);
  let existingValue: string | null;
  try {
    existingValue = await dependencies.receipts.get(key);
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
  if (existing?.state === "complete") {
    return Response.json({
      success: true,
      replayed: true,
      idempotencyKey: delivery.idempotencyKey,
      acceptedAt: existing.acceptedAt,
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
  let claimed: unknown;
  try {
    claimed = await dependencies.receipts.set(key, "pending", {
      ex: DELIVERY_CLAIM_TTL_SECONDS,
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

  try {
    const result = await dependencies.sendDirectMessage({
      discordUserId: delivery.discordUserId,
      text: delivery.text,
      nonce: discordReminderNonce(delivery.idempotencyKey),
    });
    if (!result.accepted) {
      let claimReleased = true;
      try {
        await dependencies.receipts.delete(key);
      } catch {
        // error-policy:J6 the short claim expires; the provider was not called.
        claimReleased = false;
      }
      return Response.json(
        {
          success: false,
          error: "connector unavailable",
          retryable: true,
          acceptance: "not_accepted",
          claimReleased,
        },
        {
          status: 503,
          headers: { "Retry-After": claimReleased ? "1" : "60" },
        },
      );
    }
    if (!result.providerMessageId.trim()) {
      throw new Error("Discord accepted delivery without a provider receipt");
    }
    const acceptedAt = new Date().toISOString();
    const receipt = JSON.stringify({
      state: "complete",
      acceptedAt,
      providerMessageIds: [result.providerMessageId],
    } satisfies DeliveryReceipt);
    await dependencies.receipts.set(key, receipt, {
      ex: DELIVERY_RECEIPT_TTL_SECONDS,
    });
    return Response.json({
      success: true,
      replayed: false,
      idempotencyKey: delivery.idempotencyKey,
      acceptedAt,
      providerMessageIds: [result.providerMessageId],
    });
  } catch {
    // error-policy:J1 Discord may have accepted the nonce even when its
    // response was lost. The nonce makes an operator retry duplicate-safe,
    // but the scheduler must not claim success without the provider receipt.
    let receiptPersisted = true;
    try {
      await dependencies.receipts.set(key, "indeterminate", {
        ex: DELIVERY_RECEIPT_TTL_SECONDS,
      });
    } catch {
      // error-policy:J1 the response still reports unknown acceptance when
      // the receipt store is unavailable; it never fabricates provider success.
      receiptPersisted = false;
    }
    return Response.json(
      {
        success: false,
        acceptanceUnknown: true,
        acceptance: "unknown",
        retryable: false,
        error: "delivery acceptance is indeterminate",
        idempotencyKey: delivery.idempotencyKey,
        receiptPersisted,
      },
      { status: 202 },
    );
  }
}
