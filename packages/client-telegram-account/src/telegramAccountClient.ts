import {
    IAgentRuntime,
    UUID,
    Content,
    Memory,
    HandlerCallback,
    ModelClass,
    State,
    Media,
    elizaLogger,
    getEmbeddingZeroVector,
    composeContext,
    generateMessageResponse,
    stringToUuid
} from "@elizaos/core";
import { TelegramAccountConfig } from "./environment.ts";
import { TelegramClient, Api } from "telegram";
import { StoreSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Entity } from "telegram/define";
import input from "input";
import bigInt from "big-integer";
import { getTelegramAccountMessageHandlerTemplate } from "./templates.ts"
import { escapeMarkdown, splitMessage } from "./utils.ts";

export class TelegramAccountClient {
    private runtime: IAgentRuntime;
    private telegramAccountConfig: TelegramAccountConfig;
    private client: TelegramClient;
    private account: Api.User;

    constructor(runtime: IAgentRuntime, telegramAccountConfig: TelegramAccountConfig) {
        elizaLogger.log("📱 Constructing new TelegramAccountClient...");

        this.runtime = runtime;
        this.telegramAccountConfig = telegramAccountConfig;

        elizaLogger.log("✅ TelegramClient constructor completed");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Telegram account...");

        try {
            await this.initializeAccount();
            this.setupEventsHandlers();

            elizaLogger.success(`✅ Telegram account client successfully started for character ${this.runtime.character.name}`);
        } catch (error) {
            elizaLogger.error("❌ Failed to launch Telegram account:", error);
            throw error;
        }
    }

    private async initializeAccount(): Promise<void> {
        // Prepare telegram account client
        this.client =  new TelegramClient(
            new StoreSession('./data/telegram_account_session'),
            this.telegramAccountConfig.TELEGRAM_ACCOUNT_APP_ID,
            this.telegramAccountConfig.TELEGRAM_ACCOUNT_APP_HASH,
            {
                connectionRetries: 5,
                deviceModel: this.telegramAccountConfig.TELEGRAM_ACCOUNT_DEVICE_MODEL,
                systemVersion: this.telegramAccountConfig.TELEGRAM_ACCOUNT_SYSTEM_VERSION,
            }
        )

        // Account sign in or connect
        await this.client.start({
            phoneNumber: this.telegramAccountConfig.TELEGRAM_ACCOUNT_PHONE,
            password: null,
            phoneCode: async () => await input.text('Enter received Telegram code: '),
            onError: (err) => console.log(err),
        });

        this.client.session.save();

        // Testing connection
        this.account = await this.client.getEntity('me') as Api.User;
    }

    private setupEventsHandlers(): void {
        this.newMessageHandler()
    }

