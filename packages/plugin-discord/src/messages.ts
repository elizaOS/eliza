import {
    composeContext, type Content, generateMessageResponse, generateShouldRespond, type HandlerCallback,
    type IAgentRuntime,
    type IBrowserService, type IVideoService, logger, type Media,
    type Memory, ModelClass, ServiceType,
    type State, stringToUuid, type UUID
} from "@elizaos/core";
import {
    ChannelType,
    type Client,
    type Message as DiscordMessage,
    type TextChannel,
} from "discord.js";
import { AttachmentManager } from "./attachments.ts";
import {
    IGNORE_RESPONSE_WORDS,
    LOSE_INTEREST_WORDS,
    MESSAGE_CONSTANTS,
    MESSAGE_LENGTH_THRESHOLDS
} from "./constants.ts";
import {
    discordAnnouncementHypeTemplate,
    discordAutoPostTemplate,
    discordMessageHandlerTemplate,
    discordShouldRespondTemplate
} from "./templates.ts";
import {
    canSendMessage,
    sendMessageInChunks,
} from "./utils.ts";
import type { VoiceManager } from "./voice.ts";

interface MessageContext {
    content: string;
    timestamp: number;
}

export type InterestChannels = {
    [key: string]: {
        currentHandler: string | undefined;
        lastMessageSent: number;
        messages: { userId: UUID; userName: string; content: Content }[];
        previousContext?: MessageContext;
        contextSimilarityThreshold?: number;
    };
};

export class MessageManager {
    private client: Client;
    private runtime: IAgentRuntime;
    private attachmentManager: AttachmentManager;
    private interestChannels: InterestChannels = {};
    private discordClient: any;
    private voiceManager: VoiceManager;
    //Auto post
    private lastChannelActivity: { [channelId: string]: number } = {};
    private autoPostInterval: NodeJS.Timeout;

    constructor(discordClient: any, voiceManager: VoiceManager) {
        this.client = discordClient.client;
        this.voiceManager = voiceManager;
        this.discordClient = discordClient;
        this.runtime = discordClient.runtime;
        this.attachmentManager = new AttachmentManager(this.runtime);
    }

