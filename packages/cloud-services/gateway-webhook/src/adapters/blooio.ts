import crypto from "crypto";
import { z } from "zod";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

const BLOOIO_API_BASE = "https://backend.blooio.com/v2/api";

const BlooioWebhookEventSchema = z.object({
  event: z.string().min(1),
  message_id: z.string().nullish(),
  external_id: z.string().nullish(),
  internal_id: z.string().nullish(),
  sender: z.string().nullish(),
  text: z.string().nullish(),
  attachments: z
    .array(z.union([z.string(), z.object({ url: z.string().url(), name: z.string().nullish() })]))
    .nullish(),
  protocol: z.string().nullish(),
  is_group: z.boolean().nullish(),
  received_at: z.number().nullish(),
  timestamp: z.number().nullish(),
});

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
    if (Math.abs(now - timestamp) > 120) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
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
    logger.warn("Blooio signature verification error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const blooioAdapter: PlatformAdapter = {
  platform: "blooio",

  async verifyWebhook(request: Request, rawBody: string, config: WebhookConfig): Promise<boolean> {
    if (!config.blooioWebhookSecret) {
      logger.warn("Blooio webhook secret not configured — signature verification skipped");
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
      logger.warn("Failed to parse Blooio webhook payload");
      return null;
    }

    const parsed = BlooioWebhookEventSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn("Invalid Blooio webhook payload", {
        errors: parsed.error.format(),
      });
      return null;
    }

    const event = parsed.data;

    if (event.event !== "message.received") return null;
    if (event.is_group) return null;

    const text = event.text ?? "";
    if (!text && !event.attachments?.length) return null;

    const mediaUrls = extractMediaUrls(event.attachments);

    return {
      platform: "blooio",
      messageId: event.message_id ?? event.internal_id ?? `${Date.now()}`,
      chatId: event.sender ?? "",
      senderId: event.sender ?? "",
      text: mediaUrls.length > 0 && !text ? `[media: ${mediaUrls.join(", ")}]` : text,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      rawPayload: data,
    };
  },

  async sendReply(config: WebhookConfig, event: ChatEvent, text: string): Promise<void> {
    if (!config.apiKey) throw new Error("Missing apiKey for Blooio reply");

    const url = `${BLOOIO_API_BASE}/chats/${encodeURIComponent(event.senderId)}/messages`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
    if (config.fromNumber) headers["X-From-Number"] = config.fromNumber;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Blooio send error (${response.status}): ${errorText}`);
    }
  },

  async sendTypingIndicator(config: WebhookConfig, event: ChatEvent): Promise<void> {
    if (!config.apiKey) return;
    try {
      const url = `${BLOOIO_API_BASE}/chats/${encodeURIComponent(event.senderId)}/read`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      };
      if (config.fromNumber) headers["X-From-Number"] = config.fromNumber;

      await fetch(url, { method: "POST", headers });
    } catch {
      // non-critical UX feature
    }
  },
};