    private newMessageHandler() {
        this.client.addEventHandler(async (event: NewMessageEvent) => {
            try {
                if (!event.message.message) return;

                // Get sender and chat full object
                const sender = await event.message.getSender();
                if (sender.className != 'User') return;

                const chat = (await event.message.getChat());
                if (chat.className != 'User' && chat.className != 'Chat' && (chat.className == 'Channel' && !chat.megagroup)) return;

                // Get user full name
                let senderName = sender.firstName;
                if (sender.lastName) senderName += ' ' + sender.lastName;

                // Get reply message
                let replyMessage = null;
                if (event.message.replyTo) {
                    replyMessage = await event.message.getReplyMessage()
                }

                // Convert IDs to UUIDs
                const userUUID = stringToUuid(`tg-${sender.id.toString()}`) as UUID;
                const roomUUID = stringToUuid(`tg-${chat.id.toString()}` + "-" + this.runtime.agentId) as UUID;
                const messageUUID = stringToUuid(`tg-message-${roomUUID}-${event.message.id.toString()}` + "-" + this.runtime.agentId) as UUID;
                const agentUUID = this.runtime.agentId;
                const replyMessageUUID = replyMessage ? stringToUuid(`tg-message-${roomUUID}-${replyMessage.id.toString()}` + "-" + this.runtime.agentId) as UUID : null;

                // Ensure connection
                await this.runtime.ensureConnection(
                    userUUID,
                    roomUUID,
                    sender.username,
                    senderName,
                    "telegram-account",
                );

                if (!event.message.message) return;

                // Create content
                const content: Content = {
                    text: event.message.message,
                    inReplyTo: replyMessageUUID,
                    source: "telegram-account",
                };

                // Create memory for the message
                const memory: Memory = {
                    id: messageUUID,
                    agentId: agentUUID,
                    userId: userUUID,
                    roomId: roomUUID,
                    content,
                    createdAt: event.message.date * 1000,
                    embedding: getEmbeddingZeroVector(),
                };

                // Create memory
                await this.runtime.messageManager.createMemory(memory);

                // Update state with the new memory
                let state = await this.runtime.composeState(memory);
                state = await this.runtime.updateRecentMessageState(state);

                // Decide whether to respond
                const shouldRespond = await this._shouldRespond(event.message, chat, replyMessage);

                // Send response in chunks
                const callback: HandlerCallback = async (content: Content) => {
                    const sentMessages = await this.sendMessageInChunks(
                        chat.id,
                        content,
                        chat.className == 'User' ? null : event.message.id
                    );

                    if (sentMessages) {
                        const memories: Memory[] = [];

                        // Create memories for each sent message
                        for (let i = 0; i < sentMessages.length; i++) {
                            const sentMessage = sentMessages[i];
                            const isLastMessage = i === sentMessages.length - 1;

                            const memory: Memory = {
                                id: stringToUuid(`tg-message-${roomUUID}-${sentMessage.id.toString()}` + "-" + this.runtime.agentId) as UUID,
                                agentId: agentUUID,
                                userId: agentUUID,
                                roomId: roomUUID,
                                content: {
                                    ...content,
                                    text: sentMessage.message,
                                    inReplyTo: messageUUID,
                                },
                                createdAt: sentMessage.date * 1000,
                                embedding: getEmbeddingZeroVector(),
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
                    // Mark chat as read
                    await this.client.markAsRead(chat);

                    // Show that a bot is typing a message
                    await this.client.invoke(
                        new Api.messages.SetTyping({
                            peer: chat,
                            action: new Api.SendMessageTypingAction()
                        })
                    );

                    // Generate response
                    const template = this.runtime.character?.templates
                        ?.messageHandlerTemplate ||
                        getTelegramAccountMessageHandlerTemplate(this.account);

                    const context = composeContext({
                        state,
                        template: template,
                    });

                    const responseContent = await this._generateResponse(
                        memory,
                        state,
                        context
                    );

                    if (!responseContent || !responseContent.text) return;

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

                await this.runtime.evaluate(memory, state, shouldRespond, callback);
            } catch (error) {
                elizaLogger.error("❌ Error handling message:", error);
                elizaLogger.error("Error sending message:", error);
            }
        }, new NewMessage({ incoming: true }));
    }

    // Decide if the bot should respond to the message
    private async _shouldRespond(
        message: Api.Message,
        chat: Entity,
        replyMessage?: Api.Message
    ): Promise<boolean> {
        if (replyMessage) {
            const replyFrom = replyMessage.fromId as Api.PeerUser;
            if (replyFrom && replyFrom.userId.eq(this.account.id)) return true;
        }

        if (chat.className == 'User') {
            return true;
        }
        else {
            return message.message.includes(`@${this.account.username}`)
        }
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
            modelClass: ModelClass.LARGE,
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

    // Send long messages in chunks
    private async sendMessageInChunks(
        chatId: bigInt.BigInteger,
        content: Content,
        replyToMessageId?: number
    ) {
        if (content.attachments && content.attachments.length > 0) {
            content.attachments.map(async (attachment: Media) => {
                await this.client.sendFile(
                    chatId,
                    {
                        file: attachment.url,
                        forceDocument: true,
                        caption: attachment.description,
                        replyTo: replyToMessageId
                    }
                );

            });
        } else {
            const chunks = splitMessage(content.text);
            const sentMessages = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunk = escapeMarkdown(chunks[i]);

                const sentMessage = await this.client.sendMessage(
                    chatId,
                    {
                        message: chunk,
                        parseMode: 'markdown',
                        replyTo: replyToMessageId
                    }
                );

                sentMessages.push(sentMessage);
            }

            return sentMessages;
        }
    }
}
