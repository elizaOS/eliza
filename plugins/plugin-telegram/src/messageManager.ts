import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  ModelType,
  ServiceType,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { Chat, Message, ReactionType, Update, Document } from '@telegraf/types';
import type { Context, NarrowedContext, Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import {
  type TelegramContent,
  TelegramEventTypes,
  type TelegramMessageSentPayload,
  type TelegramReactionReceivedPayload,
} from './types';
import { convertToTelegramButtons, convertMarkdownToTelegram, cleanText } from './utils';
import fs from 'fs';

/**
 * Interface for structured document processing results.
 */
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
  PHOTO = 'photo',
  VIDEO = 'video',
  DOCUMENT = 'document',
  AUDIO = 'audio',
  ANIMATION = 'animation',
}

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const getChannelType = (chat: Chat): ChannelType => {
  // Use a switch statement for clarity and exhaustive checks
  switch (chat.type) {
    case 'private':
      return ChannelType.DM;
    case 'group':
    case 'supergroup':
    case 'channel':
      return ChannelType.GROUP;
    default:
      throw new Error(`Unrecognized Telegram chat type: ${(chat as any).type}`);
  }
};

/**
 * Class representing a message manager.
 * @class
 */
export class MessageManager {
  public bot: Telegraf<Context>;
  protected runtime: IAgentRuntime;

