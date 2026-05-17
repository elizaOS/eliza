/**
 * WhatsApp Cloud API Utilities
 *
 * Shared constants and helpers for WhatsApp Business Cloud API interactions.
 * Handles webhook signature verification, message sending, and payload parsing.
 */

import crypto from "crypto";
import { z } from "zod";
import { logger } from "./logger";

export const WHATSAPP_API_BASE = "https://graph.facebook.com/v21.0";
const WHATSAPP_REQUEST_TIMEOUT_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

export interface WhatsAppSendMessageRequest {
  messaging_product: "whatsapp";
  recipient_type?: "individual";
  to: string;
  type: "text" | "image" | "document" | "audio" | "video";
  text?: { body: string };
  image?: { link: string; caption?: string };
  document?: { link: string; caption?: string; filename?: string };
  audio?: { link: string };
  video?: { link: string; caption?: string };
}

// Zod schema for send-message API response validation
const WhatsAppSendMessageResponseSchema = z.object({
  messaging_product: z.string(),
  contacts: z.array(z.object({ input: z.string(), wa_id: z.string() })),
  messages: z.array(z.object({ id: z.string(), message_status: z.string().optional() })),
});

export type WhatsAppSendMessageResponse = z.infer<typeof WhatsAppSendMessageResponseSchema>;

export interface WhatsAppMarkReadRequest {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
}

/** A single message extracted from the webhook payload */
export interface WhatsAppIncomingMessage {
  messageId: string;
  from: string; // WhatsApp ID (digits only, e.g. "14245074963")
  timestamp: string;
  type: string;
  text?: string;
  profileName?: string;
  phoneNumberId: string; // The business phone number ID that received the message
}

// ============================================================================
// Webhook Payload Schemas (Zod)
// ============================================================================

const WhatsAppWebhookMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: z
    .object({
      id: z.string(),
      mime_type: z.string().optional(),
      sha256: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
});

const WhatsAppWebhookContactSchema = z.object({
  profile: z.object({ name: z.string() }),
  wa_id: z.string(),
});

const WhatsAppWebhookValueSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({
    display_phone_number: z.string(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(WhatsAppWebhookContactSchema).optional(),
  messages: z.array(WhatsAppWebhookMessageSchema).optional(),
  statuses: z
    .array(
      z.object({
        id: z.string(),
        status: z.string(),
        timestamp: z.string(),
        recipient_id: z.string(),
      }),
    )
    .optional(),
});

const WhatsAppWebhookChangeSchema = z.object({
  value: WhatsAppWebhookValueSchema,
  field: z.string(),
});

const WhatsAppWebhookEntrySchema = z.object({
  id: z.string(),
  changes: z.array(WhatsAppWebhookChangeSchema),
});

export const WhatsAppWebhookPayloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(WhatsAppWebhookEntrySchema),
});

export type WhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookPayloadSchema>;

// ============================================================================
// Webhook Signature Verification
// ============================================================================

/**
 * Verify WhatsApp webhook signature (X-Hub-Signature-256).
 *
 * Meta signs webhook payloads using HMAC-SHA256 with the App Secret.
 * The signature is in the format: sha256=<hex_signature>
 */
