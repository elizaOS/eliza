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
  /** Provider-owned voice-note metadata; never contains an authenticated URL. */
  voiceNote?: {
    fileId: string;
    durationSeconds: number;
    sizeBytes?: number;
    mimeType: "audio/ogg";
  };
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
  /** Resolve provider-owned voice bytes while credentials are still local. */
  resolveVoiceNote?(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<ResolvedVoiceNote>;
}

export interface ResolvedVoiceNote {
  bytesBase64: string;
  mimeType: "audio/ogg";
  filename: string;
  sizeBytes: number;
  durationSeconds: number;
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
