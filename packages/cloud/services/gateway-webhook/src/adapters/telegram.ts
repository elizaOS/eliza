/** Delegates Telegram protocol behavior to the shared Web-standard connector. */

import {
  parseTelegramWebhook,
  resolveTelegramVoiceNote,
  sendTelegramReply,
  sendTelegramTyping,
  TELEGRAM_HOSTED_FILE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_DURATION_SECONDS,
  TelegramApiResponseError,
  type TelegramConnectorEvent,
  verifyTelegramWebhook,
} from "@elizaos/cloud-services-common/telegram-connector";
import { resolveConnectorAccountId } from "../connector-account";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

export {
  TELEGRAM_HOSTED_FILE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_DURATION_SECONDS,
  TelegramApiResponseError,
};

function asTelegramEvent(event: ChatEvent): TelegramConnectorEvent {
  if (event.platform !== "telegram") {
    throw new TypeError("Telegram adapter received a non-Telegram event");
  }
  return {
    platform: "telegram",
    messageId: event.messageId,
    platformRecordId: event.platformRecordId ?? event.messageId,
    chatId: event.chatId,
    chatType: event.chatType ?? "private",
    senderId: event.senderId,
    senderName: event.senderName,
    text: event.text,
    isCommand: event.isCommand ?? event.text.startsWith("/"),
    groupInvocation: event.groupInvocation,
    replyToMessageId: event.replyToMessageId,
    providerSentAtMs: event.providerSentAtMs,
    voiceNote: event.voiceNote,
    rawPayload: event.rawPayload,
  };
}

export const telegramAdapter: PlatformAdapter = {
  platform: "telegram",

  getDedupeScope(
    config: WebhookConfig,
    _event: ChatEvent,
    project: string,
  ): string {
    const accountId = resolveConnectorAccountId("telegram", config);
    return `project:${project}:account:${accountId ?? "bot:missing"}`;
  },

  async verifyWebhook(
    request: Request,
    _rawBody: string,
    config: WebhookConfig,
  ): Promise<boolean> {
    const verified = verifyTelegramWebhook(request, config.webhookSecret);
    if (!config.webhookSecret) {
      logger.warn("Telegram webhook secret not configured — rejecting request");
    }
    return verified;
  },

  async extractEvent(rawBody: string): Promise<ChatEvent | null> {
    return parseTelegramWebhook(rawBody, logger);
  },

  async resolveVoiceNote(config, event) {
    return resolveTelegramVoiceNote(config, asTelegramEvent(event));
  },

  async sendReply(config, event, text, deliveryHooks): Promise<void> {
    await sendTelegramReply(
      config,
      asTelegramEvent(event),
      text,
      logger,
      deliveryHooks,
    );
  },

  async sendReplyWithReceipt(config, event, text, deliveryHooks) {
    return sendTelegramReply(
      config,
      asTelegramEvent(event),
      text,
      logger,
      deliveryHooks,
    );
  },

  async sendTypingIndicator(config, event): Promise<void> {
    await sendTelegramTyping(config, asTelegramEvent(event));
  },
};
