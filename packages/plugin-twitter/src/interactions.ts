import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
  ModelType,
  composePrompt,
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
  TwitterMentionReceivedPayload,
  TwitterQuoteReceivedPayload,
  TwitterRetweetReceivedPayload,
  TwitterUserFollowedPayload,
  TwitterUserUnfollowedPayload,
} from './types';
import { TwitterEventTypes } from './types';
import { sendTweet } from './utils';

/**
 * Template for generating dialog and actions for a Twitter message handler.
 *
 * @type {string}
 */
export const twitterMessageHandlerTemplate = `# Task: Generate dialog and actions for {{agentName}}.
{{providers}}
Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
{{imageDescriptions}}

# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "thought": "<string>", "name": "{{agentName}}", "text": "<string>", "action": "<string>" }
\`\`\`

The "action" field should be one of the options in [Available Actions] and the "text" field should be the response you want to send. Do not including any thinking or internal reflection in the "text" field. "thought" should be a short description of what the agent is thinking about before responding, inlcuding a brief justification for the response.`;

// Add conversion functions
const convertToCoreTweet = (tweet: ClientTweet): CoreTweet => ({
  id: tweet.id,
  text: tweet.text,
  conversationId: tweet.conversationId,
  timestamp: tweet.timestamp,
  userId: tweet.userId,
  username: tweet.username,
  name: tweet.name,
  inReplyToStatusId: tweet.inReplyToStatusId,
  permanentUrl: tweet.permanentUrl,
  photos: tweet.photos,
  hashtags: tweet.hashtags,
  mentions: tweet.mentions.map((mention) => mention.username),
  urls: tweet.urls,
  videos: tweet.videos,
  thread: tweet.thread,
});

const convertToCoreTweets = (tweets: ClientTweet[]): CoreTweet[] => tweets.map(convertToCoreTweet);

/**
 * Class representing a client for interacting with Twitter.
 */
