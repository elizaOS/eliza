import crypto from "crypto";
import { z } from "zod";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

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

export const whatsappAdapter: PlatformAdapter = {
  platform: "whatsapp",

  async verifyWebhook(request: Request, rawBody: string, config: WebhookConfig): Promise<boolean> {
    if (!config.appSecret) {
      logger.warn("WhatsApp app secret not configured — signature verification skipped");
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

  async sendReply(config: WebhookConfig, event: ChatEvent, text: string): Promise<void> {
    if (!config.accessToken || !config.phoneNumberId) {
      throw new Error("Missing WhatsApp credentials for reply");
    }

    const url = `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`;
    const response = await fetch(url, {
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
      const errorText = await response.text();
      throw new Error(`WhatsApp send error (${response.status}): ${errorText}`);
    }
  },

  async sendTypingIndicator(config: WebhookConfig, event: ChatEvent): Promise<void> {
    if (!config.accessToken || !config.phoneNumberId) return;
    try {
      const url = `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`;
      await fetch(url, {
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