    async handleMessage(message: DiscordMessage) {
        if (this.runtime.character.clientConfig?.discord?.allowedChannelIds &&
            !this.runtime.character.clientConfig.discord.allowedChannelIds.includes(message.channelId)) {
            return;
        }

        // Update last activity time for the channel
        this.lastChannelActivity[message.channelId] = Date.now();

        if (
            message.interaction ||
            message.author.id ===
                this.client.user?.id /* || message.author?.bot*/
        ) {
            return;
        }

        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldIgnoreBotMessages &&
            message.author?.bot
        ) {
            return;
        }

        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldIgnoreDirectMessages &&
            message.channel.type === ChannelType.DM
        ) {
            return;
        }

        const userId = message.author.id as UUID;
        const userName = message.author.username;
        const name = message.author.displayName;
        const channelId = message.channel.id;
        const hasInterest = this._checkInterest(message.channelId);

        try {
            const { processedContent, attachments } =
                await this.processMessageMedia(message);

            const audioAttachments = message.attachments.filter((attachment) =>
                attachment.contentType?.startsWith("audio/")
            );
            if (audioAttachments.size > 0) {
                const processedAudioAttachments =
                    await this.attachmentManager.processAttachments(
                        audioAttachments
                    );
                attachments.push(...processedAudioAttachments);
            }

            const roomId = stringToUuid(channelId + "-" + this.runtime.agentId);
            const userIdUUID = stringToUuid(userId);

            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                userName,
                name,
                "discord"
            );

            const messageId = stringToUuid(
                message.id + "-" + this.runtime.agentId
            );

            let shouldIgnore = false;
            let shouldRespond = true;

            const content: Content = {
                text: processedContent,
                attachments: attachments,
                source: "discord",
                url: message.url,
                inReplyTo: message.reference?.messageId
                    ? stringToUuid(
                          message.reference.messageId +
                              "-" +
                              this.runtime.agentId
                      )
                    : undefined,
            };

            const userMessage = {
                content,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
            };

            const memory: Memory = {
                id: stringToUuid(message.id + "-" + this.runtime.agentId),
                ...userMessage,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
                content,
                createdAt: message.createdTimestamp,
            };

            if (content.text) {
                await this.runtime.messageManager.addEmbeddingToMemory(memory);
                await this.runtime.messageManager.createMemory(memory);

                if (this.interestChannels[message.channelId]) {
                    // Add new message
                    this.interestChannels[message.channelId].messages.push({
                        userId: userIdUUID,
                        userName: userName,
                        content: content,
                    });

                    // Trim to keep only recent messages
                    if (
                        this.interestChannels[message.channelId].messages
                            .length > MESSAGE_CONSTANTS.MAX_MESSAGES
                    ) {
                        this.interestChannels[message.channelId].messages =
                            this.interestChannels[
                                message.channelId
                            ].messages.slice(-MESSAGE_CONSTANTS.MAX_MESSAGES);
                    }
                }
            }

            let state = await this.runtime.composeState(userMessage, {
                discordClient: this.client,
                discordMessage: message,
                agentName:
                    this.runtime.character.name ||
                    this.client.user?.displayName,
            });

            const canSendResult = canSendMessage(message.channel);
            if (!canSendResult.canSend) {
                return logger.warn(
                    `Cannot send message to channel ${message.channel}`,
                    canSendResult
                );
            }

            if (!shouldIgnore) {
                shouldIgnore = await this._shouldIgnore(message);
            }

            if (shouldIgnore) {
                return;
            }

            const agentUserState =
                await this.runtime.databaseAdapter.getParticipantUserState(
                    roomId,
                    this.runtime.agentId
                );

            if (
                agentUserState === "MUTED" &&
                !message.mentions.has(this.client.user.id) &&
                !hasInterest
            ) {
                console.log("Ignoring muted room");
                // Ignore muted rooms unless explicitly mentioned
                return;
            }

            if (agentUserState === "FOLLOWED") {
                shouldRespond = true; // Always respond in followed rooms
            } else if (
                (!shouldRespond && hasInterest) ||
                (shouldRespond && !hasInterest)
            ) {
                shouldRespond = await this._shouldRespond(message, state);
            }

            if (shouldRespond) {
                const context = composeContext({
                    state,
                    template:
                        this.runtime.character.templates
                            ?.discordMessageHandlerTemplate ||
                        discordMessageHandlerTemplate,
                });

                // simulate discord typing while generating a response
                const stopTyping = this.simulateTyping(message);

                const responseContent = await generateMessageResponse({
                    runtime: this.runtime,
                    context,
                    modelClass: ModelClass.TEXT_LARGE,
                });

                await this.runtime.databaseAdapter.log({
                    body: { message, context, response: responseContent },
                    userId: userId,
                    roomId,
                    type: "response",
                });

                responseContent.text = responseContent.text?.trim();
                responseContent.inReplyTo = stringToUuid(
                    message.id + "-" + this.runtime.agentId
                );

                const callback: HandlerCallback = async (
                    content: Content,
                    files: any[]
                ) => {
                    try {
                        if (message.id && !content.inReplyTo) {
                            content.inReplyTo = stringToUuid(
                                message.id + "-" + this.runtime.agentId
                            );
                        }
                        const messages = await sendMessageInChunks(
                            message.channel as TextChannel,
                            content.text,
                            message.id,
                            files
                        );

                        const memories: Memory[] = [];
                        for (const m of messages) {
                            let action = content.action;
                            // If there's only one message or it's the last message, keep the original action
                            // For multiple messages, set all but the last to 'CONTINUE'
                            if (
                                messages.length > 1 &&
                                m !== messages[messages.length - 1]
                            ) {
                                action = "CONTINUE";
                            }

                            const memory: Memory = {
                                id: stringToUuid(
                                    m.id + "-" + this.runtime.agentId
                                ),
                                userId: this.runtime.agentId,
                                agentId: this.runtime.agentId,
                                content: {
                                    ...content,
                                    action,
                                    inReplyTo: messageId,
                                    url: m.url,
                                },
                                roomId,
                                createdAt: m.createdTimestamp,
                            };
                            memories.push(memory);
                        }
                        for (const m of memories) {
                            await this.runtime.messageManager.createMemory(m);
                        }
                        return memories;
                    } catch (error) {
                        console.error("Error sending message:", error);
                        return [];
                    }
                };

                const responseMessages: Memory[] = [
                    {
                        id: stringToUuid(messageId + "-" + this.runtime.agentId),
                        userId: this.runtime.agentId,
                        agentId: this.runtime.agentId,
                        content: responseContent,
                        roomId,
                        createdAt: Date.now(),
                    }
                ];

                state = await this.runtime.updateRecentMessageState(state);

                await this.runtime.processActions(
                    memory,
                    responseMessages,
                    state,
                    callback
                );

                stopTyping();
            }
            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            console.error("Error handling message:", error);
            if (message.channel.type === ChannelType.GuildVoice) {
                // For voice channels, use text-to-speech for the error message
                const errorMessage = "Sorry, I had a glitch. What was that?";

                const audioStream = await this.runtime.useModel(ModelClass.TEXT_TO_SPEECH, errorMessage)

                await this.voiceManager.playAudioStream(userId, audioStream);
            } else {
                // For text channels, send the error message
                console.error("Error sending message:", error);
            }
        }
    }

    async cacheMessages(channel: TextChannel, count = 20) {
        const messages = await channel.messages.fetch({ limit: count });

        // TODO: This is throwing an error but seems to work?
        for (const [_, message] of messages) {
            await this.handleMessage(message);
        }
    }

    async processMessageMedia(
        message: DiscordMessage
    ): Promise<{ processedContent: string; attachments: Media[] }> {
        let processedContent = message.content;

        let attachments: Media[] = [];

        // Process code blocks in the message content
        const codeBlockRegex = /```([\s\S]*?)```/g;
        let match;
        while ((match = codeBlockRegex.exec(processedContent))) {
            const codeBlock = match[1];
            const lines = codeBlock.split("\n");
            const title = lines[0];
            const description = lines.slice(0, 3).join("\n");
            const attachmentId =
                `code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(
                    -5
                );
            attachments.push({
                id: attachmentId,
                url: "",
                title: title || "Code Block",
                source: "Code",
                description: description,
                text: codeBlock,
            });
            processedContent = processedContent.replace(
                match[0],
                `Code Block (${attachmentId})`
            );
        }

        // Process message attachments
        if (message.attachments.size > 0) {
            attachments = await this.attachmentManager.processAttachments(
                message.attachments
            );
        }

        // TODO: Move to attachments manager
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = processedContent.match(urlRegex) || [];

        for (const url of urls) {
            if (
                this.runtime
                    .getService<IVideoService>(ServiceType.VIDEO)
                    ?.isVideoUrl(url)
            ) {
                const videoService = this.runtime.getService<IVideoService>(
                    ServiceType.VIDEO
                );
                if (!videoService) {
                    throw new Error("Video service not found");
                }
                const videoInfo = await videoService.processVideo(
                    url,
                    this.runtime
                );

                attachments.push({
                    id: `youtube-${Date.now()}`,
                    url: url,
                    title: videoInfo.title,
                    source: "YouTube",
                    description: videoInfo.description,
                    text: videoInfo.text,
                });
            } else {
                const browserService = this.runtime.getService<IBrowserService>(
                    ServiceType.BROWSER
                );
                if (!browserService) {
                    throw new Error("Browser service not found");
                }

                const { title, description: summary } =
                    await browserService.getPageContent(url, this.runtime);

                attachments.push({
                    id: `webpage-${Date.now()}`,
                    url: url,
                    title: title || "Web Page",
                    source: "Web",
                    description: summary,
                    text: summary,
                });
            }
        }

        return { processedContent, attachments };
    }

    private _checkInterest(channelId: string): boolean {
        const channelState = this.interestChannels[channelId];
        if (!channelState) return false;

        // Check if conversation has shifted to a new topic
        if (channelState.messages.length > 0) {
            const recentMessages = channelState.messages.slice(
                -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
            );
            const differentUsers = new Set(recentMessages.map((m) => m.userId))
                .size;

            // If multiple users are talking and we're not involved, reduce interest
            if (
                differentUsers > 1 &&
                !recentMessages.some((m) => m.userId === this.client.user?.id)
            ) {
                delete this.interestChannels[channelId];
                return false;
            }
        }

        return true;
    }

    private async _shouldIgnore(message: DiscordMessage): Promise<boolean> {
        // if the message is from us, ignore
        if (message.author.id === this.client.user?.id) return true;

        let messageContent = message.content.toLowerCase();

        // Replace the bot's @ping with the character name
        const botMention = `<@!?${this.client.user?.id}>`;
        messageContent = messageContent.replace(
            new RegExp(botMention, "gi"),
            this.runtime.character.name.toLowerCase()
        );

        // Replace the bot's username with the character name
        const botUsername = this.client.user?.username.toLowerCase();
        messageContent = messageContent.replace(
            new RegExp(`\\b${botUsername}\\b`, "g"),
            this.runtime.character.name.toLowerCase()
        );

        // strip all special characters
        messageContent = messageContent.replace(/[^a-zA-Z0-9\s]/g, "");

        // short responses where eliza should stop talking and disengage unless mentioned again
        if (
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.LOSE_INTEREST &&
            LOSE_INTEREST_WORDS.some((word) => messageContent.includes(word))
        ) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // If we're not interested in the channel and it's a short message, ignore it
        if (
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.SHORT_MESSAGE &&
            !this.interestChannels[message.channelId]
        ) {
            return true;
        }

        const targetedPhrases = [
            this.runtime.character.name + " stop responding",
            this.runtime.character.name + " stop talking",
            this.runtime.character.name + " shut up",
            this.runtime.character.name + " stfu",
            "stop talking" + this.runtime.character.name,
            this.runtime.character.name + " stop talking",
            "shut up " + this.runtime.character.name,
            this.runtime.character.name + " shut up",
            "stfu " + this.runtime.character.name,
            this.runtime.character.name + " stfu",
            "chill" + this.runtime.character.name,
            this.runtime.character.name + " chill",
        ];

        // lose interest if pinged and told to stop responding
        if (targetedPhrases.some((phrase) => messageContent.includes(phrase))) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // if the message is short, ignore but maintain interest
        if (
            !this.interestChannels[message.channelId] &&
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.VERY_SHORT_MESSAGE
        ) {
            return true;
        }

        if (
            message.content.length <
                MESSAGE_LENGTH_THRESHOLDS.IGNORE_RESPONSE &&
            IGNORE_RESPONSE_WORDS.some((word) =>
                message.content.toLowerCase().includes(word)
            )
        ) {
            return true;
        }
        return false;
    }

    private async _shouldRespond(
        message: DiscordMessage,
        state: State
    ): Promise<boolean> {
        if (message.author.id === this.client.user?.id) return false;
        // if (message.author.bot) return false;

        const channelState = this.interestChannels[message.channelId];

        if (message.mentions.has(this.client.user?.id as string)) return true;

        const guild = message.guild;
        const member = guild?.members.cache.get(this.client.user?.id as string);
        const nickname = member?.nickname;

        if (
            message.content
                .toLowerCase()
                .includes(this.client.user?.username.toLowerCase() as string) ||
            message.content
                .toLowerCase()
                .includes(this.client.user?.tag.toLowerCase() as string) ||
            (nickname &&
                message.content.toLowerCase().includes(nickname.toLowerCase()))
        ) {
            return true;
        }

        // If none of the above conditions are met, use the generateText to decide
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.discordShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                discordShouldRespondTemplate,
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.TEXT_SMALL,
        });

        if (response === "RESPOND") {
            if (channelState) {
                channelState.previousContext = {
                    content: message.content,
                    timestamp: Date.now(),
                };
            }

            return true;
        } else if (response === "IGNORE") {
            return false;
        } else if (response === "STOP") {
            delete this.interestChannels[message.channelId];
            return false;
        } else {
            console.error(
                "Invalid response from response generateText:",
                response
            );
            return false;
        }
    }

    async fetchBotName(botToken: string) {
        const url = "https://discord.com/api/v10/users/@me";

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bot ${botToken}`,
            },
        });

        if (!response.ok) {
            throw new Error(
                `Error fetching bot details: ${response.statusText}`
            );
        }

        const data = await response.json();
        return (data as { username: string }).username;
    }

    /**
     * Simulate discord typing while generating a response;
     * returns a function to interrupt the typing loop
     *
     * @param message
     */
    private simulateTyping(message: DiscordMessage) {
        let typing = true;

        const typingLoop = async () => {
            while (typing) {
                // @ts-ignore
                await message.channel.sendTyping();
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        };

        typingLoop();

        return function stopTyping() {
            typing = false;
        };
    }
}
