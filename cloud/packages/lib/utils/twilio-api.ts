/**
 * Twilio API Utilities
 *
 * Shared constants and helpers for Twilio SMS/MMS/Voice API interactions.
 */

import crypto from "crypto";
import { z } from "zod";

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface TwilioSendMessageRequest {
  to: string;
  body?: string;
  mediaUrl?: string[];
  statusCallback?: string;
}

export interface TwilioSendMessageResponse {
  sid: string;
  status: string;
  to: string;
  from: string;
  body?: string;
  date_created: string;
  error_code?: string;
  error_message?: string;
}

export interface TwilioWebhookEvent {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaUrl1?: string;
  MediaUrl2?: string;
  MediaContentType0?: string;
  MediaContentType1?: string;
  MediaContentType2?: string;
  FromCity?: string;
  FromState?: string;
  FromCountry?: string;
  FromZip?: string;
}

/**
 * Zod schema for validating Twilio webhook payloads
 * Twilio sends form data which is converted to an object
 */
export const TwilioWebhookEventSchema = z
  .object({
    MessageSid: z.string().min(1, "MessageSid is required"),
    AccountSid: z.string().min(1, "AccountSid is required"),
    From: z.string().min(1, "From is required"),
    To: z.string().min(1, "To is required"),
    Body: z.string().optional(),
    NumMedia: z.string().optional(),
    MediaUrl0: z.string().optional(),
    MediaUrl1: z.string().optional(),
    MediaUrl2: z.string().optional(),
    MediaContentType0: z.string().optional(),
    MediaContentType1: z.string().optional(),
    MediaContentType2: z.string().optional(),
    FromCity: z.string().optional(),
    FromState: z.string().optional(),
    FromCountry: z.string().optional(),
    FromZip: z.string().optional(),
  })
  .passthrough(); // Allow additional fields Twilio might send

/**
 * Parse and validate a Twilio webhook payload
 * Returns the validated payload or throws a ZodError
 */
export function parseTwilioWebhookEvent(data: unknown): TwilioWebhookEvent {
  return TwilioWebhookEventSchema.parse(data) as TwilioWebhookEvent;
}

/**
 * Make a Twilio API request
 */
export async function twilioApiRequest<T>(
  accountSid: string,
  authToken: string,
  method: string,
  endpoint: string,
  body?: URLSearchParams,
): Promise<T> {
  const url = `${TWILIO_API_BASE}/Accounts/${accountSid}${endpoint}`;

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body?.toString(),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Twilio API error (${response.status}): ${responseText}`);
  }

  if (!responseText) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new Error(`Invalid JSON response from Twilio: ${responseText}`);
  }
}

/**
 * Verify Twilio webhook signature
 *
 * Twilio uses HMAC-SHA1 signature verification.
 */
export async function verifyTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!signature || !authToken) {
    return false;
  }

  try {
    // Sort params alphabetically and concatenate
    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key]}`)
      .join("");

    const data = url + sortedParams;

    // Compute HMAC-SHA1 signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(data));

    // Convert to base64
    const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    // Use constant-time comparison to prevent timing attacks
    // Pad both strings to the same length to avoid timing leaks from length differences
    const maxLen = Math.max(computedSignature.length, signature.length);
    const computedBuffer = Buffer.alloc(maxLen);
    const expectedBuffer = Buffer.alloc(maxLen);
    Buffer.from(computedSignature, "utf8").copy(computedBuffer);
    Buffer.from(signature, "utf8").copy(expectedBuffer);

    // timingSafeEqual requires same length buffers - we've ensured this above
    // Also verify actual lengths match (after constant-time comparison)
    const signaturesMatch = crypto.timingSafeEqual(computedBuffer, expectedBuffer);
    const lengthsMatch = computedSignature.length === signature.length;
    return signaturesMatch && lengthsMatch;
  } catch {
    return false;
  }
}

/**
 * Validate E.164 phone number format
 */
export function isE164PhoneNumber(phoneNumber: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(phoneNumber);
}

/**
 * Allowed media URL domains to prevent SSRF attacks.
 * Only URLs from these domains will be accepted.
 */
const ALLOWED_MEDIA_DOMAINS = [
  "api.twilio.com",
  "media.twiliocdn.com",
  "s3.amazonaws.com", // Twilio sometimes uses S3
  "s3-external-1.amazonaws.com",
];

/**
 * Validate that a media URL is from a trusted domain.
 * Prevents SSRF attacks via malicious URLs in webhook payloads.
 */
export function isValidMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Must be HTTPS
    if (parsed.protocol !== "https:") {
      return false;
    }
    // Must be from allowed domain
    return ALLOWED_MEDIA_DOMAINS.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/**
 * Extract media URLs from Twilio webhook event.
 * Only returns URLs from trusted domains to prevent SSRF.
 */
export function extractMediaUrls(event: TwilioWebhookEvent): string[] {
  const urls: string[] = [];
  const numMedia = Number.parseInt(event.NumMedia || "0", 10);

  for (let i = 0; i < numMedia; i++) {
    const urlKey = `MediaUrl${i}` as keyof TwilioWebhookEvent;
    const url = event[urlKey];
    if (url && typeof url === "string" && isValidMediaUrl(url)) {
      urls.push(url);
    }
  }

  return urls;
}
