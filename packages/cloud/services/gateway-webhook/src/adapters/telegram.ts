/** Delegates Telegram protocol behavior to the shared Web-standard connector. */

import {
  parseTelegramWebhook,
  resolveTelegramBotUsername,
  resolveTelegramGroupActorRole,
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

const TELEGRAM_GROUP_LINK_COMMAND =
  /^(?:\/eliza_link(?:@([a-z0-9_]{5,32}))?|eliza\s+link)\s+[2-9A-HJ-NP-Z]{8}$/i;

function telegramGroupLinkTarget(
  text: string,
  botUsername: string,
): "not-link" | "this-bot" | "other-bot" {
  const match = text.trim().match(TELEGRAM_GROUP_LINK_COMMAND);
  if (!match) return "not-link";
  const target = match[1];
  if (!target) return "this-bot";
  return botUsername && target.toLowerCase() === botUsername.toLowerCase()
    ? "this-bot"
    : "other-bot";
}

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
    groupActorRole: event.groupActorRole,
    membershipChange: event.membershipChange,
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

  async extractEvent(rawBody: string, config): Promise<ChatEvent | null> {
    let group = false;
    try {
      const payload = JSON.parse(rawBody) as {
        message?: { chat?: { type?: unknown } };
      };
      group =
        payload.message?.chat?.type === "group" ||
        payload.message?.chat?.type === "supergroup";
    } catch {
      return parseTelegramWebhook(rawBody, logger);
    }
    if (!group) return parseTelegramWebhook(rawBody, logger);
    let botUsername = config?.botUsername ?? "";
    try {
      botUsername = await resolveTelegramBotUsername(config ?? {});
    } catch (error) {
      // error-policy:J4 unresolved bot identity is a visible fail-closed
      // unavailable state: group mentions remain silent instead of guessing.
      logger.warn(
        "Telegram bot identity lookup failed; group mentions will remain silent",
        {
          error: error instanceof Error ? error.name : "OtherError",
        },
      );
    }
    const event = parseTelegramWebhook(rawBody, logger, {
      botUsername,
      // Forward ambient facts to Cloud; the durable binding owns whether they
      // may enter the model. Telegram privacy mode may still hide them.
      allowAmbient: true,
    });
    if (!event) return null;
    const linkTarget = telegramGroupLinkTarget(event.text, botUsername);
    // Telegram may deliver commands addressed to another bot when this bot is
    // an administrator. Do not forward those commands as ambient text: the
    // trusted Cloud route also recognizes the command grammar and would
    // otherwise emit a control reply despite the foreign @username suffix.
    if (linkTarget === "other-bot") return null;
    if (linkTarget === "this-bot") {
      try {
        event.groupActorRole = await resolveTelegramGroupActorRole(
          config ?? {},
          event.chatId,
          event.senderId,
        );
      } catch (error) {
        // error-policy:J4 provider membership failure is preserved as the
        // explicit unknown authority state; linking cannot proceed from it.
        logger.warn(
          "Telegram group authority lookup failed; link remains fail-closed",
          { error: error instanceof Error ? error.name : "OtherError" },
        );
        event.groupActorRole = "unknown";
      }
    }
    return event;
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
