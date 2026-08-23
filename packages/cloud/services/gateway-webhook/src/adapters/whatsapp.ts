// Handles webhook gateway whatsapp behavior for authenticated connector fan-in.
import crypto from "node:crypto";
import { z } from "zod";
import { logger } from "../logger";
import { boundedGatewayFetch } from "./bounded-fetch";
import {
  type ChatEvent,
  type PlatformAdapter,
  PlatformDeliveryError,
  type WebhookConfig,
} from "./types";

const WHATSAPP_REQUEST_TIMEOUT_MS = 30_000;
const WHATSAPP_RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * Bound every WhatsApp Cloud API hop so a hung gateway cannot pin the
 * adapter. A caller-provided abort signal is composed with the timeout
 * (either cancelling aborts), not substituted for it.
 */
export function whatsappFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = WHATSAPP_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return boundedGatewayFetch(
    fetch,
    input,
    init,
    timeoutMs,
    WHATSAPP_RESPONSE_MAX_BYTES,
  );
}

const WHATSAPP_API_BASE = "https://graph.facebook.com/v21.0";

const WhatsAppWebhookMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
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

const WhatsAppWebhookPayloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: WhatsAppWebhookValueSchema,
          field: z.string(),
        }),
      ),
    }),
  ),
});

async function sendWhatsAppReply(
  config: WebhookConfig,
  event: ChatEvent,
  text: string,
): Promise<string[]> {
  if (!config.accessToken || !config.phoneNumberId) {
    throw new PlatformDeliveryError(
      "Missing WhatsApp credentials for reply",
      "failed",
      "DELIVERY_CREDENTIALS_MISSING",
      false,
    );
  }
  const url = `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`;
  const response = await whatsappFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: event.senderId,
      type: "text",
      text: { body: text },
    }),
  });
  if (!response.ok) {
    throw new PlatformDeliveryError(
      `WhatsApp rejected delivery (${response.status})`,
      response.status >= 500 ? "uncertain" : "failed",
      "DELIVERY_PROVIDER_REJECTED",
      response.status === 429,
      response.status,
    );
  }
  let receipt: unknown;
  try {
    receipt = await response.json();
  } catch (cause) {
    // error-policy:J2 preserve the provider parse failure while adding a
    // stable delivery classification for the gateway boundary.
    throw new PlatformDeliveryError(
      "WhatsApp accepted delivery without a valid receipt",
      "uncertain",
      "DELIVERY_RECEIPT_INVALID",
      false,
      undefined,
      { cause },
    );
  }
  const messages =
    receipt && typeof receipt === "object"
      ? (receipt as { messages?: unknown }).messages
      : undefined;
  const providerMessageIds = Array.isArray(messages)
    ? messages
        .map((message) =>
          message &&
          typeof message === "object" &&
          typeof (message as { id?: unknown }).id === "string"
            ? (message as { id: string }).id.trim()
            : "",
        )
        .filter(Boolean)
    : [];
  if (providerMessageIds.length === 0) {
    throw new PlatformDeliveryError(
      "WhatsApp accepted delivery without a message receipt",
      "uncertain",
      "DELIVERY_RECEIPT_INVALID",
      false,
    );
  }
  return providerMessageIds;
}

export const whatsappAdapter: PlatformAdapter = {
  platform: "whatsapp",

  async verifyWebhook(
    request: Request,
    rawBody: string,
    config: WebhookConfig,
  ): Promise<boolean> {
    if (!config.appSecret) {
      logger.warn(
        "WhatsApp app secret not configured — signature verification skipped",
      );
      return false;
    }

    const signatureHeader = request.headers.get("x-hub-signature-256") ?? "";
    if (!signatureHeader) return false;

    try {
      const expectedSignature = signatureHeader.replace("sha256=", "");
      const computedSignature = crypto
        .createHmac("sha256", config.appSecret)
        .update(rawBody)
        .digest("hex");

      const expectedBuf = Buffer.from(expectedSignature, "hex");
      const computedBuf = Buffer.from(computedSignature, "hex");

      if (expectedBuf.length !== computedBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, computedBuf);
    } catch (err) {
      logger.warn("WhatsApp signature verification error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  async extractEvent(rawBody: string): Promise<ChatEvent | null> {
    let data: unknown;
    try {
      data = JSON.parse(rawBody);
    } catch {
      logger.warn("Failed to parse WhatsApp webhook payload");
      return null;
    }

    const parsed = WhatsAppWebhookPayloadSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn("Invalid WhatsApp webhook payload", {
        errors: parsed.error.format(),
      });
      return null;
    }

    for (const entry of parsed.data.entry) {
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

        // Meta can batch multiple messages per delivery. We intentionally process
        // only the first text message — each subsequent delivery will be its own webhook.
        for (const msg of value.messages) {
          if (msg.type !== "text" || !msg.text?.body) continue;

          return {
            platform: "whatsapp",
            messageId: msg.id,
            chatId: msg.from,
            senderId: msg.from,
            senderName: contactMap.get(msg.from),
            text: msg.text.body,
            rawPayload: data,
          };
        }
      }
    }

    return null;
  },

  async sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
  ): Promise<void> {
    await sendWhatsAppReply(config, event, text);
  },

  async sendReplyWithReceipt(config, event, text) {
    return { providerMessageIds: await sendWhatsAppReply(config, event, text) };
  },

  async sendTypingIndicator(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<void> {
    if (!config.accessToken || !config.phoneNumberId) return;
    try {
      const url = `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`;
      await whatsappFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: event.messageId,
        }),
      });
    } catch {
      // Fire-and-forget
    }
  },
};
