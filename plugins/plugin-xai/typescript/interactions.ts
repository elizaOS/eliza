import {
  ChannelType,
  type Content,
  ContentType,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
  ModelType,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { ClientBase } from './base';
import { SearchMode } from './client/index';
import type { Tweet as ClientTweet } from './client/tweets';
import type {
  Tweet as CoreTweet,
  TwitterInteractionMemory,
  TwitterInteractionPayload,
  TwitterLikeReceivedPayload,
  TwitterMemory,
  TwitterQuoteReceivedPayload,
  TwitterRetweetReceivedPayload,
} from './types';
import { TwitterEventTypes } from './types';
import { sendTweet } from './utils';
import { shouldTargetUser, getTargetUsers } from './environment';
import { getSetting } from './utils/settings';
import { getRandomInterval } from './environment';
import { getEpochMs } from './utils/time';
import {
  ensureTwitterContext as ensureContext,
  createMemorySafe,
  isTweetProcessed,
} from './utils/memory';

/**
 * Template for generating dialog and actions for a Twitter message handler.
 *
 * @type {string}
 */
/**
 * Templates for XAI plugin interactions.
 * Auto-generated from prompts/*.txt
 * DO NOT EDIT - Generated from ./generated/prompts/typescript/prompts.ts
 */
import {
  twitterMessageHandlerTemplate,
  messageHandlerTemplate,
} from "./generated/prompts/typescript/prompts.js";
export { twitterMessageHandlerTemplate, messageHandlerTemplate };

/**
 * The TwitterInteractionClient class manages Twitter interactions,
 * including handling mentions, managing timelines, and engaging with other users.
 * It extends the base Twitter client functionality to provide mention handling,
 * user interaction, and follow change detection capabilities.
 *
 * @extends ClientBase
 */
export class TwitterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  private twitterUserId: string;
  private isDryRun: boolean;
  private state: any;
  private isRunning: boolean = false;
  private lastProcessedTimestamp: number = Date.now();

  /**
   * Constructor to initialize the Twitter interaction client with runtime and state management.
   *
   * @param {ClientBase} client - The client instance.
   * @param {IAgentRuntime} runtime - The runtime instance for agent operations.
   * @param {any} state - The state object containing configuration settings.
   */
  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.runtime = runtime;
    this.state = state;

    const dryRunSetting =
      this.state?.TWITTER_DRY_RUN ??
      getSetting(this.runtime, 'TWITTER_DRY_RUN') ??
      process.env.TWITTER_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
      dryRunSetting === 'true' ||
      (typeof dryRunSetting === 'string' && dryRunSetting.toLowerCase() === 'true');
  }

  /**
   * Asynchronously starts the process of handling Twitter interactions on a loop.
   * Uses the unified TWITTER_ENGAGEMENT_INTERVAL setting.
   */
  async start() {
    this.isRunning = true;

    const handleTwitterInteractionsLoop = () => {
      if (!this.isRunning) {
        logger.info('Twitter interaction client stopped, exiting loop');
        return;
      }

      // Get random engagement interval in minutes
      const engagementIntervalMinutes = getRandomInterval(this.runtime, 'engagement');

      const interactionInterval = engagementIntervalMinutes * 60 * 1000;

      logger.info(
        `Twitter interaction client will check in ${engagementIntervalMinutes.toFixed(1)} minutes`
      );

      this.handleTwitterInteractions();

      if (this.isRunning) {
        setTimeout(handleTwitterInteractionsLoop, interactionInterval);
      }
    };
    handleTwitterInteractionsLoop();
  }

  /**
   * Stops the Twitter interaction client
   */
  async stop() {
    logger.log('Stopping Twitter interaction client...');
    this.isRunning = false;
  }

  /**
   * Asynchronously handles Twitter interactions by checking for mentions and target user posts.
   */
  async handleTwitterInteractions() {
    logger.log('Checking Twitter interactions');

    const twitterUsername = this.client.profile?.username;

    try {
      // Check for mentions first (replies enabled by default)
      const repliesEnabled =
        (getSetting(this.runtime, 'TWITTER_ENABLE_REPLIES') ??
          process.env.TWITTER_ENABLE_REPLIES) !== 'false';

      if (repliesEnabled) {
        await this.handleMentions(twitterUsername);
      }

      // Check target users' posts for autonomous engagement
      const targetUsersConfig =
        ((getSetting(this.runtime, 'TWITTER_TARGET_USERS') ??
          process.env.TWITTER_TARGET_USERS) as string) || '';

      if (targetUsersConfig?.trim()) {
        await this.handleTargetUserPosts(targetUsersConfig);
      }

      // Save the latest checked tweet ID to the file
      await this.client.cacheLatestCheckedTweetId();

      logger.log('Finished checking Twitter interactions');
    } catch (error) {
      logger.error('Error handling Twitter interactions:', error);
    }
  }

  /**
   * Handle mentions and replies
   */
  private async handleMentions(twitterUsername: string) {
    try {
      // Check for mentions
      const cursorKey = `twitter/${twitterUsername}/mention_cursor`;
      const cachedCursor: String = await this.runtime.getCache<string>(cursorKey);

      const searchResult = await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20,
        SearchMode.Latest,
        String(cachedCursor)
      );

      const mentionCandidates = searchResult.tweets;

      // If we got tweets and there's a valid cursor, cache it
      if (mentionCandidates.length > 0 && searchResult.previous) {
        await this.runtime.setCache(cursorKey, searchResult.previous);
      } else if (!searchResult.previous && !searchResult.next) {
        // If both previous and next are missing, clear the outdated cursor
        await this.runtime.setCache(cursorKey, '');
      }

      await this.processMentionTweets(mentionCandidates);
    } catch (error) {
      logger.error('Error handling mentions:', error);
    }
  }

  /**
   * Handle autonomous engagement with target users' posts
   */
  private async handleTargetUserPosts(targetUsersConfig: string) {
    try {
      const targetUsers = getTargetUsers(targetUsersConfig);

      if (targetUsers.length === 0 && !targetUsersConfig.includes('*')) {
        return; // No target users configured
      }

      logger.info(`Checking posts from target users: ${targetUsers.join(', ') || 'everyone (*)'}`);

      // For each target user, search their recent posts
      for (const targetUser of targetUsers) {
        try {
          const normalizedUsername = targetUser.replace(/^@/, '');

          // Search for recent posts from this user
          const searchQuery = `from:${normalizedUsername} -is:reply -is:retweet`;
          const searchResult = await this.client.fetchSearchTweets(
            searchQuery,
            10, // Get up to 10 recent posts per user
            SearchMode.Latest
          );

          if (searchResult.tweets.length > 0) {
            logger.info(`Found ${searchResult.tweets.length} posts from @${normalizedUsername}`);

            // Process these tweets for potential engagement
            await this.processTargetUserTweets(searchResult.tweets, normalizedUsername);
          }
        } catch (error) {
          logger.error(`Error searching posts from @${targetUser}:`, error);
        }
      }

      // If wildcard is configured, also check timeline for any interesting posts
      if (targetUsersConfig.includes('*')) {
        await this.processTimelineForEngagement();
      }
    } catch (error) {
      logger.error('Error handling target user posts:', error);
    }
  }

  /**
   * Process tweets from target users for potential engagement
   */
  private async processTargetUserTweets(tweets: ClientTweet[], username: string) {
    const maxEngagementsPerRun = parseInt(
      (getSetting(this.runtime, 'TWITTER_MAX_ENGAGEMENTS_PER_RUN') as string) ||
        process.env.TWITTER_MAX_ENGAGEMENTS_PER_RUN ||
        '10'
    );

    let engagementCount = 0;

    for (const tweet of tweets) {
      if (engagementCount >= maxEngagementsPerRun) {
        logger.info(`Reached max engagements limit (${maxEngagementsPerRun})`);
        break;
      }

      // Skip if already processed
      const isProcessed = await isTweetProcessed(this.runtime, tweet.id);
      if (isProcessed) {
        continue; // Already processed
      }

      // Skip if tweet is too old (older than 24 hours)
      const tweetAge = Date.now() - getEpochMs(tweet.timestamp);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      if (tweetAge > maxAge) {
        continue;
      }

      // Decide whether to engage with this tweet
      const shouldEngage = await this.shouldEngageWithTweet(tweet);

      if (shouldEngage) {
        logger.info(`Engaging with tweet from @${username}: ${tweet.text.substring(0, 50)}...`);

        // Create necessary context for the tweet
        await this.ensureTweetContext(tweet);

        // Handle the tweet (generate and send reply)
        const engaged = await this.engageWithTweet(tweet);

        if (engaged) {
          engagementCount++;
        }
      }
    }
  }

  /**
   * Process timeline for engagement when wildcard is configured
   */
  private async processTimelineForEngagement() {
    try {
      // This would use the timeline client if available, but for now
      // we'll do a general search for recent popular tweets
      const searchResult = await this.client.fetchSearchTweets(
        'min_retweets:10 min_faves:20 -is:reply -is:retweet lang:en',
        20,
        SearchMode.Latest
      );

      const relevantTweets = searchResult.tweets.filter((tweet) => {
        // Filter for tweets from the last 12 hours
        const tweetAge = Date.now() - getEpochMs(tweet.timestamp);
        return tweetAge < 12 * 60 * 60 * 1000;
      });

      if (relevantTweets.length > 0) {
        logger.info(`Found ${relevantTweets.length} relevant tweets from timeline`);
        await this.processTargetUserTweets(relevantTweets, 'timeline');
      }
    } catch (error) {
      logger.error('Error processing timeline for engagement:', error);
    }
  }

  /**
   * Determine if the bot should engage with a specific tweet
   */
  private async shouldEngageWithTweet(tweet: ClientTweet): Promise<boolean> {
    try {
      // Create a simple evaluation prompt
      const evaluationContext = {
        tweet: tweet.text,
        author: tweet.username,
        metrics: {
          likes: tweet.likes || 0,
          retweets: tweet.retweets || 0,
          replies: tweet.replies || 0,
        },
      };

      const shouldEngageMemory: Memory = {
        id: createUniqueUuid(this.runtime, `eval-${tweet.id}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: createUniqueUuid(this.runtime, tweet.conversationId),
        content: {
          text: `Should I engage with this tweet? Tweet: "${tweet.text}" by @${tweet.username}`,
          evaluationContext,
        },
        createdAt: Date.now(),
      };

      const state = await this.runtime.composeState(shouldEngageMemory);
      const characterName = this.runtime?.character?.name || 'AI Assistant';
      const context = `You are ${characterName}. Should you reply to this tweet based on your interests and expertise?
      
Tweet by @${tweet.username}: "${tweet.text}"

Reply with YES if:
- The topic relates to your interests or expertise
- You can add valuable insights or perspective
- The conversation seems constructive

Reply with NO if:
- The topic is outside your knowledge
- The tweet is inflammatory or controversial
- You have nothing meaningful to add

Response (YES/NO):`;

      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: context,
        temperature: 0.3,
        maxTokens: 10,
        stop: ['\n'],
      });

      return response.trim().toUpperCase().includes('YES');
    } catch (error) {
      logger.error('Error determining engagement:', error);
      return false;
    }
  }

  /**
   * Ensure tweet context exists (world, room, entity)
   */
  private async ensureTweetContext(tweet: ClientTweet) {
    try {
      const context = await ensureContext(this.runtime, {
        userId: tweet.userId,
        username: tweet.username,
        name: tweet.name,
        conversationId: tweet.conversationId || tweet.id,
      });

      // Save tweet as memory with error handling
      const tweetMemory: Memory = {
        id: createUniqueUuid(this.runtime, tweet.id),
        entityId: context.entityId,
        content: {
          text: tweet.text,
          url: tweet.permanentUrl,
          source: 'twitter',
          tweet,
        },
        agentId: this.runtime.agentId,
        roomId: context.roomId,
        createdAt: getEpochMs(tweet.timestamp),
      };

      await createMemorySafe(this.runtime, tweetMemory, 'messages');
    } catch (error) {
      logger.error(`Failed to ensure context for tweet ${tweet.id}:`, error);
      throw error;
    }
  }

  /**
   * Engage with a tweet by generating and sending a reply
   */
  private async engageWithTweet(tweet: ClientTweet): Promise<boolean> {
    try {
      const message: Memory = {
        id: createUniqueUuid(this.runtime, tweet.id),
        entityId: createUniqueUuid(this.runtime, tweet.userId),
        content: {
          text: tweet.text,
          source: 'twitter',
          tweet,
        },
        agentId: this.runtime.agentId,
        roomId: createUniqueUuid(this.runtime, tweet.conversationId),
        createdAt: getEpochMs(tweet.timestamp),
      };

      const result = await this.handleTweet({
        tweet,
        message,
        thread: tweet.thread || [tweet],
      });

      return result.text && result.text.length > 0;
    } catch (error) {
      logger.error('Error engaging with tweet:', error);
      return false;
    }
  }

  /**
   * Processes all incoming tweets that mention the bot.
   * For each new tweet:
   *  - Ensures world, room, and connection exist
   *  - Saves the tweet as memory
   *  - Emits thread-related events (THREAD_CREATED / THREAD_UPDATED)
   *  - Delegates tweet content to `handleTweet` for reply generation
   *
   * Note: MENTION_RECEIVED is currently disabled (see TODO below)
   */
  async processMentionTweets(mentionCandidates: ClientTweet[]) {
    logger.log('Completed checking mentioned tweets:', mentionCandidates.length.toString());
    let uniqueTweetCandidates = [...mentionCandidates];

    // Sort tweet candidates by ID in ascending order
    uniqueTweetCandidates = uniqueTweetCandidates
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((tweet) => tweet.userId !== this.client.profile.id);

    // Get TWITTER_TARGET_USERS configuration
    const targetUsersConfig =
      ((getSetting(this.runtime, 'TWITTER_TARGET_USERS') ??
        process.env.TWITTER_TARGET_USERS) as string) || '';

    // Filter tweets based on TWITTER_TARGET_USERS if configured
    if (targetUsersConfig?.trim()) {
      uniqueTweetCandidates = uniqueTweetCandidates.filter((tweet) => {
        const shouldTarget = shouldTargetUser(tweet.username || '', targetUsersConfig);
        if (!shouldTarget) {
          logger.log(`Skipping tweet from @${tweet.username} - not in target users list`);
        }
        return shouldTarget;
      });
    }

    // Get max interactions per run setting
    const maxInteractionsPerRun = parseInt(
      (getSetting(this.runtime, 'TWITTER_MAX_ENGAGEMENTS_PER_RUN') as string) ||
        process.env.TWITTER_MAX_ENGAGEMENTS_PER_RUN ||
        '10'
    );

    // Limit the number of interactions per run
    const tweetsToProcess = uniqueTweetCandidates.slice(0, maxInteractionsPerRun);
    logger.info(
      `Processing ${tweetsToProcess.length} of ${uniqueTweetCandidates.length} mention tweets (max: ${maxInteractionsPerRun})`
    );

    // for each tweet candidate, handle the tweet
    for (const tweet of tweetsToProcess) {
      if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
        // Generate the tweetId UUID the same way it's done in handleTweet
        const tweetId = createUniqueUuid(this.runtime, tweet.id);

        // Check if we've already processed this tweet
        const existingResponse = await this.runtime.getMemoryById(tweetId);

        if (existingResponse) {
          logger.log(`Already responded to tweet ${tweet.id}, skipping`);
          continue;
        }

        // Also check if we've already responded to this tweet (for chunked responses)
        // by looking for any memory with inReplyTo pointing to this tweet
        const conversationRoomId = createUniqueUuid(this.runtime, tweet.conversationId);
        const existingReplies = await this.runtime.getMemories({
          tableName: 'messages',
          roomId: conversationRoomId,
          count: 10, // Check recent messages in this room
        });

        // Check if any of the found memories is a reply to this specific tweet
        const hasExistingReply = existingReplies.some(
          (memory) => memory.content.inReplyTo === tweetId || memory.content.inReplyTo === tweet.id
        );

        if (hasExistingReply) {
          logger.log(
            `Already responded to tweet ${tweet.id} (found in conversation history), skipping`
          );
          continue;
        }

        logger.log('New Tweet found', tweet.id);

        const userId = tweet.userId;
        const conversationId = tweet.conversationId || tweet.id;
        const roomId = createUniqueUuid(this.runtime, conversationId);
        const username = tweet.username;

        logger.log('----');
        logger.log(`User: ${username} (${userId})`);
        logger.log(`Tweet: ${tweet.id}`);
        logger.log(`Conversation: ${conversationId}`);
        logger.log(`Room: ${roomId}`);
        logger.log('----');

        // 1. Ensure world exists for the user
        const worldId = createUniqueUuid(this.runtime, userId);
        await this.runtime.ensureWorldExists({
          id: worldId,
          name: `${username}'s Twitter`,
          agentId: this.runtime.agentId,
          serverId: userId,
          metadata: {
            ownership: { ownerId: userId },
            twitter: {
              username: username,
              id: userId,
            },
          },
        });

        // 2. Ensure entity connection
        const entityId = createUniqueUuid(this.runtime, userId);
        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: username,
          name: tweet.name,
          source: 'twitter',
          type: ChannelType.FEED,
          worldId: worldId,
        });

        // 2.5. Ensure room exists
        await this.runtime.ensureRoomExists({
          id: roomId,
          name: `Twitter conversation ${conversationId}`,
          source: 'twitter',
          type: ChannelType.FEED,
          channelId: conversationId,
          serverId: userId,
          worldId: worldId,
        });

        // 3. Create a memory for the tweet
        const memory: Memory = {
          id: tweetId,
          entityId,
          content: {
            text: tweet.text,
            url: tweet.permanentUrl,
            source: 'twitter',
            tweet,
          },
          agentId: this.runtime.agentId,
          roomId,
          createdAt: getEpochMs(tweet.timestamp),
        };

        logger.log('Saving tweet memory...');
        await createMemorySafe(this.runtime, memory, 'messages');

        // TODO: This doesn't work as intended - thread events are mixed with other events
        //       and need a better implementation strategy
        // this.runtime.emitEvent(TwitterEventTypes.MENTION_RECEIVED, {
        //   entityId,
        //   memory: {...memory, id: createUniqueUuid(this.runtime)},
        //   world: {id: worldId, ...},
        //   isThread: !!tweet.thread,
        // });

        // 4. Handle thread-specific events
        if (tweet.thread && tweet.thread.length > 0) {
          const threadStartId = tweet.thread[0].id;
          const threadMemoryId = createUniqueUuid(this.runtime, `thread-${threadStartId}`);

          const threadPayload = {
            runtime: this.runtime,
            entityId,
            conversationId: threadStartId,
            roomId: roomId,
            memory: memory,
            tweet: tweet,
            threadId: threadStartId,
            threadMemoryId: threadMemoryId,
          };

          // Check if this is a reply to an existing thread
          const previousThreadMemory = await this.runtime.getMemoryById(threadMemoryId);
          if (previousThreadMemory) {
            // This is a reply to an existing thread
            this.runtime.emitEvent(TwitterEventTypes.THREAD_UPDATED, threadPayload);
          } else if (tweet.thread[0].id === tweet.id) {
            // This is the start of a new thread
            this.runtime.emitEvent(TwitterEventTypes.THREAD_CREATED, threadPayload);
          }
        }

        await this.handleTweet({
          tweet,
          message: memory,
          thread: tweet.thread,
        });

        // Update the last checked tweet ID after processing each tweet
        this.client.lastCheckedTweetId = BigInt(tweet.id);
      }
    }
  }

  /**
   * Handles Twitter interactions such as likes, retweets, and quotes.
   * For each interaction:
   *  - Creates a memory object
   *  - Emits platform-specific events (LIKE_RECEIVED, RETWEET_RECEIVED, QUOTE_RECEIVED)
   *  - Emits a generic REACTION_RECEIVED event with metadata
   */
  async handleInteraction(interaction: TwitterInteractionPayload) {
    if (interaction?.targetTweet?.conversationId) {
      const memory = this.createMemoryObject(
        interaction.type,
        `${interaction.id}-${interaction.type}`,
        interaction.userId,
        interaction.targetTweet.conversationId
      );

      await createMemorySafe(this.runtime, memory, 'messages');

      // Create message for reaction
      const reactionMessage: TwitterMemory = {
        id: createUniqueUuid(this.runtime, interaction.targetTweetId),
        content: {
          text: interaction.targetTweet.text,
          source: 'twitter',
        },
        entityId: createUniqueUuid(this.runtime, interaction.userId),
        roomId: createUniqueUuid(this.runtime, interaction.targetTweet.conversationId),
        agentId: this.runtime.agentId,
        createdAt: Date.now(),
      };

      // Emit specific event for each type of interaction
      switch (interaction.type) {
        case 'like': {
          const payload: TwitterLikeReceivedPayload = {
            runtime: this.runtime,
            tweet: interaction.targetTweet,
            user: {
              id: interaction.userId,
              username: interaction.username,
              name: interaction.name,
            },
            source: 'twitter',
          };
          this.runtime.emitEvent(TwitterEventTypes.LIKE_RECEIVED, payload);
          break;
        }
        case 'retweet': {
          const payload: TwitterRetweetReceivedPayload = {
            runtime: this.runtime,
            tweet: interaction.targetTweet,
            retweetId: interaction.retweetId || interaction.id,
            user: {
              id: interaction.userId,
              username: interaction.username,
              name: interaction.name,
            },
            source: 'twitter',
          };
          this.runtime.emitEvent(TwitterEventTypes.RETWEET_RECEIVED, payload);
          break;
        }
        case 'quote': {
          const payload: TwitterQuoteReceivedPayload = {
            runtime: this.runtime,
            quotedTweet: interaction.targetTweet,
            quoteTweet: interaction.quoteTweet || interaction.targetTweet,
            user: {
              id: interaction.userId,
              username: interaction.username,
              name: interaction.name,
            },
            message: reactionMessage,
            callback: async () => [],
            reaction: {
              type: 'quote',
              entityId: createUniqueUuid(this.runtime, interaction.userId),
            },
            source: 'twitter',
          };
          this.runtime.emitEvent(TwitterEventTypes.QUOTE_RECEIVED, payload);
          break;
        }
      }

      // Also emit generic REACTION_RECEIVED event
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        entityId: createUniqueUuid(this.runtime, interaction.userId),
        roomId: createUniqueUuid(this.runtime, interaction.targetTweet.conversationId),
        world: createUniqueUuid(this.runtime, interaction.userId),
        message: reactionMessage,
        source: 'twitter',
        metadata: {
          type: interaction.type,
          targetTweetId: interaction.targetTweetId,
          username: interaction.username,
          userId: interaction.userId,
          timestamp: Date.now(),
          quoteText: interaction.type === 'quote' ? interaction.quoteTweet?.text || '' : undefined,
        },
        callback: async () => [],
      } as MessagePayload);
    }
  }

  /**
   * Creates a memory object for a given Twitter interaction.
   *
   * @param {string} type - The type of interaction (e.g., 'like', 'retweet', 'quote').
   * @param {string} id - The unique identifier for the interaction.
   * @param {string} userId - The ID of the user who initiated the interaction.
   * @param {string} conversationId - The ID of the conversation context.
   * @returns {TwitterInteractionMemory} The constructed memory object.
   */
  createMemoryObject(
    type: string,
    id: string,
    userId: string,
    conversationId: string
  ): TwitterInteractionMemory {
    return {
      id: createUniqueUuid(this.runtime, id),
      agentId: this.runtime.agentId,
      entityId: createUniqueUuid(this.runtime, userId),
      roomId: createUniqueUuid(this.runtime, conversationId),
      content: {
        type,
        source: 'twitter',
      },
      createdAt: Date.now(),
    };
  }

  /**
   * Asynchronously handles a tweet by generating a response and sending it.
   * This method processes the tweet content, determines if a response is needed,
   * generates appropriate response text, and sends the tweet reply.
   *
   * @param {object} params - The parameters object containing the tweet, message, and thread.
   * @param {Tweet} params.tweet - The tweet object to handle.
   * @param {Memory} params.message - The memory object associated with the tweet.
   * @param {Tweet[]} params.thread - The array of tweets in the thread.
   * @returns {object} - An object containing the text of the response and any relevant actions.
   */
  async handleTweet({
    tweet,
    message,
    thread,
  }: {
    tweet: ClientTweet;
    message: Memory;
    thread: ClientTweet[];
  }) {
    if (!message.content.text) {
      logger.log('Skipping Tweet with no text', tweet.id);
      return { text: '', actions: ['IGNORE'] };
    }

    // Create a callback for handling the response
    const callback: HandlerCallback = async (response: Content, tweetId?: string) => {
      try {
        if (!response.text) {
          logger.warn('No text content in response, skipping tweet reply');
          return [];
        }

        const tweetToReplyTo = tweetId || tweet.id;

        if (this.isDryRun) {
          logger.info(`[DRY RUN] Would have replied to ${tweet.username} with: ${response.text}`);
          return [];
        }

        logger.info(`Replying to tweet ${tweetToReplyTo}`);

        // Create the actual tweet using the Twitter API through the client
        const tweetResult = await sendTweet(this.client, response.text, [], tweetToReplyTo);

        if (!tweetResult) {
          throw new Error('Failed to get tweet result from response');
        }

        // Create memory for our response
        const responseId = createUniqueUuid(this.runtime, tweetResult.id);
        const responseMemory: Memory = {
          id: responseId,
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: message.roomId,
          content: {
            ...response,
            source: 'twitter',
            inReplyTo: message.id,
          },
          createdAt: Date.now(),
        };

        await createMemorySafe(this.runtime, responseMemory, 'messages');

        // Return the created memory
        return [responseMemory];
      } catch (error) {
        logger.error('Error in tweet reply callback:', error);
        return [];
      }
    };

    const twitterUserId = tweet.userId;
    const entityId = createUniqueUuid(this.runtime, twitterUserId);
    const twitterUsername = tweet.username;

    // Add Twitter-specific metadata to message
    message.metadata = {
      ...message.metadata,
      twitter: {
        entityId,
        twitterUserId,
        twitterUsername,
        thread: thread,
      },
    };

    // Process message through message service
    const result = await this.runtime.messageService!.handleMessage(
      this.runtime,
      message,
      callback
    );

    // Extract response for Twitter posting
    const response = result.responseMessages || [];

    // Check if response is an array of memories and extract the text
    let responseText = '';
    if (Array.isArray(response) && response.length > 0) {
      const firstResponse = response[0];
      if (firstResponse?.content?.text) {
        responseText = firstResponse.content.text;
      }
    }

    return {
      text: responseText,
      actions: responseText ? ['REPLY'] : ['IGNORE'],
    };
  }
}
