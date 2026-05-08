// Deprecated LifeOps fallback shim. Canonical WhatsApp messaging should go
// through @elizaos/plugin-whatsapp runtime services; this Cloud API client
// remains for legacy env-token fallback and webhook buffering.
import { logger } from "@elizaos/core";

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
}

export interface WhatsAppMessage {
  id: string;
  from: string;
  channelId: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "document" | "unknown";
  text?: string;
  mediaId?: string;
  metadata?: {
    displayPhoneNumber?: string;
    phoneNumberId?: string;
    contactName?: string;
    waId?: string;
  };
}

export interface WhatsAppSendRequest {
  to: string;
  text: string;
  replyToMessageId?: string;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

const DEFAULT_API_VERSION = "v21.0";
function getWhatsAppBaseUrl(): string {
  return process.env.ELIZA_MOCK_WHATSAPP_BASE ?? "https://graph.facebook.com";
}

export function readWhatsAppCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppCredentials | null {
  const accessToken = (
    env.ELIZA_WHATSAPP_ACCESS_TOKEN ?? env.WHATSAPP_ACCESS_TOKEN
  )?.trim();
  const phoneNumberId = (
    env.ELIZA_WHATSAPP_PHONE_NUMBER_ID ?? env.WHATSAPP_PHONE_NUMBER_ID
  )?.trim();
  if (!accessToken || !phoneNumberId) {
    return null;
  }
  const apiVersion =
    (env.ELIZA_WHATSAPP_API_VERSION ?? env.WHATSAPP_API_VERSION)?.trim() ||
    undefined;
  return {
    accessToken,
    phoneNumberId,
    ...(apiVersion ? { apiVersion } : {}),
  };
}

export async function sendWhatsAppMessage(
  creds: WhatsAppCredentials,
  req: WhatsAppSendRequest,
): Promise<{ ok: true; messageId: string }> {
  const apiVersion = creds.apiVersion ?? DEFAULT_API_VERSION;
  const url = `${getWhatsAppBaseUrl()}/${apiVersion}/${encodeURIComponent(
    creds.phoneNumberId,
  )}/messages`;

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: req.to,
    type: "text",
    text: { body: req.text },
  };
  if (req.replyToMessageId) {
    payload.context = { message_id: req.replyToMessageId };
  }

  // @duplicate-component-audit-allow: WhatsApp Graph API send, not model generation.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });

  const body = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    const errorMessage =
      body.error?.message ??
      `WhatsApp request failed with HTTP ${response.status}`;
    logger.warn(
      {
        boundary: "lifeops",
        integration: "whatsapp",
        operation: "whatsapp_send",
        statusCode: response.status,
      },
      `[lifeops] WhatsApp send failed: ${errorMessage}`,
    );
    throw new WhatsAppError(errorMessage, response.status, body);
  }

  const messageId = body.messages?.[0]?.id;
  if (!messageId) {
    throw new WhatsAppError(
      "WhatsApp response missing message id",
      response.status,
      body,
    );
  }
  return { ok: true, messageId };
}

function mapMessageType(raw: unknown): WhatsAppMessage["type"] {
  if (
    raw === "text" ||
    raw === "image" ||
    raw === "audio" ||
    raw === "document"
  ) {
    return raw;
  }
  return "unknown";
}

