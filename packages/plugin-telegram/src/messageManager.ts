import {
    ModelClass,
    composeContext,
    type Content,
    generateMessageResponse,
    generateShouldRespond,
    type HandlerCallback,
    type IAgentRuntime,
    logger,
    type Media,
    type Memory,
    type State,
    stringToUuid,
    type UUID,
} from "@elizaos/core";
import type { Message } from "@telegraf/types";
import type { Context, Telegraf } from "telegraf";
import {
    telegramMessageHandlerTemplate,
    telegramShouldRespondTemplate
} from "./templates";
import { escapeMarkdown } from "./utils";

import fs from "fs";

enum MediaType {
    PHOTO = "photo",
    VIDEO = "video",
    DOCUMENT = "document",
    AUDIO = "audio",
    ANIMATION = "animation",
}

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

interface MessageContext {
    content: string;
    timestamp: number;
}

export type InterestChats = {
    [key: string]: {
        currentHandler: string | undefined;
        lastMessageSent: number;
        messages: { userId: UUID; userName: string; content: Content }[];
        previousContext?: MessageContext;
        contextSimilarityThreshold?: number;
    };
};

export class MessageManager {
    public bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private interestChats: InterestChats = {};
    private teamMemberUsernames: Map<string, string> = new Map();

    private lastChannelActivity: { [channelId: string]: number } = {};
    private autoPostInterval: NodeJS.Timeout;

    constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
        this.bot = bot;
        this.runtime = runtime;
    }

    // Process image messages and generate descriptions
    private async processImage(
        message: Message
    ): Promise<{ description: string } | null> {
        try {
            let imageUrl: string | null = null;

            logger.info(`Telegram Message: ${message}`);

            if ("photo" in message && message.photo?.length > 0) {
                const photo = message.photo[message.photo.length - 1];
                const fileLink = await this.bot.telegram.getFileLink(
                    photo.file_id
                );
                imageUrl = fileLink.toString();
            } else if (
                "document" in message &&
                message.document?.mime_type?.startsWith("image/")
            ) {
                const fileLink = await this.bot.telegram.getFileLink(
                    message.document.file_id
                );
                imageUrl = fileLink.toString();
            }

            if (imageUrl) {
                const { title, description } =
                    await this.runtime.useModel(ModelClass.IMAGE_DESCRIPTION, imageUrl)
                return { description: `[Image: ${title}\n${description}]` };
            }
        } catch (error) {
            console.error("❌ Error processing image:", error);
        }

        return null;
    }

    // Decide if the bot should respond to the message
    private async _shouldRespond(
        message: Message,
        state: State
    ): Promise<boolean> {
        // Respond if bot is mentioned
        if (
            "text" in message &&
            message.text?.includes(`@${this.bot.botInfo?.username}`)
        ) {
            logger.info(`Bot mentioned`);
            return true;
        }

        // Respond to private chats
        if (message.chat.type === "private") {
            return true;
        }

        // Don't respond to images in group chats
        if (
            "photo" in message ||
            ("document" in message &&
                message.document?.mime_type?.startsWith("image/"))
        ) {
            return false;
        }

        // Use AI to decide for text or captions
        if ("text" in message || ("caption" in message && message.caption)) {
            const shouldRespondContext = composeContext({
                state,
                template:
                    this.runtime.character.templates
                        ?.telegramShouldRespondTemplate ||
                    this.runtime.character?.templates?.shouldRespondTemplate ||
                    telegramShouldRespondTemplate,
            });

            const response = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.TEXT_SMALL,
            });

            return response === "RESPOND";
        }

        return false;
    }

    // Send long messages in chunks
    private async sendMessageInChunks(
        ctx: Context,
        content: Content,
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

                let mediaType: MediaType | undefined = undefined;

                for (const prefix in typeMap) {
                    if (attachment.contentType.startsWith(prefix)) {
                        mediaType = typeMap[prefix];
                        break;
                    }
                }

                if (!mediaType) {
                    throw new Error(
                        `Unsupported Telegram attachment content type: ${attachment.contentType}`
                    );
                }

                await this.sendMedia(
                    ctx,
                    attachment.url,
                    mediaType,
                    attachment.description
                );
            });
        } else {
            const chunks = this.splitMessage(content.text);
            const sentMessages: Message.TextMessage[] = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunk = escapeMarkdown(chunks[i]);
                const sentMessage = (await ctx.telegram.sendMessage(
                    ctx.chat.id,
                    chunk,
                    {
                        reply_parameters:
                            i === 0 && replyToMessageId
                                ? { message_id: replyToMessageId }
                                : undefined,
                        parse_mode: "Markdown",
                    }
                )) as Message.TextMessage;

                sentMessages.push(sentMessage);
            }

            return sentMessages;
        }
    }

    private async sendMedia(
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
                [MediaType.DOCUMENT]: ctx.telegram.sendDocument.bind(
                    ctx.telegram
                ),
                [MediaType.AUDIO]: ctx.telegram.sendAudio.bind(ctx.telegram),
                [MediaType.ANIMATION]: ctx.telegram.sendAnimation.bind(
                    ctx.telegram
                ),
            };

            const sendFunction = sendFunctionMap[type];

            if (!sendFunction) {
                throw new Error(`Unsupported media type: ${type}`);
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
                    await sendFunction(
                        ctx.chat.id,
                        { source: fileStream },
                        { caption }
                    );
                } finally {
                    fileStream.destroy();
                }
            }

            logger.info(
                `${
                    type.charAt(0).toUpperCase() + type.slice(1)
                } sent successfully: ${mediaPath}`
            );
        } catch (error) {
            logger.error(
                `Failed to send ${type}. Path: ${mediaPath}. Error: ${error.message}`
            );
            logger.debug(error.stack);
            throw error;
        }
    }

    // Split message into smaller parts
    private splitMessage(text: string): string[] {
        const chunks: string[] = [];
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

    // Generate a response using AI
    private async _generateResponse(
        message: Memory,
        _state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.TEXT_LARGE,
        });

        if (!response) {
            console.error("❌ No response from generateMessageResponse");
            return null;
        }

        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId,
            roomId,
            type: "response",
        });

        return response;
    }

    // Main handler for incoming messages
    public async handleMessage(ctx: Context): Promise<void> {
        if (!ctx.message || !ctx.from) {
            return; // Exit if no message or sender info
        }

        this.lastChannelActivity[ctx.chat.id.toString()] = Date.now();

        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreBotMessages &&
            ctx.from.is_bot
        ) {
            return;
        }
        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreDirectMessages &&
            ctx.chat?.type === "private"
        ) {
            return;
        }

        const message = ctx.message;

        console.log("message", message);

        try {
            // Convert IDs to UUIDs
            const userId = stringToUuid(ctx.from.id.toString()) as UUID;

            // Get user name
            const userName =
                ctx.from.username || ctx.from.first_name || "Unknown User";

            // Get chat ID
            const chatId = stringToUuid(
                ctx.chat?.id.toString() + "-" + this.runtime.agentId
            ) as UUID;

            // Get agent ID
            const agentId = this.runtime.agentId;

            // Get room ID
            const roomId = chatId;

            // Ensure connection
            await this.runtime.ensureConnection(
                userId,
                roomId,
                userName,
                userName,
                "telegram"
            );

            // Get message ID
            const messageId = stringToUuid(
                roomId + "-" + message.message_id.toString()
            ) as UUID;

            // Handle images
            const imageInfo = await this.processImage(message);

            // Get text or caption
            let messageText = "";
            if ("text" in message) {
                messageText = message.text;
            } else if ("caption" in message && message.caption) {
                messageText = message.caption;
            }

            // Combine text and image description
            const fullText = imageInfo
                ? `${messageText} ${imageInfo.description}`
                : messageText;

            if (!fullText) {
                return; // Skip if no content
            }

            // Create content
            const content: Content = {
                text: fullText,
                source: "telegram",
                inReplyTo:
                    "reply_to_message" in message && message.reply_to_message
                        ? stringToUuid(
                              message.reply_to_message.message_id.toString() +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
            };

            // Create memory for the message
            const memory: Memory = {
                id: messageId,
                agentId,
                userId,
                roomId,
                content,
                createdAt: message.date * 1000,
            };

            // Create memory
            await this.runtime.messageManager.createMemory(memory);

            // Update state with the new memory
            let state = await this.runtime.composeState(memory);
            state = await this.runtime.updateRecentMessageState(state);

            // Decide whether to respond
            const shouldRespond = await this._shouldRespond(message, state);

            // Send response in chunks
            const callback: HandlerCallback = async (content: Content) => {
                const sentMessages = await this.sendMessageInChunks(
                    ctx,
                    content,
                    message.message_id
                );
                if (sentMessages) {
                    const memories: Memory[] = [];

                    // Create memories for each sent message
                    for (let i = 0; i < sentMessages.length; i++) {
                        const sentMessage = sentMessages[i];
                        const isLastMessage = i === sentMessages.length - 1;

                        const memory: Memory = {
                            id: stringToUuid(
                                roomId + "-" + sentMessage.message_id.toString()
                            ),
                            agentId,
                            userId: agentId,
                            roomId,
                            content: {
                                ...content,
                                text: sentMessage.text,
                                inReplyTo: messageId,
                            },
                            createdAt: sentMessage.date * 1000,
                        };

                        // Set action to CONTINUE for all messages except the last one
                        // For the last message, use the original action from the response content
                        memory.content.action = !isLastMessage
                            ? "CONTINUE"
                            : content.action;

                        await this.runtime.messageManager.createMemory(memory);
                        memories.push(memory);
                    }

                    return memories;
                }
            };

            if (shouldRespond) {
                // Generate response
                const context = composeContext({
                    state,
                    template:
                        this.runtime.character.templates
                            ?.telegramMessageHandlerTemplate ||
                        this.runtime.character?.templates
                            ?.messageHandlerTemplate ||
                        telegramMessageHandlerTemplate,
                });

                const responseContent = await this._generateResponse(
                    memory,
                    state,
                    context
                );

                if (!responseContent || !responseContent.text) return;
                const responseMessages = [
                    {
                        id: stringToUuid(messageId + "-" + this.runtime.agentId),
                        userId: this.runtime.agentId,
                        agentId: this.runtime.agentId,
                        content: responseContent,
                        roomId,
                        createdAt: Date.now(),
                    }
                ]

                // Update state after response
                state = await this.runtime.updateRecentMessageState(state);

                // Handle any resulting actions
                await this.runtime.processActions(
                    memory,
                    responseMessages,
                    state,
                    callback
                );
            }

            await this.runtime.evaluate(memory, state, shouldRespond, callback);
        } catch (error) {
            logger.error("❌ Error handling message:", error);
            logger.error("Error sending message:", error);
        }
    }
}