export class TwitterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  private isDryRun: boolean;
  private state: any;
  /**
   * Constructor for setting up a new instance with the provided client, runtime, and state.
   * @param {ClientBase} client - The client being used for communication.
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   * @param {any} state - The initial state of the agent.
   */
  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.runtime = runtime;
    this.state = state;
    this.isDryRun =
      this.state?.TWITTER_DRY_RUN ||
      (this.runtime.getSetting('TWITTER_DRY_RUN') as unknown as boolean);
  }

  /**
   * Asynchronously starts the process of handling Twitter interactions on a loop.
   * Uses an interval based on the 'TWITTER_POLL_INTERVAL' setting, or defaults to 2 minutes if not set.
   */
  async start() {
    const handleTwitterInteractionsLoop = () => {
      // Defaults to 2 minutes
      const interactionInterval =
        (this.state?.TWITTER_POLL_INTERVAL ||
          (this.runtime.getSetting('TWITTER_POLL_INTERVAL') as unknown as number) ||
          120) * 1000;

      this.handleTwitterInteractions();
      setTimeout(handleTwitterInteractionsLoop, interactionInterval);
    };
    handleTwitterInteractionsLoop();
  }

  /**
   * Asynchronously handles Twitter interactions by checking for mentions, processing tweets, and updating the last checked tweet ID.
   */
  async handleTwitterInteractions() {
    logger.log('Checking Twitter interactions');

    const twitterUsername = this.client.profile?.username;
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
        await this.runtime.setCache(cursorKey, ''); // used to be null, but DB doesn't allow it
      }

      await this.processMentionTweets(mentionCandidates);

      // 2. Format mentions into interactions
      // TODO: EventType.REACTION_RECEIVED are not fully handled yet, re-enable once properly processed
      // const interactionCandidates = mentionCandidates
      //   .map((tweet) => this.client.formatTweetToInteraction?.(tweet))
      //   .filter((i) => i?.targetTweet?.conversationId);

      // for (const interaction of interactionCandidates) {
      //   try {
      //     await this.handleInteraction(interaction);
      //   } catch (error) {
      //     logger.erro(`Failed to process interaction ${interaction.id}`)
      //   }
      // }

      // For follower changes:
      // const processFollowerChange = async (
      //   change: { type: string; userId: string },
      //   profileId: string | undefined
      // ) => {
      //   if (change?.type && change?.userId && profileId) {
      //     const followerMemory = this.createMemoryObject(
      //       change.type,
      //       `${change.type}-${change.userId}`,
      //       change.userId,
      //       profileId
      //     );

      //     await this.runtime.createMemory(followerMemory, 'follower-changes');
      //   }
      // };

      // Save the latest checked tweet ID to the file
      await this.client.cacheLatestCheckedTweetId();

      logger.log('Finished checking Twitter interactions');
    } catch (error) {
      logger.error('Error handling Twitter interactions:', error);
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
    logger.log('Completed checking mentioned tweets:', mentionCandidates.length);
    let uniqueTweetCandidates = [...mentionCandidates];

    // Sort tweet candidates by ID in ascending order
    uniqueTweetCandidates = uniqueTweetCandidates
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((tweet) => tweet.userId !== this.client.profile.id);

    // for each tweet candidate, handle the tweet
    for (const tweet of uniqueTweetCandidates) {
      if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
        // Generate the tweetId UUID the same way it's done in handleTweet
        const tweetId = createUniqueUuid(this.runtime, tweet.id);

        // Check if we've already processed this tweet
        const existingResponse = await this.runtime.getMemoryById(tweetId);

        if (existingResponse) {
          logger.log(`Already responded to tweet ${tweet.id}, skipping`);
          continue;
        }
        logger.log('New Tweet found', tweet.permanentUrl);

        const entityId = createUniqueUuid(
          this.runtime,
          tweet.userId === this.client.profile.id ? this.runtime.agentId : tweet.userId
        );

        // Create standardized world and room IDs
        const worldId = createUniqueUuid(this.runtime, tweet.userId);
        const roomId = createUniqueUuid(this.runtime, tweet.conversationId);

        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: tweet.username,
          worldName: `${tweet.name}'s Twitter`,
          name: tweet.name,
          source: 'twitter',
          type: ChannelType.GROUP,
          channelId: tweet.conversationId,
          serverId: tweet.userId,
          worldId: worldId,
          metadata: {
            ownership: { ownerId: tweet.userId },
            twitter: {
              username: tweet.username,
              id: tweet.userId,
              name: tweet.name,
            },
          },
        });

        // Create standardized message memory
        const memory: Memory = {
          id: tweetId,
          agentId: this.runtime.agentId,
          content: {
            text: tweet.text,
            url: tweet.permanentUrl,
            imageUrls: tweet.photos?.map((photo) => photo.url) || [],
            inReplyTo: tweet.inReplyToStatusId
              ? createUniqueUuid(this.runtime, tweet.inReplyToStatusId)
              : undefined,
            source: 'twitter',
            channelType: ChannelType.GROUP,
            tweet,
          },
          entityId,
          roomId,
          createdAt: tweet.timestamp * 1000,
        };
        await this.runtime.createMemory(memory, 'messages');

        // Emit mention received events
        // TODO: Handle MENTION_RECEIVED event correctly before enabling again
        // if (tweet.text.includes(`@${twitterUsername}`)) {
        //   const messagePayload: MessagePayload = {
        //     runtime: this.runtime,
        //     message: {
        //       ...memory,
        //       source: 'twitter',
        //     } as TwitterMemory,
        //     source: 'twitter',
        //     callback: async (response) => {
        //       logger.info('Received message response:', response);
        //       return [];
        //     },
        //   };

        //   // Emit platform-specific MENTION_RECEIVED event
        //   const mentionPayload: TwitterMentionReceivedPayload = {
        //     runtime: this.runtime,
        //     message: {
        //       ...memory,
        //       source: 'twitter',
        //     } as TwitterMemory,
        //     tweet: convertToCoreTweet(tweet),
        //     user: {
        //       id: tweet.userId,
        //       username: tweet.username,
        //       name: tweet.name,
        //     },
        //     source: 'twitter',
        //     callback: async (response) => {
        //       logger.info('Received mention response:', response);
        //       return [];
        //     },
        //   };

        //   this.runtime.emitEvent(TwitterEventTypes.MENTION_RECEIVED, mentionPayload);
        // }

        // Handle thread events
        if (tweet.thread.length > 1) {
          const threadPayload = {
            runtime: this.runtime,
            tweets: convertToCoreTweets(tweet.thread),
            user: {
              id: tweet.userId,
              username: tweet.username,
              name: tweet.name,
            },
            source: 'twitter',
          };

          if (tweet.thread[tweet.thread.length - 1].id === tweet.id) {
            // This is a new tweet in an existing thread
            this.runtime.emitEvent(TwitterEventTypes.THREAD_UPDATED, {
              ...threadPayload,
              newTweet: convertToCoreTweet(tweet),
            });
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

      await this.runtime.createMemory(memory, 'messages');

      // Create message for reaction
      const reactionMessage: TwitterMemory = {
        id: createUniqueUuid(this.runtime, interaction.targetTweetId),
        content: {
          text: interaction.targetTweet.text,
          source: 'twitter',
        },
        entityId: createUniqueUuid(this.runtime, interaction.targetTweet.userId),
        roomId: createUniqueUuid(this.runtime, interaction.targetTweet.conversationId),
        agentId: this.runtime.agentId,
      };

      // Create base event payload
      const basePayload = {
        runtime: this.runtime,
        user: {
          id: interaction.userId,
          username: interaction.username,
          name: interaction.name,
        },
        source: 'twitter' as const,
      };

      // Emit platform-specific event
      switch (interaction.type) {
        case 'like': {
          const likePayload: TwitterLikeReceivedPayload = {
            ...basePayload,
            tweet: interaction.targetTweet as unknown as CoreTweet,
          };
          // Emit platform-specific event
          this.runtime.emitEvent(TwitterEventTypes.LIKE_RECEIVED, likePayload);

          // Emit generic REACTION_RECEIVED event
          this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
            ...basePayload,
            reaction: {
              type: 'like',
              entityId: createUniqueUuid(this.runtime, interaction.userId),
            },
            message: reactionMessage,
            callback: async () => {
              return [];
            },
          } as MessagePayload);
          break;
        }

        case 'retweet': {
          const retweetPayload: TwitterRetweetReceivedPayload = {
            ...basePayload,
            tweet: interaction.targetTweet as unknown as CoreTweet,
            retweetId: interaction.retweetId,
          };
          // Emit platform-specific event
          this.runtime.emitEvent(TwitterEventTypes.RETWEET_RECEIVED, retweetPayload);

          // Emit generic REACTION_RECEIVED event
          this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
            ...basePayload,
            reaction: {
              type: 'retweet',
              entityId: createUniqueUuid(this.runtime, interaction.userId),
            },
            message: reactionMessage,
            callback: async () => {
              return [];
            },
          } as MessagePayload);
          break;
        }

        case 'quote': {
          const quotePayload: TwitterQuoteReceivedPayload = {
            ...basePayload,
            message: reactionMessage,
            quotedTweet: interaction.targetTweet as unknown as CoreTweet,
            quoteTweet: (interaction.quoteTweet || interaction.targetTweet) as unknown as CoreTweet,
            callback: async () => [],
            reaction: {
              type: 'quote',
              entityId: createUniqueUuid(this.runtime, interaction.userId),
            },
          };
          // Emit platform-specific event
          this.runtime.emitEvent(TwitterEventTypes.QUOTE_RECEIVED, quotePayload);

          // Emit generic REACTION_RECEIVED event
          this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
            ...basePayload,
            reaction: {
              type: 'quote',
              entityId: createUniqueUuid(this.runtime, interaction.userId),
            },
            message: reactionMessage,
            callback: async () => {
              return [];
            },
          } as MessagePayload);
          break;
        }
      }
    }
  }

  /**
   * Handles a tweet by processing its content, formatting it, generating image descriptions,
   * saving the tweet if it doesn't already exist, determining if a response should be sent,
   * composing a response prompt, generating a response based on the prompt, handling the response
   * tweet, and saving information about the response.
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

    logger.log('Processing Tweet: ', tweet.id);
    const formatTweet = (tweet: ClientTweet) => {
      return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
    };
    const currentPost = formatTweet(tweet);

    const formattedConversation = thread
      .map(
        (tweet) => `@${tweet.username} (${new Date(tweet.timestamp * 1000).toLocaleString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          month: 'short',
          day: 'numeric',
        })}):
        ${tweet.text}`
      )
      .join('\n\n');

    const imageDescriptionsArray = [];
    try {
      for (const photo of tweet.photos) {
        const description = await this.runtime.useModel(ModelType.IMAGE_DESCRIPTION, photo.url);
        imageDescriptionsArray.push(description);
      }
    } catch (error) {
      // Handle the error
      logger.error('Error Occured during describing image: ', error);
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
        const responseId = createUniqueUuid(this.runtime, tweetResult.rest_id);
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

        // Save the response to memory
        await this.runtime.createMemory(responseMemory, 'messages');

        return [responseMemory];
      } catch (error) {
        logger.error('Error replying to tweet:', error);
        return [];
      }
    };

    // Emit standardized event for handling the message
    this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message,
      callback,
      source: 'twitter',
    } as MessagePayload);

    return { text: '', actions: ['RESPOND'] };
  }

  /**
   * Build a conversation thread based on a given tweet.
   *
   * @param {Tweet} tweet - The tweet to start the thread from.
   * @param {number} [maxReplies=10] - The maximum number of replies to include in the thread.
   * @returns {Promise<Tweet[]>} The conversation thread as an array of tweets.
   */
  async buildConversationThread(tweet: ClientTweet, maxReplies = 10): Promise<ClientTweet[]> {
    const thread: ClientTweet[] = [];
    const visited: Set<string> = new Set();

    async function processThread(currentTweet: ClientTweet, depth = 0) {
      logger.log('Processing tweet:', {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth: depth,
      });

      if (!currentTweet) {
        logger.log('No current tweet found for thread building');
        return;
      }

      if (depth >= maxReplies) {
        logger.log('Reached maximum reply depth', depth);
        return;
      }

      // Handle memory storage
      const memory = await this.runtime.getMemoryById(
        createUniqueUuid(this.runtime, currentTweet.id)
      );
      if (!memory) {
        const roomId = createUniqueUuid(this.runtime, tweet.conversationId);
        const entityId = createUniqueUuid(this.runtime, currentTweet.userId);

        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: currentTweet.username,
          name: currentTweet.name,
          source: 'twitter',
          type: ChannelType.GROUP,
          worldId: createUniqueUuid(this.runtime, currentTweet.userId),
          worldName: `${currentTweet.name}'s Twitter`,
        });

        this.runtime.createMemory(
          {
            id: createUniqueUuid(this.runtime, currentTweet.id),
            agentId: this.runtime.agentId,
            content: {
              text: currentTweet.text,
              source: 'twitter',
              url: currentTweet.permanentUrl,
              imageUrls: currentTweet.photos?.map((photo) => photo.url) || [],
              inReplyTo: currentTweet.inReplyToStatusId
                ? createUniqueUuid(this.runtime, currentTweet.inReplyToStatusId)
                : undefined,
            },
            createdAt: currentTweet.timestamp * 1000,
            roomId,
            entityId:
              currentTweet.userId === this.twitterUserId
                ? this.runtime.agentId
                : createUniqueUuid(this.runtime, currentTweet.userId),
          },
          'messages'
        );
      }

      if (visited.has(currentTweet.id)) {
        logger.log('Already visited tweet:', currentTweet.id);
        return;
      }

      visited.add(currentTweet.id);
      thread.unshift(currentTweet);

      if (currentTweet.inReplyToStatusId) {
        logger.log('Fetching parent tweet:', currentTweet.inReplyToStatusId);
        try {
          const parentTweet = await this.twitterClient.getTweet(currentTweet.inReplyToStatusId);

          if (parentTweet) {
            logger.log('Found parent tweet:', {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50),
            });
            await processThread(parentTweet, depth + 1);
          } else {
            logger.log('No parent tweet found for:', currentTweet.inReplyToStatusId);
          }
        } catch (error) {
          logger.log('Error fetching parent tweet:', {
            tweetId: currentTweet.inReplyToStatusId,
            error,
          });
        }
      } else {
        logger.log('Reached end of reply chain at:', currentTweet.id);
      }
    }

    // Need to bind this prompt for the inner function
    await processThread.bind(this)(tweet, 0);

    return thread;
  }

  private createMemoryObject(
    type: string,
    id: string,
    userId: string,
    roomId: string
  ): TwitterInteractionMemory {
    return {
      id: createUniqueUuid(this.runtime, id),
      agentId: this.runtime.agentId,
      entityId: createUniqueUuid(this.runtime, userId),
      roomId: createUniqueUuid(this.runtime, roomId),
      content: {
        type,
        source: 'twitter',
      },
      createdAt: Date.now(),
    };
  }
}
