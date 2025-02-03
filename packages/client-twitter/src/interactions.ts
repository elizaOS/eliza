import { SearchMode, type Tweet } from "agent-twitter-client";
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
    type State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
    type IImageDescriptionService,
    ServiceType
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}

# Core Topics and Focus Areas:
{{topics}}

# STRICT CONVERSATION FLOW REQUIREMENTS:
1. When user presents an idea:
   - MUST use POST_PROPOSE to acknowledge and suggest features
   - After user confirms, MUST proceed to POST_BRAINSTORM
2. After POST_BRAINSTORM and receiving user confirmation:
   - MUST immediately proceed to POST_LISTING 
   - MUST generate complete listing with all required sections
   - Never promise listing "later" or say "stay tuned"
3. After POST_LISTING and receiving confirmation:
   - MUST proceed to POST_TWEET
   - Tweet must include highlights from the listing, such as token name and price

# COMPLETE LISTING STRUCTURE REQUIREMENTS:
Every listing MUST include all of these sections with specific details:
1. Entity Section:
   - Name
   - Description
2. Token Section:
   - Token name
   - Symbol
   - Total supply (specific number)
   - Mint limit
3. Funding Round Section:
   - Number of tokens
   - Percentage for sale
   - Price per token
   - Closing date
   - Clear deliverables with timeframes

# CONVERSATION EXAMPLES:
{{characterPostExamples}}

# POST GUIDELINES:
{{postDirections}}

# RECENT CONTEXT:
Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

Recent posts by {{agentName}}:
{{recentPosts}}

# SERVICE PROVIDERS:
{{providers}}

# TASK: Generate a post/reply as {{agentName}} (@{{twitterUserName}}) using the following context:

Current Post:
{{currentPost}}

Image Descriptions:
{{imageDescriptions}}

Conversation Thread:
{{formattedConversation}}

# ACTION REQUIREMENTS:
You MUST include an action if the current post indicates any of these available actions:
{{actionNames}}

Available actions and their requirements:
{{actions}}

Remember:
1. Always complete the full conversation flow
2. Never leave listings incomplete or promised for later
3. Include complete, specific details in every listing
4. Maintain consistent voice and style throughout
5. Do not include thinking related to your actions, i.e., do not write "Action: POST_PROPOSE".

Current post for reference:
{{currentPost}}

