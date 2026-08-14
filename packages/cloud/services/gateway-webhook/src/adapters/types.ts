/** Defines normalized webhook events, configuration, and platform adapters. */
export type Platform = "telegram" | "blooio" | "twilio" | "whatsapp";

export interface ChatEvent {
  platform: Platform;
  messageId: string;
  platformRecordId?: string;
  chatId: string;
  chatType?: string;
  channelId?: string;
  channelType?: string;
  protocol?: string;
  senderId: string;
  senderName?: string;
  text: string;
  isCommand?: boolean;
  mediaUrls?: string[];
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