export function verifyWhatsAppSignature(
  appSecret: string,
  signatureHeader: string,
  rawBody: string,
): boolean {
  if (!signatureHeader || !appSecret || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  try {
    // Signature format: sha256=<hex_signature>
    const expectedSignature = signatureHeader.replace("sha256=", "");

    // Compute HMAC-SHA256
    const computedSignature = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

    // Use constant-time comparison to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const computedBuffer = Buffer.from(computedSignature, "hex");

    if (expectedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
  } catch {
    return false;
  }
}

// ============================================================================
// Payload Parsing
// ============================================================================

/**
 * Parse and validate a WhatsApp webhook payload.
 * Returns the validated payload or throws a ZodError.
 */
export function parseWhatsAppWebhookPayload(data: unknown): WhatsAppWebhookPayload {
  return WhatsAppWebhookPayloadSchema.parse(data);
}

/**
 * Extract incoming messages from a parsed WhatsApp webhook payload.
 * Returns an array of simplified message objects.
 */
export function extractWhatsAppMessages(
  payload: WhatsAppWebhookPayload,
): WhatsAppIncomingMessage[] {
  const messages: WhatsAppIncomingMessage[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;

      const { value } = change;
      if (!value.messages) continue;

      const contactMap = new Map<string, string>();
      if (value.contacts) {
        for (const contact of value.contacts) {
          contactMap.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const msg of value.messages) {
        messages.push({
          messageId: msg.id,
          from: msg.from,
          timestamp: msg.timestamp,
          type: msg.type,
          text: msg.text?.body,
          profileName: contactMap.get(msg.from),
          phoneNumberId: value.metadata.phone_number_id,
        });
      }
    }
  }

  return messages;
}

// ============================================================================
// Message Sending
// ============================================================================

/**
 * Send a text message via WhatsApp Cloud API.
 */
export async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<WhatsAppSendMessageResponse> {
  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

  const body: WhatsAppSendMessageRequest = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`WhatsApp API error (${response.status}): ${responseText}`);
  }

  try {
    const parsed = JSON.parse(responseText);
    return WhatsAppSendMessageResponseSchema.parse(parsed);
  } catch (parseError) {
    if (parseError instanceof z.ZodError) {
      throw new Error(
        `Unexpected WhatsApp API response shape: ${parseError.message} (raw: ${responseText.slice(0, 200)})`,
      );
    }
    throw new Error(`Invalid JSON response from WhatsApp: ${responseText}`);
  }
}

/**
 * Mark a message as read via WhatsApp Cloud API.
 */
export async function markWhatsAppMessageAsRead(
  accessToken: string,
  phoneNumberId: string,
  messageId: string,
): Promise<void> {
  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

  const body: WhatsAppMarkReadRequest = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp mark-read error (${response.status}): ${errorText}`);
  }
}

// ============================================================================
// Typing Indicators
// ============================================================================

/**
 * Send a typing indicator via WhatsApp Cloud API.
 *
 * Piggybacks on the mark-as-read endpoint with a `typing_indicator` field.
 * The indicator auto-dismisses after 25 seconds or when a response is sent.
 * Non-critical; failures are logged at debug level but never throw.
 */
export async function sendWhatsAppTypingIndicator(
  accessToken: string,
  phoneNumberId: string,
  messageId: string,
): Promise<void> {
  if (!accessToken || !phoneNumberId) return;

  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.debug("[WhatsApp] Failed to send typing indicator", {
      phoneNumberId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Start a periodic typing indicator that auto-refreshes every 20 seconds.
 * Returns a cleanup function to stop the interval.
 * WhatsApp clears typing after 25s, so we refresh at 20s to maintain continuity.
 */
export function startWhatsAppTypingIndicator(
  accessToken: string,
  phoneNumberId: string,
  messageId: string,
): () => void {
  sendWhatsAppTypingIndicator(accessToken, phoneNumberId, messageId);
  const interval = setInterval(
    () => sendWhatsAppTypingIndicator(accessToken, phoneNumberId, messageId),
    20_000,
  );
  return () => clearInterval(interval);
}

// ============================================================================
// Phone Number Utilities
// ============================================================================

/**
 * Convert a WhatsApp ID (digits only) to E.164 format.
 * WhatsApp IDs are phone numbers without the "+" prefix.
 * e.g., "14245074963" -> "+14245074963"
 */
export function whatsappIdToE164(whatsappId: string): string {
  const digits = whatsappId.replace(/\D/g, "");
  return `+${digits}`;
}

/**
 * Convert an E.164 phone number to WhatsApp ID format.
 * e.g., "+14245074963" -> "14245074963"
 */
export function e164ToWhatsappId(phoneNumber: string): string {
  return phoneNumber.replace(/^\+/, "").replace(/\D/g, "");
}

/**
 * Validate that a string looks like a WhatsApp ID (digits only, 7-15 chars).
 */
export function isValidWhatsAppId(id: string): boolean {
  return /^\d{7,15}$/.test(id);
}
