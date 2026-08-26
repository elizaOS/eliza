/**
 * Blooio API Utilities
 *
 * Shared constants and helpers for Blooio iMessage/SMS API interactions.
 */

import { ElizaError } from "@elizaos/core/edge";
import crypto from "crypto";
import { z } from "zod";
import { ownedBoundedFetch } from "./owned-bounded-fetch";

export const BLOOIO_API_BASE = "https://api.blooio.com/v2/api";
export const BLOOIO_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound every Blooio REST hop while preserving caller cancellation.
 */
export async function blooioFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = BLOOIO_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return ownedBoundedFetch(input, init, { timeoutMs });
}

export interface BlooioSendMessageRequest {
  text?: string;
  attachments?: Array<string | { url: string; name?: string }>;
  metadata?: Record<string, unknown>;
  use_typing_indicator?: boolean;
  fromNumber?: string;
  idempotencyKey?: string;
}

export interface BlooioSendMessageResponse {
  message_id?: string;
  message_ids?: string[];
  status?: string;
}

export interface BlooioMarkReadResponse {
  success?: boolean;
}

export interface BlooioWebhookEvent {
  event: string;
  message_id?: string | null;
  external_id?: string | null;
  internal_id?: string | null;
  sender?: string | null;
  text?: string | null;
  attachments?: Array<string | { url: string; name?: string | null }> | null;
  protocol?: string | null;
  is_group?: boolean | null;
  received_at?: number | null;
  timestamp?: number | null;
}

/**
 * Zod schema for validating Blooio webhook payloads
 * Prevents malformed data from causing runtime errors
 *
 * Uses .nullish() instead of .optional() because Blooio sends explicit null
 * values for absent fields (e.g., "text": null instead of omitting the field)
 */
const BlooioAttachmentSchema = z.union([
  z.string(),
  z
    .object({
      url: z.string().url(),
      name: z.string().nullish(),
    })
    .passthrough(),
]);

