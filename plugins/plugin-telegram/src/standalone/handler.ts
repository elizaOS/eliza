/**
 * Converts standalone Telegram updates into canonical runtime messages and
 * guards reply delivery with durable account-scoped idempotency markers.
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { checkTelegramDmAccess, resolveTelegramDmPolicy } from "../dm-policy";
import { resolveTelegramRuntimeEntityId } from "../identity";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type TelegramStandaloneUser = {
  id?: number | string;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
};

type TelegramStandaloneChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
};

type TelegramStandaloneMessage = {
  message_id?: number | string;
  date?: number;
  text?: string;
  from?: TelegramStandaloneUser;
  chat?: TelegramStandaloneChat;
  message_thread_id?: number | string;
  reply_to_message?: { message_id?: number | string };
};

export type TelegramStandaloneContext = {
  message?: TelegramStandaloneMessage;
  from?: TelegramStandaloneUser;
  chat?: TelegramStandaloneChat;
  reply: (text: string) => Promise<unknown>;
};

function parseAllowedTelegramChats(raw: unknown): Set<string> | null {
  if (Array.isArray(raw)) {
    const entries = raw.map(String).filter(Boolean);
    return entries.length > 0 ? new Set(entries) : null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const entries = parsed.map(String).filter(Boolean);
      return entries.length > 0 ? new Set(entries) : null;
    }
  } catch {
    // error-policy:J3 Invalid JSON is treated as a comma-separated operator
    // input; it never becomes a fabricated valid JSON value.
  }
  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

function getTelegramChannelType(chatType: string | undefined): ChannelType {
  switch (chatType) {
    case "private":
      return ChannelType.DM;
    case "channel":
      return ChannelType.FEED;
    default:
      return ChannelType.GROUP;
  }
}

function splitTelegramText(text: string): string[] {
  const maxLength = 4096;
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) {
    chunks.push(text.slice(start, start + maxLength));
  }
  return chunks;
}

function telegramStandaloneMemoryKey(
  accountId: string,
  chatId: string,
  messageId: string,
): string {
  return `telegram:${accountId}:message:${chatId}:${messageId}`;
}

function telegramStandaloneDedupeKey(
  accountId: string,
  chatId: string,
  messageId: string,
): string {
  return `telegram-standalone:processed:${accountId}:${chatId}:${messageId}`;
}

export async function handleTelegramStandaloneMessage(
  runtime: IAgentRuntime,
  ctx: TelegramStandaloneContext,
): Promise<void> {
  try {
    const message = ctx.message;
    const text = message?.text;
    if (!text) return;
    const chat = ctx.chat ?? message.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const from = ctx.from ?? message.from;
    if (from?.id === undefined) {
      // error-policy:J3 Sender-less Telegram updates cannot produce trustworthy
      // provenance, so they are rejected as invalid input and reported.
      runtime.reportError(
        "telegram-standalone:missing-sender-id",
        new Error("Telegram text update has no stable sender id"),
        { accountId: "default", chatId },
      );
      return;
    }
    const telegramUserId = String(from.id);
    const username =
      from?.username ?? from?.first_name ?? `telegram-${telegramUserId}`;
    const accountId = "default";
    const threadId =
      message.message_thread_id !== undefined
        ? String(message.message_thread_id)
        : undefined;
    const telegramRoomId = threadId ? `${chatId}-${threadId}` : chatId;

    // Check allowed chats live from runtime settings first, then env.
    const allowedChats = parseAllowedTelegramChats(
      runtime.getSetting("TELEGRAM_ALLOWED_CHATS") ??
        process.env.TELEGRAM_ALLOWED_CHATS,
    );
    if (allowedChats && !allowedChats.has(chatId)) {
      return;
    }

    // With no allowlist configured, private DMs fall to the TELEGRAM_DM_POLICY
    // gate — fail-closed pairing by default, so an unconfigured standalone bot
    // is never default-open to arbitrary Telegram users. Non-private chats
    // stay open; the bot only sees groups it was invited to.
    if (!allowedChats && chat.type === "private") {
      const policy = resolveTelegramDmPolicy(
        runtime.getSetting("TELEGRAM_DM_POLICY") ??
          process.env.TELEGRAM_DM_POLICY,
      );
      const access = await checkTelegramDmAccess(runtime, {
        policy,
        senderId: telegramUserId,
        username: from?.username,
      });
      if (!access.allowed) {
        if (access.replyMessage) {
          await ctx.reply(access.replyMessage);
        }
        return;
      }
    }

    logger.info(
      `[telegram-standalone] Telegram message from @${username} chat=${chatId} length=${text.length}`,
    );

    if (!runtime.messageService) {
      throw new ElizaError("Telegram runtime message service is unavailable", {
        code: "TELEGRAM_MESSAGE_SERVICE_UNAVAILABLE",
        context: { accountId, chatId },
      });
    }

    if (message.message_id === undefined) {
      runtime.reportError(
        "telegram-standalone:missing-message-id",
        new Error("Telegram text update has no stable message_id"),
        { accountId, chatId },
      );
      return;
    }
    const telegramMessageId = String(message.message_id);
    const dedupeKey = telegramStandaloneDedupeKey(
      accountId,
      chatId,
      telegramMessageId,
    );
    const deliveryMarker = await runtime.getCache<{
      state?: "delivery_started" | "processed";
    }>(dedupeKey);
    if (deliveryMarker !== undefined) {
      if (deliveryMarker.state === "delivery_started") {
        runtime.reportError(
          "telegram-standalone:delivery-uncertain",
          new Error(
            `Telegram delivery outcome is uncertain for ${accountId}/${chatId}/${telegramMessageId}; refusing duplicate egress`,
          ),
          { accountId, chatId, messageId: telegramMessageId },
        );
      }
      logger.debug(
        `[telegram-standalone] duplicate Telegram message skipped chat=${chatId} message=${telegramMessageId}`,
      );
      return;
    }

    const entityId = await resolveTelegramRuntimeEntityId(
      runtime,
      accountId,
      telegramUserId,
    );
    const roomId = createUniqueUuid(
      runtime,
      `telegram-room:${telegramRoomId}`,
    ) as UUID;
    const worldId = createUniqueUuid(
      runtime,
      `telegram-world:${chatId}`,
    ) as UUID;
    const messageId = createUniqueUuid(
      runtime,
      telegramStandaloneMemoryKey(accountId, chatId, telegramMessageId),
    ) as UUID;
    const channelType = getTelegramChannelType(chat.type);
    const createdAt =
      typeof message.date === "number" ? message.date * 1000 : Date.now();

    await runtime.ensureConnection({
      entityId,
      roomId,
      roomName:
        chat.title ?? chat.first_name ?? chat.username ?? telegramRoomId,
      userName: from?.username,
      name: from?.first_name ?? from?.username ?? username,
      userId: telegramUserId as UUID,
      source: "telegram",
      channelId: telegramRoomId,
      type: channelType,
      worldId,
      worldName: telegramRoomId,
    });

    const memory: Memory = {
      id: messageId,
      entityId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text,
        source: "telegram",
        channelType,
        inReplyTo:
          message.reply_to_message?.message_id !== undefined
            ? (createUniqueUuid(
                runtime,
                telegramStandaloneMemoryKey(
                  accountId,
                  chatId,
                  String(message.reply_to_message.message_id),
                ),
              ) as UUID)
            : undefined,
      },
      metadata: {
        type: "message",
        source: "telegram",
        provider: "telegram",
        accountId,
        scope: "room",
        timestamp: createdAt,
        entityName: from?.first_name,
        entityUserName: from?.username,
        fromBot: from?.is_bot === true,
        fromId: telegramUserId,
        sourceId: entityId,
        chatType: chat.type,
        messageIdFull: String(message.message_id ?? ""),
        sender: {
          id: telegramUserId,
          name: from?.first_name,
          username: from?.username,
        },
        telegram: {
          id: telegramUserId,
          userId: telegramUserId,
          chatId,
          messageId: String(message.message_id ?? ""),
          threadId,
        },
        telegramUserId,
        telegramChatId: chatId,
      },
      createdAt,
    };

    const callback: HandlerCallback = async (
      content: Content,
      _actionName?: string,
    ) => {
      if (!content.text) {
        return [];
      }

      await runtime.setCache(dedupeKey, {
        state: "delivery_started",
        processedAt: Date.now(),
        accountId,
        chatId,
        messageId: telegramMessageId,
      });

      const sentMemories: Memory[] = [];
      const chunks = splitTelegramText(content.text);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const sent = (await ctx.reply(chunk)) as
          | {
              message_id?: number | string;
              date?: number;
              text?: string;
              chat?: { id?: number | string };
            }
          | undefined;
        if (sent?.message_id === undefined) {
          throw new ElizaError(
            "Telegram reply did not return a stable message id",
            {
              code: "TELEGRAM_REPLY_MISSING_MESSAGE_ID",
              context: {
                accountId,
                chatId,
                inboundMessageId: telegramMessageId,
                chunkIndex: index,
              },
            },
          );
        }
        const sentMessageId = String(sent.message_id);
        const responseMemory: Memory = {
          id: createUniqueUuid(
            runtime,
            telegramStandaloneMemoryKey(
              accountId,
              String(sent?.chat?.id ?? chatId),
              sentMessageId,
            ),
          ) as UUID,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content: {
            ...content,
            source: "telegram",
            text: sent?.text ?? chunk,
            inReplyTo: messageId,
            channelType,
          },
          metadata: {
            type: "message",
            source: "telegram",
            provider: "telegram",
            accountId,
            scope: "room",
            timestamp:
              typeof sent?.date === "number" ? sent.date * 1000 : Date.now(),
            fromBot: true,
            fromId: runtime.agentId,
            sourceId: runtime.agentId,
            chatType: chat.type,
            messageIdFull: sentMessageId,
            telegram: {
              chatId: String(sent?.chat?.id ?? chatId),
              messageId: sentMessageId,
              threadId,
            },
          },
          createdAt:
            typeof sent?.date === "number" ? sent.date * 1000 : Date.now(),
        };
        await runtime.createMemory(responseMemory, "messages");
        sentMemories.push(responseMemory);
      }
      logger.info(`[telegram-standalone] Telegram replied to @${username}`);
      return sentMemories;
    };

    await runtime.messageService.handleMessage(runtime, memory, callback, {
      continueAfterActions: true,
    });
    await runtime.setCache(dedupeKey, {
      state: "processed",
      processedAt: Date.now(),
      accountId,
      chatId,
      messageId: telegramMessageId,
    });
  } catch (cause) {
    // error-policy:J2 Handler failures retain their cause and gain connector
    // delivery context before returning to the Telegraf boundary.
    const outerErr =
      cause instanceof ElizaError
        ? cause
        : new ElizaError("Telegram standalone delivery failed", {
            code: "TELEGRAM_STANDALONE_DELIVERY_FAILED",
            cause,
          });
    runtime.reportError("telegram-standalone:delivery", outerErr);
    logger.warn(
      `[telegram-standalone] Telegram handler error: ${formatError(outerErr)}`,
    );
    throw outerErr;
  }
}