function whatsappTimestampToIso(raw: unknown): string | null {
  const value =
    typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Inbound message buffer
// ---------------------------------------------------------------------------
// WhatsApp Business Cloud API provides no "list messages" endpoint — inbound
// messages arrive exclusively via webhook push. This buffer holds the last
// MAX_BUFFER_SIZE messages received via webhook so that the service mixin can
// expose a periodic sync / drain call without re-ingesting duplicates.

const MAX_BUFFER_SIZE = 500;
const inboundBuffer = new Map<string, WhatsAppMessage>();

/**
 * Add messages to the module-level inbound buffer, deduplicating by message id.
 * Oldest entries are evicted when the buffer exceeds {@link MAX_BUFFER_SIZE}.
 *
 * @internal Called automatically by {@link parseAndBufferWhatsAppWebhookMessages}.
 */
function bufferInboundMessages(messages: WhatsAppMessage[]): void {
  for (const message of messages) {
    inboundBuffer.set(message.id, message);
  }
  // Evict oldest entries when over capacity.
  if (inboundBuffer.size > MAX_BUFFER_SIZE) {
    const toDelete = inboundBuffer.size - MAX_BUFFER_SIZE;
    let deleted = 0;
    for (const key of inboundBuffer.keys()) {
      inboundBuffer.delete(key);
      deleted++;
      if (deleted >= toDelete) break;
    }
  }
}

/**
 * Parse a raw WhatsApp webhook payload, buffer the resulting messages for
 * periodic drain by {@link drainWhatsAppInboundBuffer}, and return the parsed
 * messages.
 */
export function parseAndBufferWhatsAppWebhookMessages(
  payload: unknown,
): WhatsAppMessage[] {
  const messages = parseWhatsAppWebhookMessages(payload);
  if (messages.length > 0) {
    bufferInboundMessages(messages);
  }
  return messages;
}

/**
 * Drain all buffered inbound messages and clear the buffer.
 * Used by {@link syncWhatsAppInbound} in the service mixin to implement
 * periodic pull semantics on top of the webhook-only inbound path.
 */
export function drainWhatsAppInboundBuffer(): WhatsAppMessage[] {
  const messages = [...inboundBuffer.values()];
  inboundBuffer.clear();
  return messages;
}

/**
 * Peek at buffered messages without clearing the buffer.
 * Useful for status checks.
 */
export function peekWhatsAppInboundBuffer(): WhatsAppMessage[] {
  return [...inboundBuffer.values()];
}

export function parseWhatsAppWebhookMessages(
  payload: unknown,
): WhatsAppMessage[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) {
    return [];
  }

  const messages: WhatsAppMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const webhookValue = value as {
        metadata?: {
          display_phone_number?: unknown;
          phone_number_id?: unknown;
        };
        contacts?: unknown;
        messages?: unknown;
      };
      const rawContacts = webhookValue.contacts;
      const contactByWaId = new Map<string, { name?: string; waId?: string }>();
      if (Array.isArray(rawContacts)) {
        for (const contact of rawContacts) {
          if (!contact || typeof contact !== "object") continue;
          const c = contact as {
            profile?: { name?: unknown };
            wa_id?: unknown;
          };
          const waId = optionalString(c.wa_id);
          if (!waId) continue;
          contactByWaId.set(waId, {
            name: optionalString(c.profile?.name),
            waId,
          });
        }
      }
      const displayPhoneNumber = optionalString(
        webhookValue.metadata?.display_phone_number,
      );
      const phoneNumberId = optionalString(
        webhookValue.metadata?.phone_number_id,
      );
      const rawMessages = (value as { messages?: unknown }).messages;
      if (!Array.isArray(rawMessages)) continue;
      for (const msg of rawMessages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as {
          id?: unknown;
          from?: unknown;
          timestamp?: unknown;
          type?: unknown;
          text?: { body?: unknown };
          image?: { id?: unknown };
          audio?: { id?: unknown };
          document?: { id?: unknown };
        };
        if (typeof m.id !== "string" || typeof m.from !== "string") continue;
        const isoTimestamp = whatsappTimestampToIso(m.timestamp);
        if (!isoTimestamp) continue;

        const type = mapMessageType(m.type);
        const text =
          type === "text" && typeof m.text?.body === "string"
            ? m.text.body
            : undefined;
        const mediaId =
          type === "image" && typeof m.image?.id === "string"
            ? m.image.id
            : type === "audio" && typeof m.audio?.id === "string"
              ? m.audio.id
              : type === "document" && typeof m.document?.id === "string"
                ? m.document.id
                : undefined;
        const contact = contactByWaId.get(m.from);
        const metadata = {
          ...(displayPhoneNumber ? { displayPhoneNumber } : {}),
          ...(phoneNumberId ? { phoneNumberId } : {}),
          ...(contact?.name ? { contactName: contact.name } : {}),
          ...(contact?.waId ? { waId: contact.waId } : {}),
        };

        messages.push({
          id: m.id,
          from: m.from,
          channelId: m.from,
          timestamp: isoTimestamp,
          type,
          ...(text !== undefined ? { text } : {}),
          ...(mediaId !== undefined ? { mediaId } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
      }
    }
  }

  return messages;
}
