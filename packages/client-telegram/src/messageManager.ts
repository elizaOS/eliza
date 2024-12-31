import { Message } from "@telegraf/types";
import { Context, Telegraf } from "telegraf";

import { composeContext, elizaLogger, embed, ServiceType } from "@ai16z/eliza";
import { getEmbeddingZeroVector, getRelevantContext } from "@ai16z/eliza";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    ModelClass,
    State,
    UUID,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

import { generateMessageResponse, generateShouldRespond } from "@ai16z/eliza";
import { messageCompletionFooter, shouldRespondFooter } from "@ai16z/eliza";

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const telegramShouldRespondTemplate =
    `# About {{agentName}}:
{{bio}}

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

{{user1}}: @{{agentName}} what's your favorite movie?
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{user1}}: Hey {{agentName}}, can you help me with something
Result: [RESPOND]

{{user1}}: this is interesting
{{agentName}}: Indeed it is!
{{user1}}: tell me more
Result: [IGNORE]

{{user1}}: i need help
Result: [IGNORE]

{{user1}}: @{{agentName}} can you help me with this?
Result: [RESPOND]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} should ONLY respond in these cases:
1. When explicitly tagged with @{{agentName}}
2. When directly addressed by name (e.g., "Hey {{agentName}}")
3. When in a private chat

Even if {{agentName}} was previously part of the conversation, they should NOT continue unless explicitly addressed again.

Respond with [IGNORE] in these cases:
- Messages not explicitly directed at {{agentName}}
- Follow-up messages where {{agentName}} isn't tagged/mentioned again
- General chat messages
- Short or vague messages
- Ongoing conversations where {{agentName}} isn't specifically called upon

If a user asks {{agentName}} to be quiet, respond with [STOP]

IMPORTANT: When in doubt, always choose [IGNORE]. {{agentName}} should err strongly on the side of staying quiet.

The goal is to decide whether {{agentName}} should respond to the last message.

{{recentMessages}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Remember to default to [IGNORE] unless explicitly addressed.
` + shouldRespondFooter;

const telegramMessageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Relevant Past Conversations
{{#each relevantMemories}}
Time: {{this.createdAt}}
User: {{this.userId}}
Content: {{this.content.text}}
Relevance: {{this.similarity}}
---
{{/each}}

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{providers}}

{{attachments}}

{{actions}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

# Task: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:
Current Post:
{{currentPost}}
Thread of Tweets You Are Replying To:

{{formattedConversation}}
` + messageCompletionFooter;

export class MessageManager {
    public bot: Telegraf<Context>;
    private runtime: IAgentRuntime;

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
                const imageDescriptionService =
                    this.runtime.getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    );
                const { title, description } =
                    await imageDescriptionService.describeImage(imageUrl);
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
                modelClass: ModelClass.SMALL,
            });

            return response === "RESPOND";
        }

        return false;
    }

    private async hasPermissionToSend(
        ctx: Context,
        chatId: number
    ): Promise<boolean> {
        try {
            const chat = await ctx.telegram.getChat(chatId);
            const me = await ctx.telegram.getMe();
            const member = await ctx.telegram.getChatMember(chatId, me.id);

            // Check if the bot is an admin (admins don't have explicit can_send_messages)
            if (
                member.status === "administrator" ||
                member.status === "creator"
            ) {
                return true;
            }

            // For regular members, they can send messages by default
            return member.status === "member";
        } catch (error) {
            console.warn(
                `Cannot verify permissions for chat ${chatId}:`,
                error.message
            );
            return false;
        }
    }

    private async sendWithRetry(
        ctx: Context,
        params: {
            chat_id: number,
            [key: string]: any,
            options?: any
        },
        maxRetries = 1000
    ): Promise<any> {
        let lastError;
        for (let i = 0; i < maxRetries; i++) {
            try {
                if (!await this.hasPermissionToSend(ctx, params.chat_id)) {
                    console.warn(`Bot lacks permission to send content in chat ${params.chat_id}`);
                    return null;
                }

                const methodMap = {
                    'text': 'sendMessage',
                    'imageGeneration': 'sendPhoto',
                    'videoGeneration': 'sendVideo'
                };

                const contentKey = Object.keys(params).find(key => key in methodMap);

                if (!contentKey) {
                    throw new Error('No valid content type found in params');
                }

                const method = methodMap[contentKey];
                let content = typeof params[contentKey] === 'object' ? params[contentKey].source : params[contentKey];

                // Handle local file paths for images and videos
                if ((contentKey === 'imageGeneration' || contentKey === 'videoGeneration') &&
                    content && typeof content === 'object' && content.url &&
                    content.url.startsWith('/')) {
                    // Use the file path directly with { source: filepath } format
                    content = { source: content.url };
                }

                return await ctx.telegram[method](
                    params.chat_id,
                    content,
                    params.options
                );

            } catch (error) {
                lastError = error;
                if (error?.response?.error_code === 429) {
                    const retryAfter = error?.response?.parameters?.retry_after || 10;
                    console.log(`Rate limited. Waiting ${retryAfter} seconds before retry ${i + 1}/${maxRetries}`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    continue;
                }
                if (error?.response?.error_code === 400 && error?.response?.description?.includes('not enough rights')) {
                    console.warn(`Bot lacks permission in chat ${params.chat_id}: ${error.response.description}`);
                    return null;
                }
                throw error;
            }
        }
        throw lastError;
    }

    // Send long messages in chunks
    private async sendMessageInChunks(
        ctx: Context,
        content: string,
        replyToMessageId?: number
    ): Promise<Message.TextMessage[]> {
        const chunks = this.splitMessage(content);
        const sentMessages: Message.TextMessage[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const sentMessage = (await ctx.telegram.sendMessage(
                ctx.chat.id,
                chunk,
                {
                    reply_parameters:
                        i === 0 && replyToMessageId
                            ? { message_id: replyToMessageId }
                            : undefined,
                }
            )) as Message.TextMessage;

            sentMessages.push(sentMessage);
        }

        return sentMessages;
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
            modelClass: ModelClass.SMALL,
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
                message.message_id.toString() + "-" + this.runtime.agentId
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


            const relevantMemories = await getRelevantContext(this.runtime, memory, "memories");

            // Format relevant memories to extract important info
            const formattedMemories = relevantMemories.map(memory => ({
                content: memory.content,
                createdAt: memory.createdAt,
                userId: memory.userId,
                similarity: memory.similarity
            }));

            // Update state with the new memory
            let state = await this.runtime.composeState(memory, {
                relevantMemories: formattedMemories,
            });
            state = await this.runtime.updateRecentMessageState(state);

            // Decide whether to respond
            const shouldRespond = await this._shouldRespond(message, state);

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
                    templatingEngine: "handlebars",
                });
                elizaLogger.debug("Context with relevant memories:", context);
                const responseContent = await this._generateResponse(
                    memory,
                    state,
                    context
                );

                if (!responseContent || !responseContent.text) return;

                // Send response in chunks
                const callback: HandlerCallback = async (content: Content) => {
                    const sentMessages = await this.sendMessageInChunks(
                        ctx,
                        content.text,
                        message.message_id
                    );

                    if (
                        content.attachments &&
                        Array.isArray(content.attachments) &&
                        content.attachments.length > 0
                    ) {
                        console.log(
                            "Sending image files:",
                            content.attachments
                        );
                        for (const attachment of content.attachments) {
                            const contentType = attachment.source || "text";

                            await this.sendWithRetry(ctx, {
                                chat_id: ctx.chat.id,
                                [contentType]:
                                    contentType === "text"
                                        ? attachment
                                        : { source: attachment },
                                options: {},
                            });
                        }
                    }

                    const memories: Memory[] = [];

                    // Create memories for each sent message
                    for (let i = 0; i < sentMessages.length; i++) {
                        const sentMessage = sentMessages[i];
                        const isLastMessage = i === sentMessages.length - 1;

                        const memory: Memory = {
                            id: stringToUuid(
                                sentMessage.message_id.toString() +
                                    "-" +
                                    this.runtime.agentId
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

                        await this.runtime.messageManager.addEmbeddingToMemory(memory);
                        await this.runtime.messageManager.createMemory(memory);
                        memories.push(memory);
                    }

                    return memories;
                };

                // Execute callback to send messages and log memories
                const responseMessages = await callback(responseContent);

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

            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            elizaLogger.error("❌ Error handling message:", error);
            elizaLogger.error("Error sending message:", error);
        }
    }
}