export const BlooioWebhookEventSchema = z.object({
  event: z.string().min(1, "Event type is required"),
  message_id: z.string().nullish(),
  external_id: z.string().nullish(),
  internal_id: z.string().nullish(),
  sender: z.string().nullish(),
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
    sender: z.string().trim().min(1).nullish(),
    recipient: z.string().nullish(),
    channel_address: z.string().nullish(),
    contact: z.object({ identifier: z.string().trim().min(1).nullish() }).nullish(),
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

/**
 * Parse and validate a Blooio webhook payload
 * Returns the validated payload or throws a ZodError
 */
export function parseBlooioWebhookEvent(data: unknown): BlooioWebhookEvent {
  const v2 = BlooioWebhookEventSchema.safeParse(data);
  if (v2.success) return v2.data;

  const envelope = BlooioV4WebhookEnvelopeSchema.parse(data);
  const message = envelope.data;
  const sender = message.sender ?? message.contact?.identifier ?? null;

  return {
    event: envelope.type,
    message_id: message.message_id ?? message.id,
    external_id: sender,
    internal_id: message.recipient ?? message.channel_address,
    sender,
    text: message.text,
    attachments: message.attachments,
    protocol: message.protocol,
    is_group: message.is_group ?? message.group != null,
    received_at: envelope.created_at,
    timestamp: envelope.created_at,
  };
}

/**
 * Make a Blooio API request
 */
export async function blooioApiRequest<T>(
  apiKey: string,
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
  options?: {
    fromNumber?: string;
    idempotencyKey?: string;
  },
): Promise<T> {
  const url = `${BLOOIO_API_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (options?.fromNumber) {
    headers["X-From-Number"] = options.fromNumber;
  }

  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await blooioFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new ElizaError("Blooio rejected the provider request", {
      code: "PROVIDER_REQUEST_REJECTED",
      context: {
        provider: "blooio",
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    });
  }

  if (!responseText) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (cause) {
    throw new ElizaError("Blooio accepted the request without a valid receipt", {
      code: "PROVIDER_RECEIPT_INVALID",
      context: { provider: "blooio" },
      cause,
    });
  }
}

/**
 * Verify Blooio webhook signature
 *
 * Blooio uses HMAC-SHA256 with the webhook secret.
 * Signature format: t=timestamp,v1=signature
 */
export async function verifyBlooioSignature(
  webhookSecret: string,
  signatureHeader: string,
  rawBody: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signatureHeader || !webhookSecret) {
    return false;
  }

  try {
    // Parse signature header: t=timestamp,v1=signature
    const parts = signatureHeader.split(",");
    const timestampPart = parts.find((p) => p.startsWith("t="));
    const signaturePart = parts.find((p): p is string => p.startsWith("v1="));

    if (!timestampPart || !signaturePart) {
      return false;
    }

    const timestamp = Number.parseInt(timestampPart.substring(2), 10);
    const expectedSignature = signaturePart.substring(3);

    // Check timestamp tolerance
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }

    // Compute HMAC-SHA256 signature
    const signedPayload = `${timestamp}.${rawBody}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const computedSignature = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Use constant-time comparison to prevent timing attacks
    // Pad both strings to the same length to avoid timing leaks from length differences
    const maxLen = Math.max(computedSignature.length, expectedSignature.length);
    const computedBuffer = Buffer.alloc(maxLen);
    const expectedBuffer = Buffer.alloc(maxLen);
    Buffer.from(computedSignature, "utf8").copy(computedBuffer);
    Buffer.from(expectedSignature, "utf8").copy(expectedBuffer);

    // timingSafeEqual requires same length buffers - we've ensured this above
    // Also verify actual lengths match (after constant-time comparison)
    const signaturesMatch = crypto.timingSafeEqual(computedBuffer, expectedBuffer);
    const lengthsMatch = computedSignature.length === expectedSignature.length;
    return signaturesMatch && lengthsMatch;
  } catch {
    return false;
  }
}

/**
 * Validate E.164 phone number format
 */
export function isE164(phoneNumber: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(phoneNumber);
}

/**
 * Allowed media URL domains for Blooio to prevent SSRF attacks.
 * Only URLs from these domains will be accepted.
 */
const ALLOWED_BLOOIO_MEDIA_DOMAINS = [
  "blooio.com",
  "backend.blooio.com",
  "api.blooio.com",
  "media.blooio.com",
  "s3.amazonaws.com", // Blooio may use S3 for media storage
];

/**
 * Validate that a Blooio media URL is from a trusted domain.
 * Prevents SSRF attacks via malicious URLs in webhook payloads.
 */
export function isValidBlooioMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Must be HTTPS
    if (parsed.protocol !== "https:") {
      return false;
    }
    // Must be from allowed domain
    return ALLOWED_BLOOIO_MEDIA_DOMAINS.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/**
 * Extract and validate media URLs from Blooio webhook attachments.
 * Only returns URLs from trusted domains to prevent SSRF.
 */
export function extractBlooioMediaUrls(
  attachments?: Array<string | { url: string; name?: string | null }> | null,
): string[] {
  if (!attachments || !Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((a) => (typeof a === "string" ? a : a.url))
    .filter((url): url is string => typeof url === "string" && isValidBlooioMediaUrl(url));
}

/**
 * Mark a chat as read in Blooio.
 * Sends a read receipt to the sender for better UX.
 */
export async function markChatAsRead(
  apiKey: string,
  chatId: string,
  options?: { fromNumber?: string },
): Promise<void> {
  await blooioApiRequest<BlooioMarkReadResponse>(
    apiKey,
    "POST",
    `/chats/${encodeURIComponent(chatId)}/read`,
    undefined,
    { fromNumber: options?.fromNumber },
  );
}

/**
 * Validate chat ID format
 * Accepts: E.164 phone numbers, email addresses, or group IDs (grp_*)
 */
export function validateBlooioChatId(chatId: string): boolean {
  if (!chatId || typeof chatId !== "string") {
    return false;
  }

  const parts = chatId
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return false;
  }

  return parts.every((part) => {
    // E.164 phone number
    if (isE164(part)) return true;
    // Email address
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) return true;
    // Group ID
    if (part.startsWith("grp_")) return true;
    return false;
  });
}
