import { logger } from "@elizaos/core";

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
}

export interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "document" | "unknown";
  text?: string;
  mediaId?: string;
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

export function readWhatsAppCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppCredentials | null {
  const accessToken = env.ELIZA_WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.ELIZA_WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!accessToken || !phoneNumberId) {
    return null;
  }
  const apiVersion = env.ELIZA_WHATSAPP_API_VERSION?.trim() || undefined;
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
  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}/messages`;

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: req.to,
    type: "text",
    text: { body: req.text },
  };
  if (req.replyToMessageId) {
    payload.context = { message_id: req.replyToMessageId };
  }

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
      body.error?.message ?? `WhatsApp request failed with HTTP ${response.status}`;
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
  if (raw === "text" || raw === "image" || raw === "audio" || raw === "document") {
    return raw;
  }
  return "unknown";
}

export function parseWhatsAppWebhookMessages(payload: unknown): WhatsAppMessage[] {
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

        // WhatsApp timestamps are unix seconds as string; convert to ISO.
        let isoTimestamp: string;
        if (typeof m.timestamp === "string") {
          const asNumber = Number(m.timestamp);
          isoTimestamp = Number.isFinite(asNumber)
            ? new Date(asNumber * 1000).toISOString()
            : new Date().toISOString();
        } else if (typeof m.timestamp === "number") {
          isoTimestamp = new Date(m.timestamp * 1000).toISOString();
        } else {
          isoTimestamp = new Date().toISOString();
        }

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

        messages.push({
          id: m.id,
          from: m.from,
          timestamp: isoTimestamp,
          type,
          ...(text !== undefined ? { text } : {}),
          ...(mediaId !== undefined ? { mediaId } : {}),
        });
      }
    }
  }

  return messages;
}
