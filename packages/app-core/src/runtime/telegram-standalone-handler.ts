import {
  type AgentRuntime,
  ChannelType,
  type Content,
  createUniqueUuid,
  type HandlerCallback,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";

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

type RuntimeMessageServiceCompat = AgentRuntime & {
  messageService?: {
    handleMessage: (
      runtime: AgentRuntime,
      message: Memory,
      callback?: HandlerCallback,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
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
    // Fall back to a comma-separated list for local operator convenience.
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

export async function handleTelegramStandaloneMessage(
  runtime: AgentRuntime,
  ctx: TelegramStandaloneContext,
): Promise<void> {
  try {
    const message = ctx.message;
    const text = message?.text;
    if (!text) return;
    const chat = ctx.chat ?? message?.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const from = ctx.from ?? message?.from;
    const telegramUserId = String(from?.id ?? `chat-${chatId}`);
    const username =
      from?.username ?? from?.first_name ?? `telegram-${telegramUserId}`;
    const threadId =
      message?.message_thread_id !== undefined
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

    logger.info(
      `[eliza] Telegram message from @${username}: ${text.substring(0, 80)}`,
    );

    const runtimeWithMessages = runtime as RuntimeMessageServiceCompat;
    if (!runtimeWithMessages.messageService?.handleMessage) {
      logger.warn("[eliza] Telegram runtime missing messageService");
      return;
    }

    const entityId = createUniqueUuid(
      runtime,
      `telegram-user:${telegramUserId}`,
    ) as UUID;
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
      `telegram-message:${message?.message_id ?? `${chatId}:${Date.now()}`}`,
    ) as UUID;
    const channelType = getTelegramChannelType(chat.type);
    const createdAt =
      typeof message?.date === "number" ? message.date * 1000 : Date.now();

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
          message?.reply_to_message?.message_id !== undefined
            ? (createUniqueUuid(
                runtime,
                `telegram-message:${message.reply_to_message.message_id}`,
              ) as UUID)
            : undefined,
      },
      metadata: {
        type: "message",
        source: "telegram",
        provider: "telegram",
        timestamp: createdAt,
        entityName: from?.first_name,
        entityUserName: from?.username,
        fromBot: from?.is_bot === true,
        fromId: telegramUserId,
        sourceId: entityId,
        chatType: chat.type,
        messageIdFull: String(message?.message_id ?? ""),
        sender: {
          id: telegramUserId,
          name: from?.first_name,
          username: from?.username,
        },
        telegram: {
          chatId,
          messageId: String(message?.message_id ?? ""),
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
        const sentMessageId =
          sent?.message_id !== undefined
            ? String(sent.message_id)
            : `local-${Date.now()}-${index}`;
        const responseMemory: Memory = {
          id: createUniqueUuid(
            runtime,
            `telegram-message:${sentMessageId}`,
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
      logger.info(`[eliza] Telegram replied to @${username}`);
      return sentMemories;
    };

    await runtimeWithMessages.messageService.handleMessage(
      runtime,
      memory,
      callback,
      { continueAfterActions: true },
    );
  } catch (outerErr) {
    logger.warn(
      `[eliza] Telegram handler error: ${
        outerErr instanceof Error ? outerErr.message : String(outerErr)
      }`,
    );
    await ctx
      .reply("Sorry, I encountered an error processing your message.")
      .catch(() => {});
  }
}
