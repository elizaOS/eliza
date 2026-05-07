import { applyMarkup } from "@elizaos/billing";
import crypto from "crypto";
import { z } from "zod";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * Raw Twilio SMS cost per outbound segment (USD). Used as the passthrough
 * base that we mark up for user billing.
 *
 * Overridable via `TWILIO_SMS_COST_PER_SEGMENT_USD` when Twilio adjusts its
 * pricing or for per-region rates.
 */
const DEFAULT_SMS_COST_PER_SEGMENT_USD = 0.0075;
const SMS_SEGMENT_CHAR_LIMIT = 160;

function resolveSmsCostPerSegment(): number {
  const raw = process.env.TWILIO_SMS_COST_PER_SEGMENT_USD;
  if (!raw) return DEFAULT_SMS_COST_PER_SEGMENT_USD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn("Invalid TWILIO_SMS_COST_PER_SEGMENT_USD; falling back to default", {
      raw,
    });
    return DEFAULT_SMS_COST_PER_SEGMENT_USD;
  }
  return parsed;
}

function estimateSmsSegments(text: string): number {
  if (text.length === 0) return 1;
  return Math.ceil(text.length / SMS_SEGMENT_CHAR_LIMIT);
}

const TwilioWebhookEventSchema = z
  .object({
    MessageSid: z.string().min(1),
    AccountSid: z.string().min(1),
    From: z.string().min(1),
    To: z.string().min(1),
    Body: z.string().optional(),
    NumMedia: z.string().optional(),
    MediaUrl0: z.string().optional(),
    MediaUrl1: z.string().optional(),
    MediaUrl2: z.string().optional(),
  })
  .passthrough();

type TwilioEvent = z.infer<typeof TwilioWebhookEventSchema>;

const ALLOWED_MEDIA_DOMAINS = ["api.twilio.com", "media.twiliocdn.com"];

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

function extractMediaUrls(event: TwilioEvent): string[] {
  const urls: string[] = [];
  const numMedia = parseInt(event.NumMedia || "0", 10);
  for (let i = 0; i < numMedia; i++) {
    const url = (event as Record<string, unknown>)[`MediaUrl${i}`];
    if (typeof url === "string" && isValidMediaUrl(url)) {
      urls.push(url);
    }
  }
  return urls;
}

async function verifySignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!signature || !authToken) return false;

  try {
    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key]}`)
      .join("");

    const data = url + sortedParams;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    const maxLen = Math.max(computedSignature.length, signature.length);
    const computedBuf = Buffer.alloc(maxLen);
    const expectedBuf = Buffer.alloc(maxLen);
    Buffer.from(computedSignature, "utf8").copy(computedBuf);
    Buffer.from(signature, "utf8").copy(expectedBuf);

    return (
      crypto.timingSafeEqual(computedBuf, expectedBuf) &&
      computedSignature.length === signature.length
    );
  } catch (err) {
    logger.warn("Twilio signature verification error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const twilioAdapter: PlatformAdapter = {
  platform: "twilio",

  async verifyWebhook(request: Request, rawBody: string, config: WebhookConfig): Promise<boolean> {
    if (!config.authToken) {
      logger.warn("Twilio auth token not configured — signature verification skipped");
      return false;
    }

    const sig = request.headers.get("x-twilio-signature") ?? "";

    // Reconstruct the public URL Twilio signed against.
    // Behind a reverse proxy/ingress, request.url has the internal pod URL,
    // not the external URL Twilio used. Use X-Forwarded-* or PUBLIC_URL to fix.
    const url = new URL(request.url);
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const forwardedHost = request.headers.get("x-forwarded-host");
    if (forwardedProto) url.protocol = `${forwardedProto}:`;
    if (forwardedHost) url.host = forwardedHost;
    if (process.env.TWILIO_PUBLIC_URL) {
      const publicBase = new URL(process.env.TWILIO_PUBLIC_URL);
      url.protocol = publicBase.protocol;
      url.host = publicBase.host;
    }
    const fullUrl = url.toString();

    // Parse form data into params
    const params: Record<string, string> = {};
    const searchParams = new URLSearchParams(rawBody);
    for (const [key, value] of searchParams) {
      params[key] = value;
    }

    return verifySignature(config.authToken, sig, fullUrl, params);
  },

  async extractEvent(rawBody: string): Promise<ChatEvent | null> {
    const params: Record<string, string> = {};
    const searchParams = new URLSearchParams(rawBody);
    for (const [key, value] of searchParams) {
      params[key] = value;
    }

    const parsed = TwilioWebhookEventSchema.safeParse(params);
    if (!parsed.success) {
      logger.warn("Invalid Twilio webhook payload", {
        errors: parsed.error.format(),
      });
      return null;
    }

    const event = parsed.data;
    const text = event.Body ?? "";
    const mediaUrls = extractMediaUrls(event);

    if (!text && mediaUrls.length === 0) return null;

    return {
      platform: "twilio",
      messageId: event.MessageSid,
      chatId: event.From,
      senderId: event.From,
      text: mediaUrls.length > 0 && !text ? `[media: ${mediaUrls.join(", ")}]` : text,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      rawPayload: params,
    };
  },

  async sendReply(config: WebhookConfig, event: ChatEvent, text: string): Promise<void> {
    if (!config.accountSid || !config.authToken || !config.phoneNumber) {
      throw new Error("Missing Twilio credentials for reply");
    }

    const url = `${TWILIO_API_BASE}/Accounts/${config.accountSid}/Messages.json`;
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");

    const body = new URLSearchParams({
      To: event.senderId,
      From: config.phoneNumber,
      Body: text,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twilio send error (${response.status}): ${errorText}`);
    }

    // Record the passthrough cost with the platform markup so downstream
    // billing persisters can read a single structured line and insert the
    // usage record. This is the integration point T9d unblocks.
    const segments = estimateSmsSegments(text);
    const rawCost = segments * resolveSmsCostPerSegment();
    const breakdown = applyMarkup(rawCost);
    logger.info("[TwilioAdapter] Outbound SMS cost recorded", {
      platform: "twilio",
      messageId: event.messageId,
      recipient: event.senderId,
      segments,
      rawCost: breakdown.rawCost,
      markup: breakdown.markup,
      billedCost: breakdown.billedCost,
      markupRate: breakdown.markupRate,
    });
  },

  async sendTypingIndicator(): Promise<void> {
    // Twilio has no typing indicator API for SMS/WhatsApp
  },
};
