/** Defines normalized webhook events, configuration, and platform adapters. */
import type { TelegramDeliveryHooks } from "@elizaos/cloud-services-common/telegram-delivery";
export type Platform = "telegram" | "blooio" | "twilio";

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
  /** Deterministic group-policy classification, before model should-respond. */
  groupInvocation?: "mention" | "command" | "reply" | "ambient";
  /** Provider-verified sender authority for group-control operations. */
  groupActorRole?: "creator" | "administrator" | "member" | "unknown";
  /** Bot/account membership transition for a provider group. */
  membershipChange?: "joined" | "removed";
  /** Provider message referenced by an inline reply, when exposed. */
  replyToMessageId?: string;
  /** Provider-accepted message time, used only for coarse ingress latency. */
  providerSentAtMs?: number;
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
  extractEvent(
    rawBody: string,
    config?: WebhookConfig,
  ): Promise<ChatEvent | null>;
  sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
    deliveryHooks?: TelegramDeliveryHooks,
  ): Promise<void>;
  sendReplyWithReceipt?(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
    deliveryHooks?: TelegramDeliveryHooks,
  ): Promise<PlatformDeliveryReceipt>;
  sendTypingIndicator(config: WebhookConfig, event: ChatEvent): Promise<void>;
  /** Clears an explicit provider typing state when the adapter supports it. */
  stopTypingIndicator?(config: WebhookConfig, event: ChatEvent): Promise<void>;
  /** Resolve provider-owned voice bytes while credentials are still local. */
  resolveVoiceNote?(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<ResolvedVoiceNote>;
}

export interface PlatformDeliveryReceipt {
  providerMessageIds: string[];
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
  botUsername?: string;
  webhookSecret?: string;
  // Blooio
  apiKey?: string;
  blooioWebhookSecret?: string;
  fromNumber?: string;
  // Twilio
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
}
