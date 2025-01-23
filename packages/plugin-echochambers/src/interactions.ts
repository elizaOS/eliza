import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import type { EchoChamberClient } from "./echoChamberClient";
import type { ChatMessage, ChatRoom } from "./types";

function createMessageTemplate(currentRoom: string, roomTopic: string) {
    return (
        `
# About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

Current Room: ${currentRoom}
Room Topic: ${roomTopic}

{{messageDirections}}

Recent conversation history:
{{recentMessages}}

Thread Context:
{{formattedConversation}}

# Task: Generate a response in the voice and style of {{agentName}} while:
1. Staying relevant to the room's topic
2. Maintaining conversation context
3. Being helpful but not overly talkative
4. Responding naturally to direct questions or mentions
5. Contributing meaningfully to ongoing discussions

Remember:
- Keep responses concise and focused
- Stay on topic for the current room
- Don't repeat information already shared
- Be natural and conversational
` + messageCompletionFooter
    );
}

function createShouldRespondTemplate(currentRoom: string, roomTopic: string) {
    return (
        `
# About {{agentName}}:
{{bio}}
{{knowledge}}

Current Room: ${currentRoom}
Room Topic: ${roomTopic}

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} should:
- RESPOND when:
  * Directly mentioned or asked a question
  * Can contribute relevant expertise to the discussion
  * Topic aligns with their knowledge and background
  * Conversation is active and engaging

- IGNORE when:
  * Message is not relevant to their expertise
  * Already responded recently without new information to add
  * Conversation has moved to a different topic
  * Message is too short or lacks substance
  * Other participants are handling the discussion well

- STOP when:
  * Asked to stop participating
  * Conversation has concluded
  * Discussion has completely diverged from their expertise
  * Room topic has changed significantly

Recent messages:
{{recentMessages}}

Thread Context:
{{formattedConversation}}

# Task: Choose whether {{agentName}} should respond to the last message.
Consider:
1. Message relevance to {{agentName}}'s expertise
2. Current conversation context
3. Time since last response
4. Value of potential contribution
` + shouldRespondFooter
    );
}

function createConversationStarterTemplate(
    currentRoom: string,
    roomTopic: string
) {
    return `
# Room Context:
Room: ${currentRoom}
Topic: ${roomTopic}

# About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

# Task: Generate a conversation starter that:
1. Is specifically relevant to the room's topic
2. Draws from {{agentName}}'s knowledge
3. Encourages discussion and engagement
4. Is natural and conversational

Keep it concise and focused on the room's topic.
${messageCompletionFooter}`;
}

export class InteractionClient {
    private client: EchoChamberClient;
    private runtime: IAgentRuntime;
    private lastCheckedTimestamps: Map<string, string> = new Map();
    private lastResponseTimes: Map<string, number> = new Map();
    private messageThreads: Map<string, ChatMessage[]> = new Map();
    private messageHistory: Map<
        string,
        { message: ChatMessage; response: ChatMessage | null }[]
    > = new Map();
    private pollInterval: NodeJS.Timeout | null = null;
    private conversationStarterInterval: NodeJS.Timeout | null = null;

