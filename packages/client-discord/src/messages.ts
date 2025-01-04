import { composeContext, composeRandomUser } from "@elizaos/core";
import { generateMessageResponse, generateShouldRespond } from "@elizaos/core";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IBrowserService,
    ISpeechService,
    IVideoService,
    Media,
    Memory,
    ModelClass,
    ServiceType,
    State,
    UUID,
} from "@elizaos/core";
import { stringToUuid, getEmbeddingZeroVector } from "@elizaos/core";
import {
    ChannelType,
    Client,
    Message as DiscordMessage,
    TextChannel,
} from "discord.js";
import { elizaLogger } from "@elizaos/core";
import { AttachmentManager } from "./attachments.ts";
import { VoiceManager } from "./voice.ts";
import {
    discordShouldRespondTemplate,
    discordMessageHandlerTemplate,
} from "./templates.ts";
import {
    IGNORE_RESPONSE_WORDS,
    LOSE_INTEREST_WORDS,
    MESSAGE_CONSTANTS,
    MESSAGE_LENGTH_THRESHOLDS,
    RESPONSE_CHANCES,
    TEAM_COORDINATION,
    TIMING_CONSTANTS,
} from "./constants";
import {
    sendMessageInChunks,
    canSendMessage,
    cosineSimilarity,
} from "./utils.ts";

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

    constructor(discordClient: any, voiceManager: VoiceManager) {
        this.client = discordClient.client;
        this.voiceManager = voiceManager;
        this.discordClient = discordClient;
        this.runtime = discordClient.runtime;
        this.attachmentManager = new AttachmentManager(this.runtime);
    }

    async handleMessage(message: DiscordMessage) {
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

        // Check for mentions-only mode setting
        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            if (!this._isMessageForMe(message)) {
                return;
            }
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
        const isDirectlyMentioned = this._isMessageForMe(message);
        const hasInterest = this._checkInterest(message.channelId);

        // Team handling
        if (
            this.runtime.character.clientConfig?.discord?.isPartOfTeam &&
            !this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            const authorId = this._getNormalizedUserId(message.author.id);

            if (
                !this._isTeamLeader() &&
                this._isRelevantToTeamMember(message.content, channelId)
            ) {
                this.interestChannels[message.channelId] = {
                    currentHandler: this.client.user?.id,
                    lastMessageSent: Date.now(),
                    messages: [],
                };
            }

            const isTeamRequest = this._isTeamCoordinationRequest(
                message.content
            );
            const isLeader = this._isTeamLeader();

            // After team-wide responses, check if we should maintain interest
            if (hasInterest && !isDirectlyMentioned) {
                const lastSelfMemories =
                    await this.runtime.messageManager.getMemories({
                        roomId: stringToUuid(
                            channelId + "-" + this.runtime.agentId
                        ),
                        unique: false,
                        count: 5,
                    });

                const lastSelfSortedMemories = lastSelfMemories
                    ?.filter((m) => m.userId === this.runtime.agentId)
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                const isRelevant = this._isRelevantToTeamMember(
                    message.content,
                    channelId,
                    lastSelfSortedMemories?.[0]
                );

                if (!isRelevant) {
                    // Clearing interest - conversation not relevant to team member
                    delete this.interestChannels[message.channelId];
                    return;
                }
            }

            if (isTeamRequest) {
                if (isLeader) {
                    this.interestChannels[message.channelId] = {
                        currentHandler: this.client.user?.id,
                        lastMessageSent: Date.now(),
                        messages: [],
                    };
                } else {
                    // Set temporary interest for this response
                    this.interestChannels[message.channelId] = {
                        currentHandler: this.client.user?.id,
                        lastMessageSent: Date.now(),
                        messages: [],
                    };

                    // Clear interest after this cycle unless directly mentioned
                    if (!isDirectlyMentioned) {
                        // Use existing message cycle to clear interest
                        this.interestChannels[
                            message.channelId
                        ].lastMessageSent = 0;
                    }
                }
            }

            // Check for other team member mentions
            const otherTeamMembers =
                this.runtime.character.clientConfig.discord.teamAgentIds.filter(
                    (id) => id !== this.client.user?.id
                );
            const mentionedTeamMember = otherTeamMembers.find((id) =>
                message.content.includes(`<@${id}>`)
            );

            // If another team member is mentioned, clear our interest
            if (mentionedTeamMember) {
                if (
                    hasInterest ||
                    this.interestChannels[message.channelId]?.currentHandler ===
                        this.client.user?.id
                ) {
                    delete this.interestChannels[message.channelId];

                    // Only return if we're not the mentioned member
                    if (!isDirectlyMentioned) {
                        return;
                    }
                }
            }

            // Set/maintain interest only if we're mentioned or already have interest
            if (isDirectlyMentioned) {
                this.interestChannels[message.channelId] = {
                    currentHandler: this.client.user?.id,
                    lastMessageSent: Date.now(),
                    messages: [],
                };
            } else if (!isTeamRequest && !hasInterest) {
                return;
            }

            // Bot-specific checks
            if (message.author.bot) {
                if (this._isTeamMember(authorId) && !isDirectlyMentioned) {
                    return;
                } else if (
                    this.runtime.character.clientConfig.discord
                        .shouldIgnoreBotMessages
                ) {
                    return;
                }
            }
        }

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
                return elizaLogger.warn(
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
                const stopTyping = this.simulateTyping(message)

                const responseContent = await this._generateResponse(
                    memory,
                    state,
                    context
                ).finally(() => {
                    stopTyping()
                });

                responseContent.text = responseContent.text?.trim();
                responseContent.inReplyTo = stringToUuid(
                    message.id + "-" + this.runtime.agentId
                );

                if (!responseContent.text) {
                    return;
                }

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
                                embedding: getEmbeddingZeroVector(),
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

                const responseMessages = await callback(responseContent);

                state = await this.runtime.updateRecentMessageState(state);

                await this.runtime.processActions(
                    memory,
                    responseMessages,
                    state,
                    callback
                );
            }
            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            console.error("Error handling message:", error);
            if (message.channel.type === ChannelType.GuildVoice) {
                // For voice channels, use text-to-speech for the error message
                const errorMessage = "Sorry, I had a glitch. What was that?";

                const speechService = this.runtime.getService<ISpeechService>(
                    ServiceType.SPEECH_GENERATION
                );
                if (!speechService) {
                    throw new Error("Speech generation service not found");
                }

                const audioStream = await speechService.generate(
                    this.runtime,
                    errorMessage
                );
                await this.voiceManager.playAudioStream(userId, audioStream);
            } else {
                // For text channels, send the error message
                console.error("Error sending message:", error);
            }
        }
    }

    async cacheMessages(channel: TextChannel, count: number = 20) {
        const messages = await channel.messages.fetch({ limit: count });

        // TODO: This is throwing an error but seems to work?
        for (const [_, message] of messages) {
            await this.handleMessage(message);
        }
    }

    private _isMessageForMe(message: DiscordMessage): boolean {
        const isMentioned = message.mentions.users?.has(
            this.client.user?.id as string
        );
        const guild = message.guild;
        const member = guild?.members.cache.get(this.client.user?.id as string);
        const nickname = member?.nickname;

        // Don't consider role mentions as direct mentions
        const hasRoleMentionOnly =
            message.mentions.roles.size > 0 && !isMentioned;

        // If it's only a role mention and we're in team mode, let team logic handle it
        if (
            hasRoleMentionOnly &&
            this.runtime.character.clientConfig?.discord?.isPartOfTeam
        ) {
            return false;
        }

        return (
            isMentioned ||
            (!this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions &&
                (message.content
                    .toLowerCase()
                    .includes(
                        this.client.user?.username.toLowerCase() as string
                    ) ||
                    message.content
                        .toLowerCase()
                        .includes(
                            this.client.user?.tag.toLowerCase() as string
                        ) ||
                    (nickname &&
                        message.content
                            .toLowerCase()
                            .includes(nickname.toLowerCase()))))
        );
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

    private _getNormalizedUserId(id: string): string {
        return id.toString().replace(/[^0-9]/g, "");
    }

    private _isTeamMember(userId: string): boolean {
        const teamConfig = this.runtime.character.clientConfig?.discord;
        if (!teamConfig?.isPartOfTeam || !teamConfig.teamAgentIds) return false;

        const normalizedUserId = this._getNormalizedUserId(userId);

        const isTeamMember = teamConfig.teamAgentIds.some(
            (teamId) => this._getNormalizedUserId(teamId) === normalizedUserId
        );

        return isTeamMember;
    }

    private _isTeamLeader(): boolean {
        return (
            this.client.user?.id ===
            this.runtime.character.clientConfig?.discord?.teamLeaderId
        );
    }

    private _isTeamCoordinationRequest(content: string): boolean {
        const contentLower = content.toLowerCase();
        return TEAM_COORDINATION.KEYWORDS?.some((keyword) =>
            contentLower.includes(keyword.toLowerCase())
        );
    }

    private _isRelevantToTeamMember(
        content: string,
        channelId: string,
        lastAgentMemory: Memory | null = null
    ): boolean {
        const teamConfig = this.runtime.character.clientConfig?.discord;

        if (this._isTeamLeader() && lastAgentMemory?.content.text) {
            const timeSinceLastMessage = Date.now() - lastAgentMemory.createdAt;
            if (timeSinceLastMessage > MESSAGE_CONSTANTS.INTEREST_DECAY_TIME) {
                return false; // Memory too old, not relevant
            }

            const similarity = cosineSimilarity(
                content.toLowerCase(),
                lastAgentMemory.content.text.toLowerCase()
            );

            return (
                similarity >=
                MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD_FOLLOW_UPS
            );
        }

        // If no keywords defined, only leader maintains conversation
        if (!teamConfig?.teamMemberInterestKeywords) {
            return false;
        }

        return teamConfig.teamMemberInterestKeywords.some((keyword) =>
            content.toLowerCase().includes(keyword.toLowerCase())
        );
    }

    private async _analyzeContextSimilarity(
        currentMessage: string,
        previousContext?: MessageContext,
        agentLastMessage?: string
    ): Promise<number> {
        if (!previousContext) return 1; // No previous context to compare against

        // If more than 5 minutes have passed, reduce similarity weight
        const timeDiff = Date.now() - previousContext.timestamp;
        const timeWeight = Math.max(0, 1 - timeDiff / (5 * 60 * 1000)); // 5 minutes threshold

        // Calculate content similarity
        const similarity = cosineSimilarity(
            currentMessage.toLowerCase(),
            previousContext.content.toLowerCase(),
            agentLastMessage?.toLowerCase()
        );

        // Weight the similarity by time factor
        const weightedSimilarity = similarity * timeWeight;

        return weightedSimilarity;
    }

    private async _shouldRespondBasedOnContext(
        message: DiscordMessage,
        channelState: InterestChannels[string]
    ): Promise<boolean> {
        // Always respond if directly mentioned
        if (this._isMessageForMe(message)) return true;

        // If we're not the current handler, don't respond
        if (channelState?.currentHandler !== this.client.user?.id) return false;

        // Check if we have messages to compare
        if (!channelState.messages?.length) return false;

        // Get last user message (not from the bot)
        const lastUserMessage = [...channelState.messages].reverse().find(
            (m, index) =>
                index > 0 && // Skip first message (current)
                m.userId !== this.runtime.agentId
        );

        if (!lastUserMessage) return false;

        const lastSelfMemories = await this.runtime.messageManager.getMemories({
            roomId: stringToUuid(
                message.channel.id + "-" + this.runtime.agentId
            ),
            unique: false,
            count: 5,
        });

        const lastSelfSortedMemories = lastSelfMemories
            ?.filter((m) => m.userId === this.runtime.agentId)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        // Calculate context similarity
        const contextSimilarity = await this._analyzeContextSimilarity(
            message.content,
            {
                content: lastUserMessage.content.text || "",
                timestamp: Date.now(),
            },
            lastSelfSortedMemories?.[0]?.content?.text
        );

        const similarityThreshold =
            this.runtime.character.clientConfig?.discord
                ?.messageSimilarityThreshold ||
            channelState.contextSimilarityThreshold ||
            MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD;

        return contextSimilarity >= similarityThreshold;
    }

    private _checkInterest(channelId: string): boolean {
        const channelState = this.interestChannels[channelId];
        if (!channelState) return false;

        const lastMessage =
            channelState.messages[channelState.messages.length - 1];
        // If it's been more than 5 minutes since last message, reduce interest
        const timeSinceLastMessage = Date.now() - channelState.lastMessageSent;

        if (timeSinceLastMessage > MESSAGE_CONSTANTS.INTEREST_DECAY_TIME) {
            delete this.interestChannels[channelId];
            return false;
        } else if (
            timeSinceLastMessage > MESSAGE_CONSTANTS.PARTIAL_INTEREST_DECAY
        ) {
            // Require stronger relevance for continued interest
            return this._isRelevantToTeamMember(
                lastMessage.content.text || "",
                channelId
            );
        }

        // If team leader and messages exist, check for topic changes and team member responses
        if (this._isTeamLeader() && channelState.messages.length > 0) {
            // If leader's keywords don't match and another team member has responded, drop interest
            if (
                !this._isRelevantToTeamMember(
                    lastMessage.content.text || "",
                    channelId
                )
            ) {
                const recentTeamResponses = channelState.messages
                    .slice(-3)
                    .some(
                        (m) =>
                            m.userId !== this.client.user?.id &&
                            this._isTeamMember(m.userId)
                    );

                if (recentTeamResponses) {
                    delete this.interestChannels[channelId];
                    return false;
                }
            }
        }

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

        // Honor mentions-only mode
        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            return !this._isMessageForMe(message);
        }

        // Team-based ignore logic
        if (this.runtime.character.clientConfig?.discord?.isPartOfTeam) {
            const authorId = this._getNormalizedUserId(message.author.id);

            if (this._isTeamLeader()) {
                if (this._isTeamCoordinationRequest(message.content)) {
                    return false;
                }
                // Ignore if message is only about team member interests and not directed to leader
                if (!this._isMessageForMe(message)) {
                    const otherMemberInterests =
                        this.runtime.character.clientConfig?.discord
                            ?.teamMemberInterestKeywords || [];
                    const hasOtherInterests = otherMemberInterests.some(
                        (keyword) =>
                            message.content
                                .toLowerCase()
                                .includes(keyword.toLowerCase())
                    );
                    if (hasOtherInterests) {
                        return true;
                    }
                }
            } else if (this._isTeamCoordinationRequest(message.content)) {
                const randomDelay =
                    Math.floor(
                        Math.random() *
                            (TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MAX -
                                TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MIN)
                    ) + TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MIN; // 1-3 second random delay
                await new Promise((resolve) =>
                    setTimeout(resolve, randomDelay)
                );
                return false;
            }

            if (this._isTeamMember(authorId)) {
                if (!this._isMessageForMe(message)) {
                    // If message contains our interests, don't ignore
                    if (
                        this._isRelevantToTeamMember(
                            message.content,
                            message.channelId
                        )
                    ) {
                        return false;
                    }
                    return true;
                }
            }

            // Check if we're in an active conversation based on context
            const channelState = this.interestChannels[message.channelId];

            if (channelState?.currentHandler) {
                // If we're the current handler, check context
                if (channelState.currentHandler === this.client.user?.id) {
                    //If it's our keywords, bypass context check
                    if (
                        this._isRelevantToTeamMember(
                            message.content,
                            message.channelId
                        )
                    ) {
                        return false;
                    }

                    const shouldRespondContext =
                        await this._shouldRespondBasedOnContext(
                            message,
                            channelState
                        );

                    // If context is different, ignore. If similar, don't ignore
                    return !shouldRespondContext;
                }

                // If another team member is handling and we're not mentioned or coordinating
                else if (
                    !this._isMessageForMe(message) &&
                    !this._isTeamCoordinationRequest(message.content)
                ) {
                    return true;
                }
            }
        }

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

        // Honor mentions-only mode
        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            return this._isMessageForMe(message);
        }

        const channelState = this.interestChannels[message.channelId];

        // Check if team member has direct interest first
        if (
            this.runtime.character.clientConfig?.discord?.isPartOfTeam &&
            !this._isTeamLeader() &&
            this._isRelevantToTeamMember(message.content, message.channelId)
        ) {
            return true;
        }

        try {
            // Team-based response logic
            if (this.runtime.character.clientConfig?.discord?.isPartOfTeam) {
                // Team leader coordination
                if (
                    this._isTeamLeader() &&
                    this._isTeamCoordinationRequest(message.content)
                ) {
                    return true;
                }

                if (
                    !this._isTeamLeader() &&
                    this._isRelevantToTeamMember(
                        message.content,
                        message.channelId
                    )
                ) {
                    // Add small delay for non-leader responses
                    await new Promise((resolve) =>
                        setTimeout(resolve, TIMING_CONSTANTS.TEAM_MEMBER_DELAY)
                    ); //1.5 second delay

                    // If leader has responded in last few seconds, reduce chance of responding

                    if (channelState?.messages?.length) {
                        const recentMessages = channelState.messages.slice(
                            -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
                        );
                        const leaderResponded = recentMessages.some(
                            (m) =>
                                m.userId ===
                                    this.runtime.character.clientConfig?.discord
                                        ?.teamLeaderId &&
                                Date.now() - channelState.lastMessageSent < 3000
                        );

                        if (leaderResponded) {
                            // 50% chance to respond if leader just did
                            return (
                                Math.random() > RESPONSE_CHANCES.AFTER_LEADER
                            );
                        }
                    }

                    return true;
                }

                // If I'm the leader but message doesn't match my keywords, add delay and check for team responses
                if (
                    this._isTeamLeader() &&
                    !this._isRelevantToTeamMember(
                        message.content,
                        message.channelId
                    )
                ) {
                    const randomDelay =
                        Math.floor(
                            Math.random() *
                                (TIMING_CONSTANTS.LEADER_DELAY_MAX -
                                    TIMING_CONSTANTS.LEADER_DELAY_MIN)
                        ) + TIMING_CONSTANTS.LEADER_DELAY_MIN; // 2-4 second random delay
                    await new Promise((resolve) =>
                        setTimeout(resolve, randomDelay)
                    );

                    // After delay, check if another team member has already responded
                    if (channelState?.messages?.length) {
                        const recentResponses = channelState.messages.slice(
                            -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
                        );
                        const otherTeamMemberResponded = recentResponses.some(
                            (m) =>
                                m.userId !== this.client.user?.id &&
                                this._isTeamMember(m.userId)
                        );

                        if (otherTeamMemberResponded) {
                            return false;
                        }
                    }
                }

                // Update current handler if we're mentioned
                if (this._isMessageForMe(message)) {
                    const channelState =
                        this.interestChannels[message.channelId];
                    if (channelState) {
                        channelState.currentHandler = this.client.user?.id;
                        channelState.lastMessageSent = Date.now();
                    }
                    return true;
                }

                // Don't respond if another teammate is handling the conversation
                if (channelState?.currentHandler) {
                    if (
                        channelState.currentHandler !== this.client.user?.id &&
                        this._isTeamMember(channelState.currentHandler)
                    ) {
                        return false;
                    }
                }

                // Natural conversation cadence
                if (!this._isMessageForMe(message) && channelState) {
                    // Count our recent messages
                    const recentMessages = channelState.messages.slice(
                        -MESSAGE_CONSTANTS.CHAT_HISTORY_COUNT
                    );
                    const ourMessageCount = recentMessages.filter(
                        (m) => m.userId === this.client.user?.id
                    ).length;

                    // Reduce responses if we've been talking a lot
                    if (ourMessageCount > 2) {
                        // Exponentially decrease chance to respond
                        const responseChance = Math.pow(
                            0.5,
                            ourMessageCount - 2
                        );
                        if (Math.random() > responseChance) {
                            return false;
                        }
                    }
                }
            }
        } catch (error) {
            elizaLogger.error("Error in _shouldRespond team processing:", {
                error,
                agentId: this.runtime.agentId,
                channelId: message.channelId,
            });
        }

        // Otherwise do context check
        if (channelState?.previousContext) {
            const shouldRespondContext =
                await this._shouldRespondBasedOnContext(message, channelState);
            if (!shouldRespondContext) {
                delete this.interestChannels[message.channelId];
                return false;
            }
        }

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

        if (!message.guild) {
            return true;
        }

        // If none of the above conditions are met, use the generateText to decide
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.discordShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                composeRandomUser(discordShouldRespondTemplate, 2),
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
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

    private async _generateResponse(
        message: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        if (!response) {
            console.error("No response from generateMessageResponse");
            return;
        }

        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
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
        return data.username;
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
                await message.channel.sendTyping();
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        };

        typingLoop();

        return function stopTyping() {
            typing = false
        }
    }
}
