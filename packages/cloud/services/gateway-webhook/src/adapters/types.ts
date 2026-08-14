/** Defines normalized webhook events, configuration, and platform adapters. */
export type Platform = "telegram" | "blooio" | "twilio" | "whatsapp";

export interface ChatEvent {
  platform: Platform;
  messageId: string;
  platformRecordId?: string;
  chatId: string;
  chatType?: string;
  senderId: string;
  senderName?: string;
  text: string;
  isCommand?: boolean;
  mediaUrls?: string[];
  /** Blooio v4 channel id, preserved from the inbound envelope for channel-aware replies. */
  channelId?: string;
  /** Blooio v4 channel type (e.g. "blooio", "whatsapp"), preserved from the inbound envelope. */
  channelType?: string;
  rawPayload: unknown;
}

export interface PlatformAdapter {
  platform: Platform;
  getDedupeScope?(
    config: WebhookConfig,
    event: ChatEvent,
    project: string,
    agentId?: string,
  ): string;
  verifyWebhook(
    request: Request,
    rawBody: string,
    config: WebhookConfig,
  ): Promise<boolean>;
  extractEvent(rawBody: string): Promise<ChatEvent | null>;
  sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
  ): Promise<void>;
  sendTypingIndicator(config: WebhookConfig, event: ChatEvent): Promise<void>;
}

export interface WebhookConfig {
  // Telegram
  botToken?: string;
  webhookSecret?: string;
  // Blooio
  apiKey?: string;
  blooioWebhookSecret?: string;
  fromNumber?: string;
  // Twilio
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  // WhatsApp Cloud API
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
  businessPhone?: string;
}
