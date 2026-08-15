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
  sendDirectMessage(input: {
    discordUserId: string;
    text: string;
    nonce: string;
  }): Promise<
    { accepted: false } | { accepted: true; providerMessageId: string }
  >;
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

  try {
    const result = await dependencies.sendDirectMessage({
      discordUserId: delivery.discordUserId,
      text: delivery.text,
      nonce: discordReminderNonce(delivery.idempotencyKey),
    });
    if (!result.accepted) {
      return Response.json(
        {
          success: false,
          error: "connector unavailable",
          retryable: true,
          acceptance: "not_accepted",
        },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    return Response.json({
      success: true,
      replayed: false,
      idempotencyKey: delivery.idempotencyKey,
      acceptedAt: new Date().toISOString(),
      providerMessageIds: [result.providerMessageId],
    });
  } catch {
    // error-policy:J1 Discord may have accepted the nonce even when its
    // response was lost. The nonce makes an operator retry duplicate-safe,
    // but the scheduler must not claim success without the provider receipt.
    return Response.json(
      {
        success: false,
        acceptanceUnknown: true,
        acceptance: "unknown",
        retryable: false,
        error: "delivery acceptance is indeterminate",
        idempotencyKey: delivery.idempotencyKey,
      },
      { status: 202 },
    );
  }
}
