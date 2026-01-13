import fs from "node:fs";
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type IPdfService,
  logger,
  type Media,
  type Memory,
  MemoryType,
  type MessageMetadata,
  ModelType,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type { Chat, Document, Message, ReactionType, Update } from "@telegraf/types";
import type { Context, NarrowedContext, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import {
  type TelegramContent,
  TelegramEventTypes,
  type TelegramMessageSentPayload,
  type TelegramReactionReceivedPayload,
} from "./types";
import { cleanText, convertMarkdownToTelegram, convertToTelegramButtons } from "./utils";

interface DocumentProcessingResult {
  title: string;
  fullText: string;
  formattedDescription: string;
  fileName: string;
  mimeType: string | undefined;
  fileSize: number | undefined;
  error?: string;
}

/**
 * Enum representing different types of media.
 * @enum { string }
 * @readonly
 */
export enum MediaType {
  PHOTO = "photo",
  VIDEO = "video",
  DOCUMENT = "document",
  AUDIO = "audio",
  ANIMATION = "animation",
}

const MAX_MESSAGE_LENGTH = 4096;

const getChannelType = (chat: Chat): ChannelType => {
  switch (chat.type) {
    case "private":
      return ChannelType.DM;
    case "group":
    case "supergroup":
    case "channel":
      return ChannelType.GROUP;
    default: {
      const _exhaustive: never = chat;
      throw new Error(`Unrecognized Telegram chat type: ${JSON.stringify(chat)}`);
    }
  }
};

type TelegramChatContextContent = Content & {
  chatId: number;
  userId: number;
  messageId: number;
  threadId?: number;
};

export class MessageManager {
  public bot: Telegraf<Context>;
  protected runtime: IAgentRuntime;

  constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
    this.bot = bot;
    this.runtime = runtime;
  }

  async processImage(message: Message): Promise<{ description: string } | null> {
    let imageUrl: string | null = null;

    logger.info(`Telegram Message: ${JSON.stringify(message, null, 2)}`);

    if ("photo" in message && message.photo?.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
      imageUrl = fileLink.toString();
    } else if (
      "document" in message &&
      message.document?.mime_type?.startsWith("image/") &&
      !message.document?.mime_type?.startsWith("application/pdf")
    ) {
      const fileLink = await this.bot.telegram.getFileLink(message.document.file_id);
      imageUrl = fileLink.toString();
    }

    if (imageUrl) {
      const { title, description } = await this.runtime.useModel(
        ModelType.IMAGE_DESCRIPTION,
        imageUrl
      );
      return { description: `[Image: ${title}\n${description}]` };
    }

    return null;
  }

  async processDocument(message: Message): Promise<DocumentProcessingResult | null> {
    if (!("document" in message) || !message.document) {
      return null;
    }

    const document = message.document;
    const fileLink = await this.bot.telegram.getFileLink(document.file_id);
    const documentUrl = fileLink.toString();

    logger.info(
      `Processing document: ${document.file_name} (${document.mime_type}, ${document.file_size} bytes)`
    );

    const documentProcessor = this.getDocumentProcessor(document.mime_type);
    if (documentProcessor) {
      return await documentProcessor(document, documentUrl);
    }

    return {
      title: `Document: ${document.file_name || "Unknown Document"}`,
      fullText: "",
      formattedDescription: `[Document: ${document.file_name || "Unknown Document"}\nType: ${document.mime_type || "unknown"}\nSize: ${document.file_size || 0} bytes]`,
      fileName: document.file_name || "Unknown Document",
      mimeType: document.mime_type,
      fileSize: document.file_size,
    };
  }

  private getDocumentProcessor(
    mimeType?: string
  ): ((document: Document, url: string) => Promise<DocumentProcessingResult>) | null {
    if (!mimeType) return null;

    const processors = {
      "application/pdf": this.processPdfDocument.bind(this),
      "text/": this.processTextDocument.bind(this),
      "application/json": this.processTextDocument.bind(this),
    };

    for (const [pattern, processor] of Object.entries(processors)) {
      if (mimeType.startsWith(pattern)) {
        return processor;
      }
    }

    return null;
  }

  private async processPdfDocument(
    document: Document,
    documentUrl: string
  ): Promise<DocumentProcessingResult> {
    const pdfService = this.runtime.getService(ServiceType.PDF) as IPdfService | undefined;
    if (!pdfService) {
      logger.warn("PDF service not available, using fallback");
      return {
        title: `PDF Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nUnable to extract text content]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }

    const response = await fetch(documentUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    const result = await pdfService.extractText(Buffer.from(pdfBuffer));
    const text = result.text;

    logger.info(`PDF processed successfully: ${text.length} characters extracted`);
    return {
      title: document.file_name || "Unknown Document",
      fullText: text,
      formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
      fileName: document.file_name || "Unknown Document",
      mimeType: document.mime_type,
      fileSize: document.file_size,
    };
  }

  private async processTextDocument(
    document: Document,
    documentUrl: string
  ): Promise<DocumentProcessingResult> {
    const response = await fetch(documentUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch text document: ${response.status}`);
    }

    const text = await response.text();

    logger.info(`Text document processed successfully: ${text.length} characters extracted`);
    return {
      title: document.file_name || "Unknown Document",
      fullText: text,
      formattedDescription: `[Text Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
      fileName: document.file_name || "Unknown Document",
      mimeType: document.mime_type,
      fileSize: document.file_size,
    };
  }

  async processMessage(
    message: Message
  ): Promise<{ processedContent: string; attachments: Media[] }> {
    let processedContent = "";
    const attachments: Media[] = [];

    if ("text" in message && message.text) {
      processedContent = message.text;
    } else if ("caption" in message && message.caption) {
      processedContent = message.caption as string;
    }

    if ("document" in message && message.document) {
      const document = message.document;
      const documentInfo = await this.processDocument(message);

      if (documentInfo) {
        try {
          const fileLink = await this.bot.telegram.getFileLink(document.file_id);

          const title = documentInfo.title;
          const fullText = documentInfo.fullText;

          if (fullText) {
            const documentContent = `\n\n--- DOCUMENT CONTENT ---\nTitle: ${title}\n\nFull Content:\n${fullText}\n--- END DOCUMENT ---\n\n`;
            processedContent += documentContent;
          }

          attachments.push({
            id: document.file_id,
            url: fileLink.toString(),
            title: title,
            source: document.mime_type?.startsWith("application/pdf") ? "PDF" : "Document",
            description: documentInfo.formattedDescription,
            text: fullText,
          });
          logger.info(`Document processed successfully: ${documentInfo.fileName}`);
        } catch (error) {
          logger.error({ error }, `Error processing document ${documentInfo.fileName}`);
          attachments.push({
            id: document.file_id,
            url: "",
            title: `Document: ${documentInfo.fileName}`,
            source: "Document",
            description: `Document processing failed: ${documentInfo.fileName}`,
            text: `Document: ${documentInfo.fileName}\nSize: ${documentInfo.fileSize || 0} bytes\nType: ${documentInfo.mimeType || "unknown"}`,
          });
        }
      } else {
        // Add a basic attachment even if documentInfo is null
        attachments.push({
          id: document.file_id,
          url: "",
          title: `Document: ${document.file_name || "Unknown Document"}`,
          source: "Document",
          description: `Document: ${document.file_name || "Unknown Document"}`,
          text: `Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nType: ${document.mime_type || "unknown"}`,
        });
      }
    }

    if ("photo" in message && message.photo?.length > 0) {
      const imageInfo = await this.processImage(message);
      if (imageInfo) {
        const photo = message.photo[message.photo.length - 1];
        const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
        attachments.push({
          id: photo.file_id,
          url: fileLink.toString(),
          title: "Image Attachment",
          source: "Image",
          description: imageInfo.description,
          text: imageInfo.description,
        });
      }
    }

    logger.info(
      `Message processed - Content: ${processedContent ? "yes" : "no"}, Attachments: ${attachments.length}`
    );

    return { processedContent, attachments };
  }

  async sendMessageInChunks(
    ctx: Context,
    content: TelegramContent,
    replyToMessageId?: number
  ): Promise<Message.TextMessage[]> {
    if (content.attachments && content.attachments.length > 0) {
      content.attachments.map(async (attachment: Media) => {
        const typeMap: { [key: string]: MediaType } = {
          "image/gif": MediaType.ANIMATION,
          image: MediaType.PHOTO,
          doc: MediaType.DOCUMENT,
          video: MediaType.VIDEO,
          audio: MediaType.AUDIO,
        };

        let mediaType: MediaType | undefined;

        for (const prefix in typeMap) {
          if (attachment.contentType?.startsWith(prefix)) {
            mediaType = typeMap[prefix];
            break;
          }
        }

        if (!mediaType) {
          throw new Error(
            `Unsupported Telegram attachment content type: ${attachment.contentType}`
          );
        }

        await this.sendMedia(ctx, attachment.url, mediaType, attachment.description);
      });
      return [];
    } else {
      const chunks = this.splitMessage(content.text ?? "");
      const sentMessages: Message.TextMessage[] = [];

      const telegramButtons = convertToTelegramButtons(content.buttons ?? []);

      if (!ctx.chat) {
        logger.error("sendMessageInChunks: ctx.chat is undefined");
        return [];
      }
      await ctx.telegram.sendChatAction(ctx.chat.id, "typing");

      for (let i = 0; i < chunks.length; i++) {
        const chunk = convertMarkdownToTelegram(chunks[i]);
        if (!ctx.chat) {
          logger.error("sendMessageInChunks loop: ctx.chat is undefined");
          continue;
        }
        const sentMessage = (await ctx.telegram.sendMessage(ctx.chat.id, chunk, {
          reply_parameters:
            i === 0 && replyToMessageId ? { message_id: replyToMessageId } : undefined,
          parse_mode: "MarkdownV2",
          ...Markup.inlineKeyboard(telegramButtons),
        })) as Message.TextMessage;

        sentMessages.push(sentMessage);
      }

      return sentMessages;
    }
  }

  async sendMedia(
    ctx: Context,
    mediaPath: string,
    type: MediaType,
    caption?: string
  ): Promise<void> {
    try {
      const isUrl = /^(http|https):\/\//.test(mediaPath);

      if (!ctx.chat) {
        throw new Error("sendMedia: ctx.chat is undefined");
      }

      if (isUrl) {
        switch (type) {
          case MediaType.PHOTO:
            await ctx.telegram.sendPhoto(ctx.chat.id, mediaPath, { caption });
            break;
          case MediaType.VIDEO:
            await ctx.telegram.sendVideo(ctx.chat.id, mediaPath, { caption });
            break;
          case MediaType.DOCUMENT:
            await ctx.telegram.sendDocument(ctx.chat.id, mediaPath, { caption });
            break;
          case MediaType.AUDIO:
            await ctx.telegram.sendAudio(ctx.chat.id, mediaPath, { caption });
            break;
          case MediaType.ANIMATION:
            await ctx.telegram.sendAnimation(ctx.chat.id, mediaPath, { caption });
            break;
          default: {
            const _exhaustive: never = type;
            throw new Error(`Unsupported media type: ${_exhaustive}`);
          }
        }
      } else {
        if (!fs.existsSync(mediaPath)) {
          throw new Error(`File not found at path: ${mediaPath}`);
        }

        const fileStream = fs.createReadStream(mediaPath);

        try {
          if (!ctx.chat) {
            throw new Error("sendMedia (file): ctx.chat is undefined");
          }
          switch (type) {
            case MediaType.PHOTO:
              await ctx.telegram.sendPhoto(ctx.chat.id, { source: fileStream }, { caption });
              break;
            case MediaType.VIDEO:
              await ctx.telegram.sendVideo(ctx.chat.id, { source: fileStream }, { caption });
              break;
            case MediaType.DOCUMENT:
              await ctx.telegram.sendDocument(ctx.chat.id, { source: fileStream }, { caption });
              break;
            case MediaType.AUDIO:
              await ctx.telegram.sendAudio(ctx.chat.id, { source: fileStream }, { caption });
              break;
            case MediaType.ANIMATION:
              await ctx.telegram.sendAnimation(ctx.chat.id, { source: fileStream }, { caption });
              break;
            default: {
              const _exhaustive: never = type;
              throw new Error(`Unsupported media type: ${_exhaustive}`);
            }
          }
        } finally {
          fileStream.destroy();
        }
      }

      logger.info(
        `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully: ${mediaPath}`
      );
    } catch (error) {
      logger.error({ error }, `Error sending media: ${mediaPath}`);
      throw error;
    }
  }

  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    if (!text) return chunks;
    let currentChunk = "";

    const lines = text.split("\n");
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
        currentChunk += (currentChunk ? "\n" : "") + line;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = line;
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  public async handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.from) return;

    const message = ctx.message as Message.TextMessage;

    const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;

    const threadId =
      "is_topic_message" in message && message.is_topic_message
        ? message.message_thread_id?.toString()
        : undefined;

    if (!ctx.chat) {
      logger.error("handleMessage: ctx.chat is undefined");
      return;
    }

    const telegramRoomid = threadId ? `${ctx.chat.id}-${threadId}` : ctx.chat.id.toString();
    const roomId = createUniqueUuid(this.runtime, telegramRoomid) as UUID;

    const messageId = createUniqueUuid(this.runtime, message?.message_id?.toString());

    const { processedContent, attachments } = await this.processMessage(message);

    const cleanedContent = cleanText(processedContent);
    const cleanedAttachments = attachments.map((att) => ({
      ...att,
      text: cleanText(att.text),
      description: cleanText(att.description),
      title: cleanText(att.title),
    }));

    if (!cleanedContent && cleanedAttachments.length === 0) {
      return;
    }

    const chat = message.chat as Chat;
    const chatId = chat.id;
    const channelType = getChannelType(chat);

    const sourceId = createUniqueUuid(this.runtime, `${chatId}`);
    const messageServerId = createUniqueUuid(this.runtime, `${chatId}`) as UUID;
    const worldId = createUniqueUuid(this.runtime, `${chatId}`) as UUID;

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userName: ctx.from.username,
      name: ctx.from.first_name,
      source: "telegram",
      channelId: telegramRoomid,
      messageServerId,
      type: channelType,
      worldId,
      worldName: `telegram-chat-${chatId}`,
    });

    const memoryContent: TelegramChatContextContent = {
      text: cleanedContent || " ",
      attachments: cleanedAttachments,
      source: "telegram",
      channelType: channelType,
      inReplyTo:
        "reply_to_message" in message && message.reply_to_message
          ? createUniqueUuid(this.runtime, message.reply_to_message.message_id.toString())
          : undefined,
      chatId,
      userId: ctx.from.id,
      messageId: message.message_id,
      threadId:
        threadId && Number.isFinite(Number(threadId)) ? Number.parseInt(threadId, 10) : undefined,
    };

    const memory: Memory = {
      id: messageId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: memoryContent,
      metadata: {
        type: MemoryType.MESSAGE,
        source: "telegram",
        sourceId,
        entityName: ctx.from.first_name,
        entityUserName: ctx.from.username,
        fromBot: ctx.from.is_bot,
        fromId: chatId,
      } as MessageMetadata & {
        entityName?: string;
        entityUserName?: string;
        fromBot?: boolean;
        fromId?: number;
      },
      createdAt: message.date * 1000,
    };

    const callback: HandlerCallback = async (content: Content, _files?: string[]) => {
      if (!content.text) return [];

      let sentMessages: boolean | Message.TextMessage[] = false;
      if (content?.channelType === "DM") {
        sentMessages = [];
        if (ctx.from) {
          const res = await this.bot.telegram.sendMessage(ctx.from.id, content.text);
          sentMessages.push(res);
        }
      } else {
        sentMessages = await this.sendMessageInChunks(ctx, content, message.message_id);
      }

      if (!Array.isArray(sentMessages)) return [];

      const memories: Memory[] = [];
      for (let i = 0; i < sentMessages.length; i++) {
        const sentMessage = sentMessages[i];

        const responseMemory: Memory = {
          id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            ...content,
            source: "telegram",
            text: sentMessage.text,
            inReplyTo: messageId,
            channelType: channelType,
          },
          createdAt: sentMessage.date * 1000,
        };

        await this.runtime.createMemory(responseMemory, "messages");
        memories.push(responseMemory);
      }

      return memories;
    };

    if (!this.runtime.messageService) {
      logger.error("Message service is not available");
      throw new Error(
        "Message service is not initialized. Ensure the message service is properly configured."
      );
    }
    await this.runtime.messageService.handleMessage(this.runtime, memory, callback);
  }

  /**
   * Handles the reaction event triggered by a user reacting to a message.
   * @param {NarrowedContext<Context<Update>, Update.MessageReactionUpdate>} ctx The context of the message reaction update
   * @returns {Promise<void>} A Promise that resolves when the reaction handling is complete
   */
  public async handleReaction(
    ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>
  ): Promise<void> {
    if (!ctx.update.message_reaction || !ctx.from) return;

    const reaction = ctx.update.message_reaction;
    const reactedToMessageId = reaction.message_id;

    const originalMessagePlaceholder: Partial<Message> = {
      message_id: reactedToMessageId,
      chat: reaction.chat,
      from: ctx.from,
      date: Math.floor(Date.now() / 1000),
    };

    const reactionType = reaction.new_reaction[0].type;
    const reactionEmoji = (reaction.new_reaction[0] as ReactionType).type; // Assuming ReactionType has 'type' for emoji

    const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;
    const roomId = createUniqueUuid(this.runtime, ctx.chat.id.toString());

    const reactionId = createUniqueUuid(
      this.runtime,
      `${reaction.message_id}-${ctx.from.id}-${Date.now()}`
    );

    const memory: Memory = {
      id: reactionId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        channelType: getChannelType(reaction.chat as Chat),
        text: `Reacted with: ${reactionType === "emoji" ? reactionEmoji : reactionType}`,
        source: "telegram",
        inReplyTo: createUniqueUuid(this.runtime, reaction.message_id.toString()),
      },
      createdAt: Date.now(),
    };

    // Create callback for handling reaction responses
    const callback: HandlerCallback = async (content: Content) => {
      // Add null check for content.text
      const replyText = content.text ?? "";
      const sentMessage = await ctx.reply(replyText);
      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          ...content,
          inReplyTo: reactionId,
        },
        createdAt: sentMessage.date * 1000,
      };
      return [responseMemory];
    };

    this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      callback,
      source: "telegram",
      ctx,
      originalMessage: originalMessagePlaceholder as Message,
      reactionString: reactionType === "emoji" ? reactionEmoji : reactionType,
      originalReaction: reaction.new_reaction[0] as ReactionType,
    } as TelegramReactionReceivedPayload);

    this.runtime.emitEvent(TelegramEventTypes.REACTION_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      callback,
      source: "telegram",
      ctx,
      originalMessage: originalMessagePlaceholder as Message, // Cast needed due to placeholder
      reactionString: reactionType === "emoji" ? reactionEmoji : reactionType,
      originalReaction: reaction.new_reaction[0] as ReactionType,
    } as TelegramReactionReceivedPayload);
  }

  /**
   * Sends a message to a Telegram chat and emits appropriate events
   * @param {number | string} chatId - The Telegram chat ID to send the message to
   * @param {Content} content - The content to send
   * @param {number} [replyToMessageId] - Optional message ID to reply to
   * @returns {Promise<Message.TextMessage[]>} The sent messages
   */
  public async sendMessage(
    chatId: number | string,
    content: Content,
    replyToMessageId?: number
  ): Promise<Message.TextMessage[]> {
    const ctx = {
      chat: { id: chatId },
      telegram: this.bot.telegram,
    };

    const sentMessages = await this.sendMessageInChunks(ctx as Context, content, replyToMessageId);

    if (!sentMessages?.length) return [];

    // Create group ID
    const roomId = createUniqueUuid(this.runtime, chatId.toString());

    // Create memories for the sent messages
    const memories: Memory[] = [];
    for (const sentMessage of sentMessages) {
      const memory: Memory = {
        id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          ...content,
          text: sentMessage.text,
          source: "telegram",
          channelType: getChannelType({
            id: typeof chatId === "string" ? Number.parseInt(chatId, 10) : chatId,
            type: "private", // Default to private, will be overridden if in context
          } as Chat),
        },
        createdAt: sentMessage.date * 1000,
      };

      await this.runtime.createMemory(memory, "messages");
      memories.push(memory);
    }

    if (memories.length > 0) {
      this.runtime.emitEvent(EventType.MESSAGE_SENT, {
        runtime: this.runtime,
        message: memories[0],
        source: "telegram",
      });
    }

    this.runtime.emitEvent(
      TelegramEventTypes.MESSAGE_SENT as string,
      {
        runtime: this.runtime,
        source: "telegram",
        originalMessages: sentMessages,
        chatId,
        message: memories[0] || ({} as Memory),
      } as TelegramMessageSentPayload
    );

    return sentMessages;
  }
}