    constructor(client: EchoChamberClient, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    async start() {
        const pollInterval = Number(
            this.runtime.getSetting("ECHOCHAMBERS_POLL_INTERVAL") || 60
        );

        const conversationStarterInterval = Number(
            this.runtime.getSetting(
                "ECHOCHAMBERS_CONVERSATION_STARTER_INTERVAL"
            ) || 300
        );

        // Reactive message handling loop
        const handleInteractionsLoop = () => {
            this.handleInteractions();
            this.pollInterval = setTimeout(
                handleInteractionsLoop,
                pollInterval * 1000
            );
        };

        // Proactive conversation loop
        const conversationStarterLoop = () => {
            this.checkForDeadRooms();
            this.conversationStarterInterval = setTimeout(
                conversationStarterLoop,
                conversationStarterInterval * 1000
            );
        };

        handleInteractionsLoop();
        conversationStarterLoop();
    }

    async stop() {
        if (this.pollInterval) {
            clearTimeout(this.pollInterval);
            this.pollInterval = null;
        }

        if (this.conversationStarterInterval) {
            clearTimeout(this.conversationStarterInterval);
            this.conversationStarterInterval = null;
        }
    }

    private async buildMessageThread(
        message: ChatMessage,
        messages: ChatMessage[]
    ): Promise<ChatMessage[]> {
        const thread: ChatMessage[] = [];
        const maxThreadLength = Number(
            this.runtime.getSetting("ECHOCHAMBERS_MAX_MESSAGES") || 10
        );

        // Start with the current message
        thread.push(message);

        // Get recent messages in the same room, ordered by timestamp
        const roomMessages = messages
            .filter((msg) => msg.roomId === message.roomId)
            .sort(
                (a, b) =>
                    new Date(b.timestamp).getTime() -
                    new Date(a.timestamp).getTime()
            );

        // Add recent messages to provide context
        for (const msg of roomMessages) {
            if (thread.length >= maxThreadLength) break;
            if (msg.id !== message.id) {
                thread.unshift(msg);
            }
        }

        return thread;
    }

    private shouldProcessMessage(
        message: ChatMessage,
        room: { topic: string }
    ): boolean {
        const modelInfo = this.client.getModelInfo();

        // Don't process own messages
        if (message.sender.username === modelInfo.username) {
            return false;
        }

        // Check if we've processed this message before
        const lastChecked =
            this.lastCheckedTimestamps.get(message.roomId) || "0";
        if (message.timestamp <= lastChecked) {
            return false;
        }

        // Check rate limiting for responses
        const lastResponseTime =
            this.lastResponseTimes.get(message.roomId) || 0;
        const minTimeBetweenResponses = 30000; // 30 seconds
        if (Date.now() - lastResponseTime < minTimeBetweenResponses) {
            return false;
        }

        // Check if message mentions the agent
        const isMentioned = message.content
            .toLowerCase()
            .includes(`${modelInfo.username.toLowerCase()}`);

        // Check if message is relevant to room topic
        const isRelevantToTopic =
            room.topic &&
            message.content.toLowerCase().includes(room.topic.toLowerCase());

        // Always process if mentioned, otherwise check relevance
        return isMentioned || isRelevantToTopic;
    }

    private async handleInteractions() {
        elizaLogger.log("Checking EchoChambers interactions");

        try {
            // Get all watched rooms from the client
            const watchedRooms = this.client.getWatchedRooms();
            const rooms = await this.client.listRooms();

            for (const room of rooms) {
                // Only process messages from watched rooms
                if (!watchedRooms.includes(room.id)) {
                    continue;
                }

                const messages = await this.client.getRoomHistory(room.id);
                this.messageThreads.set(room.id, messages);

                // Get only the most recent message that we should process
                const latestMessages = messages
                    .filter((msg) => this.shouldProcessMessage(msg, room))
                    .sort(
                        (a, b) =>
                            new Date(b.timestamp).getTime() -
                            new Date(a.timestamp).getTime()
                    );

                if (latestMessages.length > 0) {
                    const latestMessage = latestMessages[0];
                    await this.handleMessage(latestMessage, room.topic);

                    // Update history
                    const roomHistory = this.messageHistory.get(room.id) || [];
                    roomHistory.push({
                        message: latestMessage,
                        response: null,
                    });
                    this.messageHistory.set(room.id, roomHistory);

                    // Update last checked timestamp
                    if (
                        latestMessage.timestamp >
                        (this.lastCheckedTimestamps.get(room.id) || "0")
                    ) {
                        this.lastCheckedTimestamps.set(
                            room.id,
                            latestMessage.timestamp
                        );
                    }
                }
            }

            elizaLogger.log("Finished checking EchoChambers interactions");
        } catch (error) {
            elizaLogger.error(
                "Error handling EchoChambers interactions:",
                error
            );
        }
    }

    private async handleMessage(message: ChatMessage, roomTopic: string) {
        try {
            elizaLogger.debug("Processing message:", {
                id: message.id,
                room: message.roomId,
                sender: message?.sender?.username,
                content: message.content?.substring(0, 50) + "...", // First 50 chars
            });

            const roomId = stringToUuid(message.roomId);
            const userId = stringToUuid(message.sender.username);

            elizaLogger.debug("Converted IDs:", { roomId, userId });

            // Ensure connection exists
            await this.runtime.ensureConnection(
                userId,
                roomId,
                message.sender.username,
                message.sender.username,
                "echochambers"
            );

            // Build message thread for context
            const thread = await this.buildMessageThread(
                message,
                this.messageThreads.get(message.roomId) || []
            );

            // Create memory object
            const memory: Memory = {
                id: stringToUuid(message.id),
                userId,
                agentId: this.runtime.agentId,
                roomId,
                content: {
                    text: message.content,
                    source: "echochambers",
                    thread: thread.map((msg) => ({
                        text: msg.content,
                        sender: msg.sender.username,
                        timestamp: msg.timestamp,
                    })),
                },
                createdAt: new Date(message.timestamp).getTime(),
                embedding: getEmbeddingZeroVector(),
            };

            // Check if we've already processed this message
            const existing = await this.runtime.messageManager.getMemoryById(
                memory.id
            );
            if (existing) {
                elizaLogger.log(
                    `Already processed message ${message.id}, skipping`
                );
                return;
            }

            // Save the message to memory
            await this.runtime.messageManager.createMemory(memory);

            // Compose state with thread context
            let state = await this.runtime.composeState(memory);
            state = await this.runtime.updateRecentMessageState(state);

            // Decide whether to respond
            const shouldRespondContext = composeContext({
                state,
                template:
                    this.runtime.character.templates?.shouldRespondTemplate ||
                    createShouldRespondTemplate(message.roomId, roomTopic),
            });

            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });

            if (shouldRespond !== "RESPOND") {
                elizaLogger.log(
                    `Not responding to message ${message.id}: ${shouldRespond}`
                );
                return;
            }

            // Generate response
            const responseContext = composeContext({
                state,
                template:
                    this.runtime.character.templates?.messageHandlerTemplate ||
                    createMessageTemplate(message.roomId, roomTopic),
            });

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context: responseContext,
                modelClass: ModelClass.LARGE,
            });

            if (!response || !response.text) {
                elizaLogger.log("No response generated");
                return;
            }

            // Send response
            const callback: HandlerCallback = async (content: Content) => {
                const sentMessage = await this.client.sendMessage(
                    message.roomId,
                    content.text
                );

                // Update last response time
                this.lastResponseTimes.set(message.roomId, Date.now());

                // Update history with our response
                const roomHistory =
                    this.messageHistory.get(message.roomId) || [];
                const lastEntry = roomHistory[roomHistory.length - 1];
                if (lastEntry && lastEntry.message.id === message.id) {
                    lastEntry.response = sentMessage;
                }

                const responseMemory: Memory = {
                    id: stringToUuid(sentMessage.id),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    roomId,
                    content: {
                        text: sentMessage.content,
                        source: "echochambers",
                        action: content.action,
                        thread: thread.map((msg) => ({
                            text: msg.content,
                            sender: msg.sender.username,
                            timestamp: msg.timestamp,
                        })),
                    },
                    createdAt: new Date(sentMessage.timestamp).getTime(),
                    embedding: getEmbeddingZeroVector(),
                };

                await this.runtime.messageManager.createMemory(responseMemory);
                return [responseMemory];
            };

            // Send the response and process any resulting actions
            const responseMessages = await callback(response);
            state = await this.runtime.updateRecentMessageState(state);
            await this.runtime.processActions(
                memory,
                responseMessages,
                state,
                callback
            );
            await this.runtime.evaluate(memory, state, true);
        } catch (error) {
            elizaLogger.error("Error handling message:", error);
            elizaLogger.debug("Message that caused error:", {
                message,
                roomTopic,
            });
        }
    }

    private async checkForDeadRooms() {
        try {
            const watchedRooms = this.client.getWatchedRooms();
            elizaLogger.debug(
                "Starting dead room check. Watched rooms:",
                watchedRooms
            );

            const rooms = await this.client.listRooms();
            elizaLogger.debug(
                "Available rooms:",
                rooms.map((r) => ({ id: r.id, name: r.name }))
            );

            for (const roomId of watchedRooms) {
                try {
                    elizaLogger.debug(`Checking room ${roomId}`);

                    const room = rooms.find((r) => r.id === roomId);
                    if (!room) {
                        elizaLogger.debug(`Room ${roomId} not found, skipping`);
                        continue;
                    }

                    // Log room details
                    elizaLogger.debug("Room details:", {
                        id: room.id,
                        name: room.name,
                        topic: room.topic,
                    });

                    // Random check with logging
                    const randomCheck = Math.random();
                    elizaLogger.debug(
                        `Random check for ${room.name}: ${randomCheck}`
                    );

                    if (randomCheck > 0.8) {
                        elizaLogger.debug(
                            `Checking conversation state for ${room.name}`
                        );

                        const shouldInitiate =
                            await this.client.shouldInitiateConversation(room);
                        elizaLogger.debug(
                            `Should initiate conversation in ${room.name}:`,
                            shouldInitiate
                        );

                        if (shouldInitiate) {
                            elizaLogger.debug(
                                `Starting conversation initiation in ${room.name}`
                            );
                            await this.initiateConversation(room);
                            elizaLogger.debug(
                                `Completed conversation initiation in ${room.name}`
                            );
                        }
                    }
                } catch (roomError: any) {
                    // Log individual room errors without stopping the loop
                    elizaLogger.error(`Error processing room ${roomId}:`, {
                        error: roomError?.message || roomError,
                        stack: roomError?.stack,
                    });
                }
            }
        } catch (error: any) {
            elizaLogger.error(
                "Error in checkForDeadRooms:",
                error?.message || error || "Unknown error"
            );
            elizaLogger.debug("Full error details:", {
                error,
                stack: error?.stack,
                type: typeof error,
            });
        }
    }

    private async initiateConversation(room: ChatRoom) {
        try {
            elizaLogger.debug(`Starting initiateConversation for ${room.name}`);

            // Create a dummy memory instead of passing null
            const dummyMemory: Memory = {
                id: stringToUuid("conversation-starter"),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: stringToUuid(room.id),
                content: {
                    text: "",
                    source: "echochambers",
                    thread: [],
                },
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };

            const state = await this.runtime.composeState(dummyMemory);
            elizaLogger.debug("Composed state for conversation");

            const context = composeContext({
                state,
                template: createConversationStarterTemplate(
                    room.name,
                    room.topic
                ),
            });
            elizaLogger.debug("Created conversation context");

            const content = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });
            elizaLogger.debug("Generated response content:", {
                hasContent: !!content,
                textLength: content?.text?.length,
            });

            if (content?.text) {
                elizaLogger.debug(`Sending message to ${room.name}`);
                await this.client.sendMessage(room.id, content.text);
                elizaLogger.info(
                    `Started conversation in ${room.name} (Topic: ${room.topic})`
                );
            }
        } catch (error: any) {
            elizaLogger.error(
                `Error in initiateConversation for ${room.name}:`,
                {
                    error: error?.message || error,
                    stack: error?.stack,
                }
            );
            throw error; // Re-throw to be caught by parent
        }
    }
}
