/**
 * Authenticates Blooio webhook fan-in and maps stable one-to-one message
 * deliveries onto the gateway's deduplicated chat contract.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

const BLOOIO_API_BASE = "https://api.blooio.com/v2/api";
const BLOOIO_V4_API_BASE = "https://api.blooio.com/v4/api";

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

type BlooioWebhookEvent = z.infer<typeof BlooioV2WebhookEventSchema> & {
  channel_id?: string | null;
  channel_type?: string | null;
};

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
    text: message.text,
    attachments: message.attachments,
    protocol: message.protocol,
    is_group: message.is_group ?? message.group != null,
    received_at: v4.data.created_at,
    timestamp: v4.data.created_at,
    channel_id: message.channel_id,
    channel_type: message.channel_type,
  };
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

    // Blooio v4 envelopes carry channel_id and channel_type on the message
    // data; legacy v2 deliveries never do. When present, the channel metadata
    // lets sendReply route to the v4 channel-aware message endpoint so the
    // outbound reply is pinned to the exact inbound channel (e.g. a WhatsApp
    // channel instead of the default iMessage/SMS channel).
    const channelId = event.channel_id ?? undefined;
    const channelType = event.channel_type ?? undefined;

    return {
      platform: "blooio",
      messageId: event.message_id,
      chatId: event.sender,
      senderId: event.sender,
      text:
        mediaUrls.length > 0 && !text
          ? `[media: ${mediaUrls.join(", ")}]`
          : text,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      channelId,
      channelType,
      rawPayload: data,
    };
  },

  async sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
  ): Promise<void> {
    if (!config.apiKey) throw new Error("Missing apiKey for Blooio reply");

    // When the inbound v4 envelope carried a channel_id, reply through the v4
    // channel-aware endpoint so the message is pinned to the exact channel
    // that delivered the inbound. Legacy v2 deliveries and v4 deliveries
    // without a channel_id fall back to the v2 chat-scoped endpoint.
    const { channelId } = event;
    const url =
      channelId != null
        ? `${BLOOIO_V4_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`
        : `${BLOOIO_API_BASE}/chats/${encodeURIComponent(event.senderId)}/messages`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      // The gateway dedup key guarantees at most one reply per inbound
      // message, so the inbound messageId is a stable idempotency scope: a
      // send that times out client-side after Blooio accepted it must not
      // double-text the user when retried.
      "Idempotency-Key": `gw-reply-${event.messageId}`,
    };
    if (config.fromNumber) headers["X-From-Number"] = config.fromNumber;

    const body =
      channelId != null
        ? JSON.stringify({
            text,
            channel_id: channelId,
            ...(event.channelType ? { channel_type: event.channelType } : {}),
          })
        : JSON.stringify({ text });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Blooio send error (${response.status}): ${errorText}`);
    }
  },

  async sendTypingIndicator(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<void> {
    if (!config.apiKey) return;
    try {
      const { channelId } = event;
      const url =
        channelId != null
          ? `${BLOOIO_V4_API_BASE}/channels/${encodeURIComponent(channelId)}/read`
          : `${BLOOIO_API_BASE}/chats/${encodeURIComponent(event.senderId)}/read`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      };
      if (config.fromNumber) headers["X-From-Number"] = config.fromNumber;

      await fetch(url, { method: "POST", headers });
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
