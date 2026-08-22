/**
 * Authenticates Blooio webhook fan-in and maps stable one-to-one message
 * deliveries onto the gateway's deduplicated chat contract.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { logger } from "../logger";
import { boundedGatewayFetch } from "./bounded-fetch";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

const BLOOIO_V2_API_BASE = "https://api.blooio.com/v2/api";
const BLOOIO_V4_MESSAGES_URL = "https://api.blooio.com/v4/messages";

export const BLOOIO_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const BLOOIO_GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024;

export function blooioGatewayFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = BLOOIO_GATEWAY_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return boundedGatewayFetch(
    fetch,
    input,
    init,
    timeoutMs,
    BLOOIO_GATEWAY_RESPONSE_MAX_BYTES,
  );
}

export class BlooioApiResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BlooioApiResponseError";
  }
}

const BlooioAttachmentSchema = z.union([
  z.string(),
  z.object({ url: z.string().url(), name: z.string().nullish() }).passthrough(),
]);

const BlooioV2WebhookEventSchema = z.object({
  event: z.string().min(1),
  message_id: z.string().trim().min(1).nullish(),
  external_id: z.string().nullish(),
  internal_id: z.string().nullish(),
  sender: z.string().trim().min(1).nullish(),
  channel_id: z.string().trim().min(1).nullish(),
  channel_type: z.string().trim().min(1).nullish(),
  text: z.string().nullish(),
  attachments: z.array(BlooioAttachmentSchema).nullish(),
  protocol: z.string().nullish(),
  is_group: z.boolean().nullish(),
  received_at: z.number().nullish(),
  timestamp: z.number().nullish(),
});

const BlooioV4MessageSchema = z
  .object({
    id: z.string().trim().min(1).nullish(),
    message_id: z.string().trim().min(1).nullish(),
    chat_id: z.string().nullish(),
    channel_id: z.string().trim().min(1).nullish(),
    channel_type: z.string().trim().min(1).nullish(),
    sender: z.string().trim().min(1).nullish(),
    recipient: z.string().nullish(),
    channel_address: z.string().nullish(),
    contact: z
      .object({ identifier: z.string().trim().min(1).nullish() })
      .nullish(),
    text: z.string().nullish(),
    attachments: z.array(BlooioAttachmentSchema).nullish(),
    protocol: z.string().nullish(),
    is_group: z.boolean().nullish(),
    group: z.unknown().nullish(),
  })
  .passthrough();

const BlooioV4WebhookEnvelopeSchema = z.object({
  id: z.string().trim().min(1),
  type: z.string().min(1),
  created_at: z.number(),
  data: BlooioV4MessageSchema,
});

type BlooioWebhookEvent = z.infer<typeof BlooioV2WebhookEventSchema>;

function parseWebhookEvent(data: unknown): BlooioWebhookEvent | null {
  const v2 = BlooioV2WebhookEventSchema.safeParse(data);
  if (v2.success) return v2.data;

  const v4 = BlooioV4WebhookEnvelopeSchema.safeParse(data);
  if (!v4.success) return null;

  const message = v4.data.data;
  const sender = message.sender ?? message.contact?.identifier ?? null;
  return {
    event: v4.data.type,
    message_id: message.message_id ?? message.id,
    external_id: sender,
    internal_id: message.recipient ?? message.channel_address,
    sender,
    channel_id: message.channel_id,
    channel_type: message.channel_type,
    text: message.text,
    attachments: message.attachments,
    protocol: message.protocol,
    is_group: message.is_group ?? message.group != null,
    received_at: v4.data.created_at,
    timestamp: v4.data.created_at,
  };
}

function providerSentAtMs(event: BlooioWebhookEvent): number | undefined {
  const timestamp = event.received_at ?? event.timestamp;
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  // Blooio v4 uses epoch milliseconds. Older v2 payloads have appeared with
  // epoch seconds, so normalize both before gateway latency is calculated.
  const milliseconds =
    timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

const ALLOWED_MEDIA_DOMAINS = [
  "blooio.com",
  "backend.blooio.com",
  "api.blooio.com",
  "media.blooio.com",
];

function isValidMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_MEDIA_DOMAINS.some(
      (d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

function extractMediaUrls(
  attachments?: Array<string | { url: string; name?: string | null }> | null,
): string[] {
  if (!attachments) return [];
  return attachments
    .map((a) => (typeof a === "string" ? a : a.url))
    .filter((url) => isValidMediaUrl(url));
}

async function sendBlooioMessage(
  config: WebhookConfig,
  event: ChatEvent,
  text: string,
): Promise<string[]> {
  if (!config.apiKey) throw new Error("Missing apiKey for Blooio reply");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    // This remains stable for both webhook replies and proactive reminder
    // retries, so a lost provider response cannot double-text the user.
    "Idempotency-Key": `gw-reply-${event.messageId}`,
  };

  const from = event.channelId ?? config.fromNumber;
  const body: { to: string; text: string; from?: string } = {
    to: event.senderId,
    text,
  };
  if (from) body.from = from;

  const response = await blooioGatewayFetch(BLOOIO_V4_MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new BlooioApiResponseError(
      response.status,
      `Blooio send error (${response.status}): ${responseText}`,
    );
  }
  if (!responseText) {
    throw new Error("Blooio accepted delivery without a provider receipt");
  }
  let result: unknown;
  try {
    result = JSON.parse(responseText);
  } catch {
    // error-policy:J3 accepted provider responses must still expose a durable
    // message receipt before the scheduler records the occurrence as fired.
    throw new Error("Blooio accepted delivery without a valid JSON receipt");
  }
  if (!result || typeof result !== "object") {
    throw new Error("Blooio accepted delivery without a provider receipt");
  }
  const record = result as Record<string, unknown>;
  const id =
    typeof record.id === "string"
      ? record.id
      : typeof record.message_id === "string"
        ? record.message_id
        : undefined;
  if (!id?.trim()) {
    throw new Error("Blooio accepted delivery without a provider receipt");
  }
  return [id.trim()];
}

// Blooio's documented verification contract rejects deliveries older than
// 300 seconds, and their retry backoff can legitimately land near that edge.
// A tighter local window (this was 120s) silently drops valid retried
// deliveries — a lost inbound message on the exact surface new users arrive
// through. Match the provider's contract, but do not raise this above the
// gateway's 300-second dedup TTL without raising that TTL first.
const SIGNATURE_TOLERANCE_SECONDS = 300;

async function verifySignature(
  secret: string,
  signatureHeader: string,
  rawBody: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;

  try {
    const parts = signatureHeader.split(",");
    const timestampPart = parts.find((p) => p.startsWith("t="));
    const signaturePart = parts.find((p) => p.startsWith("v1="));
    if (!timestampPart || !signaturePart) return false;

    const timestamp = parseInt(timestampPart.substring(2), 10);
    const expectedSignature = signaturePart.substring(3);

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload),
    );
    const computedSignature = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const maxLen = Math.max(computedSignature.length, expectedSignature.length);
    const computedBuf = Buffer.alloc(maxLen);
    const expectedBuf = Buffer.alloc(maxLen);
    Buffer.from(computedSignature, "utf8").copy(computedBuf);
    Buffer.from(expectedSignature, "utf8").copy(expectedBuf);

    return (
      crypto.timingSafeEqual(computedBuf, expectedBuf) &&
      computedSignature.length === expectedSignature.length
    );
  } catch (err) {
    // error-policy:J3 an invalid signature is untrusted input, not a
    // recoverable provider result.
    logger.warn("Blooio signature verification error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const blooioAdapter: PlatformAdapter = {
  platform: "blooio",

  async verifyWebhook(
    request: Request,
    rawBody: string,
    config: WebhookConfig,
  ): Promise<boolean> {
    if (!config.blooioWebhookSecret) {
      logger.warn(
        "Blooio webhook secret not configured — signature verification skipped",
      );
      return false;
    }
    const sig = request.headers.get("x-blooio-signature") ?? "";
    return verifySignature(config.blooioWebhookSecret, sig, rawBody);
  },

  async extractEvent(rawBody: string): Promise<ChatEvent | null> {
    let data: unknown;
    try {
      data = JSON.parse(rawBody);
    } catch {
      // error-policy:J3 malformed webhook JSON is rejected explicitly.
      logger.warn("Failed to parse Blooio webhook payload");
      return null;
    }

    const event = parseWebhookEvent(data);
    if (!event) {
      logger.warn("Invalid Blooio webhook payload");
      return null;
    }

    if (event.event !== "message.received") return null;
    if (event.is_group) return null;

    // Blooio documents message_id as the stable identifier for message
    // deliveries. internal_id is the receiving number and external_id is the
    // sender, so neither can safely deduplicate retries. A delivery without
    // message_id is malformed and must not enter a pipeline whose dedup and
    // outbound idempotency keys both depend on it.
    if (!event.message_id) {
      logger.warn("Blooio event missing stable message id; skipping", {
        sender: event.sender ?? null,
      });
      return null;
    }

    // The schema allows a nullish sender, but an event without one is
    // unroutable: chatId/senderId would be empty strings, identity-resolve
    // would run against an empty platform user id, and sendReply would POST
    // to /chats//messages. Skip it instead of forwarding garbage.
    if (!event.sender) {
      logger.warn("Blooio event missing sender; skipping", {
        messageId: event.message_id,
      });
      return null;
    }

    const text = event.text ?? "";
    if (!text && !event.attachments?.length) return null;

    const mediaUrls = extractMediaUrls(event.attachments);

    return {
      platform: "blooio",
      messageId: event.message_id,
      chatId: event.sender,
      channelId: event.channel_id ?? undefined,
      channelType: event.channel_type ?? undefined,
      protocol: event.protocol ?? undefined,
      senderId: event.sender,
      text:
        mediaUrls.length > 0 && !text
          ? `[media: ${mediaUrls.join(", ")}]`
          : text,
      providerSentAtMs: providerSentAtMs(event),
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      rawPayload: data,
    };
  },

  async sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
  ): Promise<void> {
    await sendBlooioMessage(config, event, text);
  },

  async sendReplyWithReceipt(config, event, text) {
    const providerMessageIds = await sendBlooioMessage(config, event, text);
    if (providerMessageIds.length === 0) {
      throw new Error("Blooio accepted delivery without a message receipt");
    }
    return { providerMessageIds };
  },

  async sendTypingIndicator(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<void> {
    if (!config.apiKey) return;
    try {
      const url = `${BLOOIO_V2_API_BASE}/chats/${encodeURIComponent(event.senderId)}/read`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      };
      if (config.fromNumber) headers["X-From-Number"] = config.fromNumber;

      await blooioGatewayFetch(url, { method: "POST", headers });
    } catch (error) {
      // error-policy:J4 typing is a non-critical UX affordance; a failed
      // indicator is observable but must not fail message delivery.
      logger.warn("Blooio typing indicator failed", {
        error: error instanceof Error ? error.message : String(error),
        messageId: event.messageId,
      });
    }
  },
};
