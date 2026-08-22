/**
 * Validates Meta webhook subscription challenges and signed Instagram
 * deliveries before account routing. It deliberately accepts raw bytes so the
 * HMAC is checked before JSON parsing or any durable side effect.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ElizaError } from "@elizaos/core";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_WEBHOOK_ENTRIES = 1_000;

export interface InstagramWebhookChange {
  accountId: string;
  eventId: string;
  field: string;
  value: Record<string, unknown>;
  receivedAt: number;
}

function webhookError(message: string, code: string): ElizaError {
  return new ElizaError(message, { code });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyInstagramWebhookChallenge(
  query: URLSearchParams,
  expectedVerifyToken: string
): string {
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token");
  const challenge = query.get("hub.challenge");
  if (
    mode !== "subscribe" ||
    !token ||
    !expectedVerifyToken ||
    !safeEqual(token, expectedVerifyToken) ||
    !challenge ||
    challenge.length > 512
  ) {
    throw webhookError("Instagram webhook verification failed.", "INSTAGRAM_WEBHOOK_UNAUTHORIZED");
  }
  return challenge;
}

export function parseInstagramWebhookDelivery(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
  receivedAt = Date.now()
): InstagramWebhookChange[] {
  if (!appSecret || appSecret.length > 16_384) {
    throw webhookError(
      "Instagram webhook app secret is not configured.",
      "INSTAGRAM_CONFIG_INVALID"
    );
  }
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    throw webhookError("Instagram webhook body size is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
  }
  const provided = signatureHeader?.match(/^sha256=([a-f0-9]{64})$/)?.[1];
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (!provided || !safeEqual(provided, expected)) {
    throw webhookError(
      "Instagram webhook signature validation failed.",
      "INSTAGRAM_WEBHOOK_UNAUTHORIZED"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw webhookError("Instagram webhook body is invalid JSON.", "INSTAGRAM_WEBHOOK_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw webhookError("Instagram webhook envelope is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.object !== "instagram" || !Array.isArray(envelope.entry)) {
    throw webhookError("Instagram webhook envelope is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
  }

  const output: InstagramWebhookChange[] = [];
  for (const rawEntry of envelope.entry) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw webhookError("Instagram webhook entry is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
    }
    const entry = rawEntry as Record<string, unknown>;
    const accountId = typeof entry.id === "string" ? entry.id : "";
    const time =
      typeof entry.time === "number" && Number.isFinite(entry.time) ? entry.time : receivedAt;
    if (!accountId || !/^[A-Za-z0-9_.:-]{1,256}$/.test(accountId)) {
      throw webhookError("Instagram webhook account is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
    }
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const rawChange of [...changes, ...messaging]) {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) {
        throw webhookError("Instagram webhook change is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
      }
      const change = rawChange as Record<string, unknown>;
      const field =
        typeof change.field === "string"
          ? change.field
          : messaging.includes(rawChange)
            ? "messages"
            : "";
      const value = field === "messages" ? change : change.value;
      if (!field || !value || typeof value !== "object" || Array.isArray(value)) {
        throw webhookError("Instagram webhook change is invalid.", "INSTAGRAM_WEBHOOK_INVALID");
      }
      const valueRecord = value as Record<string, unknown>;
      const message =
        valueRecord.message && typeof valueRecord.message === "object"
          ? (valueRecord.message as Record<string, unknown>)
          : undefined;
      const providerId =
        typeof message?.mid === "string"
          ? message.mid
          : typeof valueRecord.id === "string"
            ? valueRecord.id
            : typeof change.id === "string"
              ? change.id
              : `${accountId}:${time}:${output.length}`;
      output.push({
        accountId,
        eventId: `${accountId}:${field}:${providerId}`,
        field,
        value: valueRecord,
        receivedAt: time < 10_000_000_000 ? time * 1000 : time,
      });
      if (output.length > MAX_WEBHOOK_ENTRIES) {
        throw webhookError(
          "Instagram webhook contains too many entries.",
          "INSTAGRAM_WEBHOOK_INVALID"
        );
      }
    }
  }
  return output;
}