  /**
   * Constructor for creating a new instance of a BotAgent.
   *
   * @param {Telegraf<Context>} bot - The Telegraf instance used for interacting with the bot platform.
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   */
  constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
    this.bot = bot;
    this.runtime = runtime;
  }

  /**
   * Process an image from a Telegram message to extract the image URL and description.
   *
   * @param {Message} message - The Telegram message object containing the image.
   * @returns {Promise<{ description: string } | null>} The description of the processed image or null if no image found.
   */
  async processImage(message: Message): Promise<{ description: string } | null> {
    try {
      let imageUrl: string | null = null;

      logger.info(`Telegram Message: ${JSON.stringify(message, null, 2)}`);

      if ('photo' in message && message.photo?.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
        imageUrl = fileLink.toString();
      } else if (
        'document' in message &&
        message.document?.mime_type?.startsWith('image/') &&
        !message.document?.mime_type?.startsWith('application/pdf')
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
    } catch (error) {
      console.error('❌ Error processing image:', error);
    }

    return null;
  }

  /**
   * Process a document from a Telegram message to extract the document URL and description.
   * Handles PDFs and other document types by converting them to text when possible.
   *
   * @param {Message} message - The Telegram message object containing the document.
   * @returns {Promise<{ description: string } | null>} The description of the processed document or null if no document found.
   */
  async processDocument(message: Message): Promise<DocumentProcessingResult | null> {
    try {
      if (!('document' in message) || !message.document) {
        return null;
      }

      const document = message.document;
      const fileLink = await this.bot.telegram.getFileLink(document.file_id);
      const documentUrl = fileLink.toString();

      logger.info(
        `Processing document: ${document.file_name} (${document.mime_type}, ${document.file_size} bytes)`
      );

      // Centralized document processing based on MIME type
      const documentProcessor = this.getDocumentProcessor(document.mime_type);
      if (documentProcessor) {
        return await documentProcessor(document, documentUrl);
      }

      // Generic fallback for unsupported types
      return {
        title: `Document: ${document.file_name || 'Unknown Document'}`,
        fullText: '',
        formattedDescription: `[Document: ${document.file_name || 'Unknown Document'}\nType: ${document.mime_type || 'unknown'}\nSize: ${document.file_size || 0} bytes]`,
        fileName: document.file_name || 'Unknown Document',
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error({ error }, 'Error processing document');
      return null;
    }
  }

  /**
   * Get the appropriate document processor based on MIME type.
   */
  private getDocumentProcessor(
    mimeType?: string
  ): ((document: Document, url: string) => Promise<DocumentProcessingResult>) | null {
    if (!mimeType) return null;

    const processors = {
      'application/pdf': this.processPdfDocument.bind(this),
      'text/': this.processTextDocument.bind(this), // covers text/plain, text/csv, text/markdown, etc.
      'application/json': this.processTextDocument.bind(this),
    };

    for (const [pattern, processor] of Object.entries(processors)) {
      if (mimeType.startsWith(pattern)) {
        return processor;
      }
    }

    return null;
  }

  /**
   * Process PDF documents by converting them to text.
   */
  private async processPdfDocument(
    document: Document,
    documentUrl: string
  ): Promise<DocumentProcessingResult> {
    try {
      const pdfService = this.runtime.getService(ServiceType.PDF) as any;
      if (!pdfService) {
        logger.warn('PDF service not available, using fallback');
        return {
          title: `PDF Document: ${document.file_name || 'Unknown Document'}`,
          fullText: '',
          formattedDescription: `[PDF Document: ${document.file_name || 'Unknown Document'}\nSize: ${document.file_size || 0} bytes\nUnable to extract text content]`,
          fileName: document.file_name || 'Unknown Document',
          mimeType: document.mime_type,
          fileSize: document.file_size,
        };
      }

      const response = await fetch(documentUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status}`);
      }

      const pdfBuffer = await response.arrayBuffer();
      const text = await pdfService.convertPdfToText(Buffer.from(pdfBuffer));

      logger.info(`PDF processed successfully: ${text.length} characters extracted`);
      return {
        title: document.file_name || 'Unknown Document',
        fullText: text,
        formattedDescription: `[PDF Document: ${document.file_name || 'Unknown Document'}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
        fileName: document.file_name || 'Unknown Document',
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error({ error }, 'Error processing PDF document');
      return {
        title: `PDF Document: ${document.file_name || 'Unknown Document'}`,
        fullText: '',
        formattedDescription: `[PDF Document: ${document.file_name || 'Unknown Document'}\nSize: ${document.file_size || 0} bytes\nError: Unable to extract text content]`,
        fileName: document.file_name || 'Unknown Document',
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }
  }

  /**
   * Process text documents by fetching their content.
   */
  private async processTextDocument(
    document: Document,
    documentUrl: string
  ): Promise<DocumentProcessingResult> {
    try {
      const response = await fetch(documentUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch text document: ${response.status}`);
      }

      const text = await response.text();

      logger.info(`Text document processed successfully: ${text.length} characters extracted`);
      return {
        title: document.file_name || 'Unknown Document',
        fullText: text,
        formattedDescription: `[Text Document: ${document.file_name || 'Unknown Document'}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
        fileName: document.file_name || 'Unknown Document',
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error({ error }, 'Error processing text document');
      return {
        title: `Text Document: ${document.file_name || 'Unknown Document'}`,
        fullText: '',
        formattedDescription: `[Text Document: ${document.file_name || 'Unknown Document'}\nSize: ${document.file_size || 0} bytes\nError: Unable to read content]`,
        fileName: document.file_name || 'Unknown Document',
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }
  }

  /**
   * Processes the message content, documents, and images to generate
   * processed content and media attachments.
   *
   * @param {Message} message The message to process
   * @returns {Promise<{ processedContent: string; attachments: Media[] }>} Processed content and media attachments
   */
  async processMessage(
    message: Message
  ): Promise<{ processedContent: string; attachments: Media[] }> {
    let processedContent = '';
    let attachments: Media[] = [];

    // Get message text
    if ('text' in message && message.text) {
      processedContent = message.text;
    } else if ('caption' in message && message.caption) {
      processedContent = message.caption as string;
    }

    // Process documents
    if ('document' in message && message.document) {
      const document = message.document;
      const documentInfo = await this.processDocument(message);

      if (documentInfo) {
        try {
          const fileLink = await this.bot.telegram.getFileLink(document.file_id);

          // Use structured data directly instead of regex parsing
          const title = documentInfo.title;
          const fullText = documentInfo.fullText;

          // Add document content to processedContent so agent can access it
          if (fullText) {
            const documentContent = `\n\n--- DOCUMENT CONTENT ---\nTitle: ${title}\n\nFull Content:\n${fullText}\n--- END DOCUMENT ---\n\n`;
            processedContent += documentContent;
          }

          attachments.push({
            id: document.file_id,
            url: fileLink.toString(),
            title: title,
            source: document.mime_type?.startsWith('application/pdf') ? 'PDF' : 'Document',
            description: documentInfo.formattedDescription,
            text: fullText,
          });
          logger.info(`Document processed successfully: ${documentInfo.fileName}`);
        } catch (error) {
          logger.error({ error }, `Error processing document ${documentInfo.fileName}`);
          // Add a fallback attachment even if processing failed
          attachments.push({
            id: document.file_id,
            url: '',
            title: `Document: ${documentInfo.fileName}`,
            source: 'Document',
            description: `Document processing failed: ${documentInfo.fileName}`,
            text: `Document: ${documentInfo.fileName}\nSize: ${documentInfo.fileSize || 0} bytes\nType: ${documentInfo.mimeType || 'unknown'}`,
          });
        }
      } else {
        // Add a basic attachment even if documentInfo is null
        attachments.push({
          id: document.file_id,
          url: '',
          title: `Document: ${document.file_name || 'Unknown Document'}`,
          source: 'Document',
          description: `Document: ${document.file_name || 'Unknown Document'}`,
          text: `Document: ${document.file_name || 'Unknown Document'}\nSize: ${document.file_size || 0} bytes\nType: ${document.mime_type || 'unknown'}`,
        });
      }
    }

    // Process images
    if ('photo' in message && message.photo?.length > 0) {
      const imageInfo = await this.processImage(message);
      if (imageInfo) {
        const photo = message.photo[message.photo.length - 1];
        const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
        attachments.push({
          id: photo.file_id,
          url: fileLink.toString(),
          title: 'Image Attachment',
          source: 'Image',
          description: imageInfo.description,
          text: imageInfo.description,
        });
      }
    }

    logger.info(
      `Message processed - Content: ${processedContent ? 'yes' : 'no'}, Attachments: ${attachments.length}`
    );

    return { processedContent, attachments };
  }

  /**
   * Sends a message in chunks, handling attachments and splitting the message if necessary
   *
   * @param {Context} ctx - The context object representing the current state of the bot
   * @param {TelegramContent} content - The content of the message to be sent
   * @param {number} [replyToMessageId] - The ID of the message to reply to, if any
   * @returns {Promise<Message.TextMessage[]>} - An array of TextMessage objects representing the messages sent
   */
  async sendMessageInChunks(
    ctx: Context,
    content: TelegramContent,
    replyToMessageId?: number
  ): Promise<Message.TextMessage[]> {
    if (content.attachments && content.attachments.length > 0) {
      content.attachments.map(async (attachment: Media) => {
        const typeMap: { [key: string]: MediaType } = {
          'image/gif': MediaType.ANIMATION,
          image: MediaType.PHOTO,
          doc: MediaType.DOCUMENT,
          video: MediaType.VIDEO,
          audio: MediaType.AUDIO,
        };

        let mediaType: MediaType | undefined = undefined;

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
      const chunks = this.splitMessage(content.text ?? '');
      const sentMessages: Message.TextMessage[] = [];

      const telegramButtons = convertToTelegramButtons(content.buttons ?? []);

      if (!ctx.chat) {
        logger.error('sendMessageInChunks: ctx.chat is undefined');
        return [];
      }
      await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');

      for (let i = 0; i < chunks.length; i++) {
        const chunk = convertMarkdownToTelegram(chunks[i]);
        if (!ctx.chat) {
          logger.error('sendMessageInChunks loop: ctx.chat is undefined');
          continue;
        }
        const sentMessage = (await ctx.telegram.sendMessage(ctx.chat.id, chunk, {
          reply_parameters:
            i === 0 && replyToMessageId ? { message_id: replyToMessageId } : undefined,
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard(telegramButtons),
        })) as Message.TextMessage;

        sentMessages.push(sentMessage);
      }

      return sentMessages;
    }
  }

  /**
   * Sends media to a chat using the Telegram API.
   *
   * @param {Context} ctx - The context object containing information about the current chat.
   * @param {string} mediaPath - The path to the media to be sent, either a URL or a local file path.
   * @param {MediaType} type - The type of media being sent (PHOTO, VIDEO, DOCUMENT, AUDIO, or ANIMATION).
   * @param {string} [caption] - Optional caption for the media being sent.
   *
   * @returns {Promise<void>} A Promise that resolves when the media is successfully sent.
   */
  async sendMedia(
    ctx: Context,
    mediaPath: string,
    type: MediaType,
    caption?: string
  ): Promise<void> {
    try {
      const isUrl = /^(http|https):\/\//.test(mediaPath);
      const sendFunctionMap: Record<MediaType, Function> = {
        [MediaType.PHOTO]: ctx.telegram.sendPhoto.bind(ctx.telegram),
        [MediaType.VIDEO]: ctx.telegram.sendVideo.bind(ctx.telegram),
        [MediaType.DOCUMENT]: ctx.telegram.sendDocument.bind(ctx.telegram),
        [MediaType.AUDIO]: ctx.telegram.sendAudio.bind(ctx.telegram),
        [MediaType.ANIMATION]: ctx.telegram.sendAnimation.bind(ctx.telegram),
      };

      const sendFunction = sendFunctionMap[type];

      if (!sendFunction) {
        throw new Error(`Unsupported media type: ${type}`);
      }

      if (!ctx.chat) {
        throw new Error('sendMedia: ctx.chat is undefined');
      }

      if (isUrl) {
        // Handle HTTP URLs
        await sendFunction(ctx.chat.id, mediaPath, { caption });
      } else {
        // Handle local file paths
        if (!fs.existsSync(mediaPath)) {
          throw new Error(`File not found at path: ${mediaPath}`);
        }

        const fileStream = fs.createReadStream(mediaPath);

        try {
          if (!ctx.chat) {
            throw new Error('sendMedia (file): ctx.chat is undefined');
          }
          await sendFunction(ctx.chat.id, { source: fileStream }, { caption });
        } finally {
          fileStream.destroy();
        }
      }

      logger.info(
        `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully: ${mediaPath}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { originalError: error },
        `Failed to send ${type}. Path: ${mediaPath}. Error: ${errorMessage}`
      );
      throw error;
    }
  }

  /**
   * Splits a given text into an array of strings based on the maximum message length.
   *
   * @param {string} text - The text to split into chunks.
   * @returns {string[]} An array of strings with each element representing a chunk of the original text.
   */
  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    if (!text) return chunks;
    let currentChunk = '';

    const lines = text.split('\n');
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
        currentChunk += (currentChunk ? '\n' : '') + line;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = line;
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  /**
   * Handle incoming messages from Telegram and process them accordingly.
   * @param {Context} ctx - The context object containing information about the message.
   * @returns {Promise<void>}
   */
  public async handleMessage(ctx: Context): Promise<void> {
    // Type guard to ensure message exists
    if (!ctx.message || !ctx.from) return;

    const message = ctx.message as Message.TextMessage;

    try {
      // Convert IDs to UUIDs
      const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;

      const threadId =
        'is_topic_message' in message && message.is_topic_message
          ? message.message_thread_id?.toString()
          : undefined;

      // Add null check for ctx.chat
      if (!ctx.chat) {
        logger.error('handleMessage: ctx.chat is undefined');
        return;
      }
      // Generate room ID based on whether this is in a forum topic
      const telegramRoomid = threadId ? `${ctx.chat.id}-${threadId}` : ctx.chat.id.toString();
      const roomId = createUniqueUuid(this.runtime, telegramRoomid) as UUID;

      // Get message ID (unique to channel)
      const messageId = createUniqueUuid(this.runtime, message?.message_id?.toString());

      // Process message content and attachments
      const { processedContent, attachments } = await this.processMessage(message);

      // Clean processedContent and attachments to avoid NULL characters
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

      // Get chat type and determine channel type
      const chat = message.chat as Chat;
      const channelType = getChannelType(chat);

      const sourceId = createUniqueUuid(this.runtime, '' + chat.id);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: ctx.from.username,
        name: ctx.from.first_name,
        source: 'telegram',
        channelId: telegramRoomid,
        serverId: undefined,
        type: channelType,
        worldId: createUniqueUuid(this.runtime, roomId) as UUID,
        worldName: telegramRoomid,
      });

      // Create the memory object
      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: cleanedContent || ' ',
          attachments: cleanedAttachments,
          source: 'telegram',
          channelType: channelType,
          inReplyTo:
            'reply_to_message' in message && message.reply_to_message
              ? createUniqueUuid(this.runtime, message.reply_to_message.message_id.toString())
              : undefined,
        },
        metadata: {
          entityName: ctx.from.first_name,
          entityUserName: ctx.from.username,
          fromBot: ctx.from.is_bot,
          // include very technical/exact reference to this user for security reasons
          // don't remove or change this, spartan needs this
          fromId: chat.id,
          sourceId,
          // why message? all Memories contain content (which is basically a message)
          // what are the other types? see MemoryType
          type: 'message', // MemoryType.MESSAGE
          // scope: `shared`, `private`, or `room`
        },
        createdAt: message.date * 1000,
      };

      // Create callback for handling responses
      const callback: HandlerCallback = async (content: Content, _files?: string[]) => {
        try {
          // If response is from reasoning do not send it.
          if (!content.text) return [];

          let sentMessages: boolean | Message.TextMessage[] = false;
          // channelType target === 'telegram'
          if (content?.channelType === 'DM') {
            sentMessages = [];
            if (ctx.from) {
              // FIXME split on 4096 chars
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
                source: 'telegram',
                text: sentMessage.text,
                inReplyTo: messageId,
                channelType: channelType,
              },
              createdAt: sentMessage.date * 1000,
            };

            await this.runtime.createMemory(responseMemory, 'messages');
            memories.push(responseMemory);
          }

          return memories;
        } catch (error) {
          logger.error({ error }, 'Error in message callback');
          return [];
        }
      };

      // Call the message handler directly instead of emitting events
      // This provides a clearer, more traceable flow for message processing
      if (!this.runtime.messageService) {
        logger.error('Message service is not available');
        throw new Error(
          'Message service is not initialized. Ensure the message service is properly configured.'
        );
      }
      await this.runtime.messageService.handleMessage(this.runtime, memory, callback);
    } catch (error) {
      logger.error(
        {
          error,
          chatId: ctx.chat?.id,
          messageId: ctx.message?.message_id,
          from: ctx.from?.username || ctx.from?.id,
        },
        'Error handling Telegram message'
      );
      throw error;
    }
  }

  /**
   * Handles the reaction event triggered by a user reacting to a message.
   * @param {NarrowedContext<Context<Update>, Update.MessageReactionUpdate>} ctx The context of the message reaction update
   * @returns {Promise<void>} A Promise that resolves when the reaction handling is complete
   */
  public async handleReaction(
    ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>
  ): Promise<void> {
    // Ensure we have the necessary data
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

    try {
      const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;
      const roomId = createUniqueUuid(this.runtime, ctx.chat.id.toString());

      const reactionId = createUniqueUuid(
        this.runtime,
        `${reaction.message_id}-${ctx.from.id}-${Date.now()}`
      );

      // Create reaction memory
      const memory: Memory = {
        id: reactionId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          channelType: getChannelType(reaction.chat as Chat),
          text: `Reacted with: ${reactionType === 'emoji' ? reactionEmoji : reactionType}`,
          source: 'telegram',
          inReplyTo: createUniqueUuid(this.runtime, reaction.message_id.toString()),
        },
        createdAt: Date.now(),
      };

      // Create callback for handling reaction responses
      const callback: HandlerCallback = async (content: Content) => {
        try {
          // Add null check for content.text
          const replyText = content.text ?? '';
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
        } catch (error) {
          logger.error({ error }, 'Error in reaction callback');
          return [];
        }
      };

      // Let the bootstrap plugin handle the reaction
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'telegram',
        ctx,
        originalMessage: originalMessagePlaceholder as Message, // Cast needed due to placeholder
        reactionString: reactionType === 'emoji' ? reactionEmoji : reactionType,
        originalReaction: reaction.new_reaction[0] as ReactionType,
      } as TelegramReactionReceivedPayload);

      // Also emit the platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'telegram',
        ctx,
        originalMessage: originalMessagePlaceholder as Message, // Cast needed due to placeholder
        reactionString: reactionType === 'emoji' ? reactionEmoji : reactionType,
        originalReaction: reaction.new_reaction[0] as ReactionType,
      } as TelegramReactionReceivedPayload);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          error: errorMessage,
          originalError: error,
        },
        'Error handling reaction'
      );
    }
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
    try {
      // Create a context-like object for sending
      const ctx = {
        chat: { id: chatId },
        telegram: this.bot.telegram,
      };

      const sentMessages = await this.sendMessageInChunks(
        ctx as Context,
        content,
        replyToMessageId
      );

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
            source: 'telegram',
            channelType: getChannelType({
              id: typeof chatId === 'string' ? Number.parseInt(chatId, 10) : chatId,
              type: 'private', // Default to private, will be overridden if in context
            } as Chat),
          },
          createdAt: sentMessage.date * 1000,
        };

        await this.runtime.createMemory(memory, 'messages');
        memories.push(memory);
      }

      // Emit both generic and platform-specific message sent events
      this.runtime.emitEvent(EventType.MESSAGE_SENT, {
        runtime: this.runtime,
        message: {
          content: content,
        },
        roomId,
        source: 'telegram',
      });

      // Also emit platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.MESSAGE_SENT, {
        originalMessages: sentMessages,
        chatId,
      } as TelegramMessageSentPayload);

      return sentMessages;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          error: errorMessage,
          originalError: error,
        },
        'Error sending message to Telegram'
      );
      return [];
    }
  }
}