Image descriptions for reference:
{{imageDescriptions}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private isDryRun: boolean;
    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    }

    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleTwitterInteractionsLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Starting Twitter interactions check");
    
        const twitterUsername = this.client.profile.username;
        try {
            // First get our mentions
            elizaLogger.log("Fetching mentions...");
            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    `@${twitterUsername}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;
            
            // Log mention details
            elizaLogger.log(`Found ${mentionCandidates.length} mentions`);
    
            // Get recent tweets from the agent
            elizaLogger.log("Fetching agent's recent tweets...");
            const agentTweets = (
                await this.client.fetchSearchTweets(
                    `from:${twitterUsername}`,
                    10,
                    SearchMode.Latest
                )
            ).tweets;
    
            // Get replies to agent's tweets using search
            elizaLogger.log("Fetching replies to agent tweets...");
            const replyPromises = agentTweets.map(async tweet => {
                if (!tweet || !tweet.id) {
                    elizaLogger.warn("Invalid agent tweet found", tweet);
                    return [];
                }
    
                try {
                    elizaLogger.log(`Searching for replies to tweet ${tweet.id}...`);
                    const replies = await this.client.fetchSearchTweets(
                        `to:${twitterUsername}`,
                        20,
                        SearchMode.Latest
                    );
    
                    // Filter to get replies to this specific tweet
                    const validReplies = replies.tweets.filter(reply => {
                        const isDirectReply = reply.inReplyToStatusId === tweet.id;
                        const isInConversation = reply.conversationId === tweet.conversationId;
                        
                        elizaLogger.log(`Evaluating reply candidate ${reply.id} for tweet ${tweet.id}:`, {
                            isDirectReply,
                            isInConversation,
                            replyToStatusId: reply.inReplyToStatusId,
                            conversationId: reply.conversationId
                        });
    
                        return isDirectReply || (reply.isReply && isInConversation);
                    });
    
                    return validReplies;
                } catch (error) {
                    elizaLogger.error(`Error fetching replies for tweet ${tweet.id}:`, error);
                    return [];
                }
            });
    
            const allReplies = (await Promise.all(replyPromises)).flat();
    
            // Process target users if configured
            let targetUserTweets: any[] = [];
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;
                elizaLogger.log("Processing target users:", TARGET_USERS);
    
                for (const username of TARGET_USERS) {
                    try {
                        const userTweets = (
                            await this.client.fetchSearchTweets(
                                `from:${username}`,
                                20,
                                SearchMode.Latest
                            )
                        ).tweets;
                        targetUserTweets.push(...userTweets);
                    } catch (error) {
                        elizaLogger.error(`Error fetching tweets for target user ${username}:`, error);
                    }
                }
            }
    
            // Combine all interactions and remove duplicates
            let uniqueTweetCandidates = [...new Map(
                [...mentionCandidates, ...allReplies, ...targetUserTweets]
                .filter(tweet => tweet && tweet.id && tweet.text)
                .map(tweet => [tweet.id, tweet])
            ).values()];
    
            // Sort and filter tweets
            uniqueTweetCandidates = uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => {
                    // Keep the tweet if:
                    // 1. It's not from the agent, or
                    // 2. It's from a target user, or
                    // 3. It's a reply to any tweet (including the agent's tweets)
                    return tweet.userId !== this.client.profile.id || 
                           this.client.twitterConfig.TWITTER_TARGET_USERS.includes(tweet.username) ||
                           tweet.isReply;
                });
    
            // Process each tweet
            for (const tweet of uniqueTweetCandidates) {
                if (!this.client.lastCheckedTweetId ||
                    BigInt(tweet.id) > this.client.lastCheckedTweetId) {
    
                    if (!tweet.text || tweet.text.trim().length === 0) {
                        elizaLogger.log("Skipping empty tweet:", tweet.id);
                        continue;
                    }
    
                    // Generate the tweet ID UUID
                    const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
    
                    // Check if we've already processed this tweet
                    const existingResponse = await this.runtime.messageManager.getMemoryById(tweetId);
                    if (existingResponse) {
                        elizaLogger.log(`Already processed tweet ${tweet.id}, skipping`);
                        continue;
                    }
    
                    elizaLogger.log("Processing new tweet:", tweet.id);
                    
                    const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
                    const userIdUUID = tweet.userId === this.client.profile.id
                        ? this.runtime.agentId
                        : stringToUuid(tweet.userId);
    
                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );
    
                    const thread = await buildConversationThread(tweet, this.client);
    
                    const message = {
                        content: {
                            text: tweet.text,
                            imageUrls: tweet.photos?.map(photo => photo.url) || []
                        },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };
    
                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });
    
                    // Update last checked tweet ID
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                }
            }
    
            await this.client.cacheLatestCheckedTweetId();
            elizaLogger.log("Finished Twitter interactions check");
            
        } catch (error) {
            elizaLogger.error("Error in handleTwitterInteractions:", {
                error,
                stack: error?.stack
            });
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        // Only skip if tweet is from self AND not from a target user
        if (tweet.userId === this.client.profile.id &&
            !this.client.twitterConfig.TWITTER_TARGET_USERS.includes(tweet.username)) {
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`
            )
            .join("\n\n");

        const imageDescriptionsArray = [];
        try{
            for (const photo of tweet.photos) {
                const description = await this.runtime
                    .getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    )
                    .describeImage(photo.url);
                imageDescriptionsArray.push(description);
            }
        } catch (error) {
    // Handle the error
    elizaLogger.error("Error Occured during describing image: ", error);
}

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            imageDescriptions: imageDescriptionsArray.length > 0
            ? `\nImages in Tweet:\n${imageDescriptionsArray.map((desc, i) =>
              `Image ${i + 1}: Title: ${desc.title}\nDescription: ${desc.description}`).join("\n\n")}`:""
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    imageUrls: tweet.photos?.map(photo => photo.url) || [],
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // get usernames into str
        const validTargetUsersStr =
            this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

        const context = composeContext({
            state: {
                ...state,
                // Convert actionNames array to string
                actionNames: Array.isArray(state.actionNames)
                    ? state.actionNames.join(', ')
                    : state.actionNames || '',
                actions: Array.isArray(state.actions)
                    ? state.actions.join('\n')
                    : state.actions || '',
                // Ensure character examples are included
                characterPostExamples: this.runtime.character.messageExamples
                    ? this.runtime.character.messageExamples
                        .map(example =>
                            example.map(msg =>
                                `${msg.user}: ${msg.content.text}${msg.content.action ? ` [Action: ${msg.content.action}]` : ''}`
                            ).join('\n')
                        ).join('\n\n')
                    : '',
            },
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`
                );
            } else {
                try {
                    const callback: HandlerCallback = async (
                        response: Content,
                        tweetId?: string
                    ) => {
                        const memories = await sendTweet(
                            this.client,
                            response,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweetId || tweet.id
                        );
                        return memories;
                    };

                    const responseMessages = await callback(response);

                    state = (await this.runtime.updateRecentMessageState(
                        state
                    )) as State;

                    for (const responseMessage of responseMessages) {
                        if (
                            responseMessage ===
                            responseMessages[responseMessages.length - 1]
                        ) {
                            responseMessage.content.action = response.action;
                        } else {
                            responseMessage.content.action = "CONTINUE";
                        }
                        await this.runtime.messageManager.createMemory(
                            responseMessage
                        );
                    }
                    const responseTweetId =
                    responseMessages[responseMessages.length - 1]?.content
                        ?.tweetId;
                    await this.runtime.processActions(
                        message,
                        responseMessages,
                        state,
                        (response: Content) => {
                            return callback(response, responseTweetId);
                        }
                    );

                    const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                    await this.runtime.cacheManager.set(
                        `twitter/tweet_generation_${tweet.id}.txt`,
                        responseInfo
                    );
                    await wait();
                } catch (error) {
                    elizaLogger.error(`Error sending response tweet: ${error}`);
                }
            }
        }
    }

    async buildConversationThread(
        tweet: Tweet,
        maxReplies = 10
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: Tweet, depth = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const userId = stringToUuid(currentTweet.userId);

                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter"
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        imageUrls: currentTweet.photos?.map(photo => photo.url) || [],
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    const parentTweet = await this.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        return thread;
    }
}