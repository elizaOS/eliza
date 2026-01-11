import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { createTwitterAuthProvider, getTwitterAuthMode } from "./client/auth-providers/factory";
import { Client, type QueryTweetsResponse, SearchMode, type Tweet } from "./client/index";
import type { TwitterInteractionPayload } from "./types";
import { createMemorySafe } from "./utils/memory";
import { getSetting } from "./utils/settings";
import { getEpochMs } from "./utils/time";

/**
 * Extracts the answer from the given text.
 *
 * @param {string} text - The text containing the answer
 * @returns {string} The extracted answer
 */
export function extractAnswer(text: string): string {
  const startIndex = text.indexOf("Answer: ") + 8;
  const endIndex = text.indexOf("<|endoftext|>", 11);
  return text.slice(startIndex, endIndex);
}

/**
 * Represents a Twitter Profile.
 * @typedef {Object} TwitterProfile
 * @property {string} id - The unique identifier of the profile.
 * @property {string} username - The username of the profile.
 * @property {string} screenName - The screen name of the profile.
 * @property {string} bio - The biography of the profile.
 * @property {string[]} nicknames - An array of nicknames associated with the profile.
 */
type TwitterProfile = {
  id: string;
  username: string;
  screenName: string;
  bio: string;
  nicknames: string[];
};

/**
 * Class representing a request queue for handling asynchronous requests in a controlled manner.
 */

class RequestQueue {
  private queue: (() => Promise<unknown>)[] = [];
  private processing = false;
  private maxRetries = 3;
  private retryAttempts = new Map<() => Promise<unknown>, number>();

  /**
   * Asynchronously adds a request to the queue, then processes the queue.
   *
   * @template T
   * @param {() => Promise<T>} request - The request to be added to the queue
   * @returns {Promise<T>} - A promise that resolves with the result of the request or rejects with an error
   */
  async add<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  /**
   * Asynchronously processes the queue of requests.
   *
   * @returns A promise that resolves when the queue has been fully processed.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) continue;
      try {
        await request();
        // Clear retry count on success
        this.retryAttempts.delete(request);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Error processing request:", errorMsg);

        const retryCount = (this.retryAttempts.get(request) || 0) + 1;

        if (retryCount < this.maxRetries) {
          this.retryAttempts.set(request, retryCount);
          this.queue.unshift(request);
          await this.exponentialBackoff(retryCount);
          // Break the loop to allow exponential backoff to take effect
          break;
        } else {
          logger.error(`Max retries (${this.maxRetries}) exceeded for request, skipping`);
          this.retryAttempts.delete(request);
        }
      }
      await this.randomDelay();
    }

    this.processing = false;

    // If there are still items in the queue, restart processing
    if (this.queue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Implements an exponential backoff strategy for retrying a task.
   * @param {number} retryCount - The number of retries attempted so far.
   * @returns {Promise<void>} - A promise that resolves after a delay based on the retry count.
   */
  private async exponentialBackoff(retryCount: number): Promise<void> {
    const delay = 2 ** retryCount * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Asynchronous method that creates a random delay between 1500ms and 3500ms.
   *
   * @returns A Promise that resolves after the random delay has passed.
   */
  private async randomDelay(): Promise<void> {
    const delay = Math.floor(Math.random() * 2000) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Class representing a base client for interacting with Twitter.
 * @extends EventEmitter
 */
export class ClientBase {
  static _twitterClients: { [accountIdentifier: string]: Client } = {};
  twitterClient: Client;
  runtime: IAgentRuntime;
  lastCheckedTweetId: bigint | null = null;
  temperature = 0.5;

  requestQueue: RequestQueue = new RequestQueue();

  profile: TwitterProfile | null = null;

  /**
   * Caches a tweet in the database.
   *
   * @param {Tweet} tweet - The tweet to cache.
   * @returns {Promise<void>} A promise that resolves once the tweet is cached.
   */
  async cacheTweet(tweet: Tweet): Promise<void> {
    if (!tweet) {
      logger.warn("Tweet is undefined, skipping cache");
      return;
    }

    this.runtime.setCache<Tweet>(`twitter/tweets/${tweet.id}`, tweet);
  }

  /**
   * Retrieves a cached tweet by its ID.
   * @param {string} tweetId - The ID of the tweet to retrieve from the cache.
   * @returns {Promise<Tweet | undefined>} A Promise that resolves to the cached tweet, or undefined if the tweet is not found in the cache.
   */
  async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
    const cached = await this.runtime.getCache<Tweet>(`twitter/tweets/${tweetId}`);

    if (!cached) {
      return undefined;
    }

    return cached;
  }

  /**
   * Asynchronously retrieves a tweet with the specified ID.
   * If the tweet is found in the cache, it is returned from the cache.
   * If not, a request is made to the Twitter API to get the tweet, which is then cached and returned.
   * @param {string} tweetId - The ID of the tweet to retrieve.
   * @returns {Promise<Tweet>} A Promise that resolves to the retrieved tweet.
   */
  async getTweet(tweetId: string): Promise<Tweet> {
    const cachedTweet = await this.getCachedTweet(tweetId);

    if (cachedTweet) {
      return cachedTweet;
    }

    const tweet = await this.requestQueue.add(() => this.twitterClient.getTweet(tweetId));

    if (!tweet) {
      throw new Error(`Tweet ${tweetId} not found`);
    }

    await this.cacheTweet(tweet);
    return tweet as Tweet;
  }

  callback: ((self: ClientBase) => void) | null = null;

  /**
   * This method is called when the application is ready.
   * It throws an error indicating that it is not implemented in the base class
   * and should be implemented in the subclass.
   */
  onReady() {
    throw new Error("Not implemented in base class, please call from subclass");
  }

  /**
   * Parse the raw tweet data into a standardized Tweet object.
   */
  /**
   * Parses a raw tweet object into a structured Tweet object.
   *
   * @param {any} raw - The raw tweet object to parse.
   * @param {number} [depth=0] - The current depth of parsing nested quotes/retweets.
   * @param {number} [maxDepth=3] - The maximum depth allowed for parsing nested quotes/retweets.
   * @returns {Tweet} The parsed Tweet object.
   */

  state: Record<string, unknown>;

  constructor(runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.runtime = runtime;
    this.state = state;

    // Use a stable identifier for client reuse per auth mode.
    const mode = getTwitterAuthMode(runtime, state);
    const reuseKey =
      mode === "env"
        ? typeof state?.TWITTER_API_KEY === "string"
          ? state.TWITTER_API_KEY
          : getSetting(runtime, "TWITTER_API_KEY")
        : mode === "oauth"
          ? typeof state?.TWITTER_CLIENT_ID === "string"
            ? state.TWITTER_CLIENT_ID
            : getSetting(runtime, "TWITTER_CLIENT_ID")
          : typeof state?.TWITTER_BROKER_URL === "string"
            ? state.TWITTER_BROKER_URL
            : getSetting(runtime, "TWITTER_BROKER_URL");

    if (typeof reuseKey === "string" && reuseKey && ClientBase._twitterClients[reuseKey]) {
      this.twitterClient = ClientBase._twitterClients[reuseKey];
    } else {
      this.twitterClient = new Client();
      if (typeof reuseKey === "string" && reuseKey) {
        ClientBase._twitterClients[reuseKey] = this.twitterClient;
      }
    }
  }

  async init() {
    // First ensure the agent exists in the database
    // await this.runtime.ensureAgentExists(this.runtime.character);

    const provider = createTwitterAuthProvider(this.runtime, this.state);

    const maxRetries = process.env.MAX_RETRIES ? Number.parseInt(process.env.MAX_RETRIES, 10) : 3;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.log("Initializing Twitter API v2 client");
        await this.twitterClient.authenticate(provider);

        if (await this.twitterClient.isLoggedIn()) {
          logger.info("Successfully authenticated with Twitter API v2");
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Authentication attempt ${retryCount + 1} failed: ${lastError.message}`);
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000; // Exponential backoff
          logger.info(`Retrying in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (retryCount >= maxRetries) {
      throw new Error(
        `Twitter authentication failed after ${maxRetries} attempts. Last error: ${lastError?.message}`
      );
    }

    // Initialize Twitter profile from the authenticated user
    const profile = await this.twitterClient.me();
    if (profile) {
      logger.log("Twitter user ID:", profile.userId);
      logger.log("Twitter loaded:", JSON.stringify(profile, null, 10));

      const agentId = this.runtime.agentId;

      const entity = await this.runtime.getEntityById(agentId);
      const entityMetadata = entity?.metadata;
      const twitterMetadata = entityMetadata?.twitter as
        | { userName?: string; name?: string }
        | undefined;
      if (twitterMetadata?.userName !== profile.username) {
        logger.log(
          "Updating Agents known X/twitter handle",
          profile.username,
          "was",
          entityMetadata?.twitter
        );
        const names = [profile.name, profile.username].filter((n): n is string => !!n);
        if (!entity) {
          throw new Error("Entity not found");
        }
        await this.runtime.updateEntity({
          id: agentId,
          names: [...new Set([...(entity.names || []), ...names])],
          metadata: {
            ...(entityMetadata || {}),
            twitter: {
              ...(twitterMetadata || {}),
              name: profile.name,
              userName: profile.username,
            },
          },
          agentId,
        });
      }

      // Store profile info for use in responses
      if (!profile.userId || !profile.username || !profile.name) {
        throw new Error("Profile missing required fields");
      }
      this.profile = {
        id: profile.userId,
        username: profile.username, // this is the at
        screenName: profile.name, // this is the human readable name
        bio: profile.biography || "",
        nicknames: [],
      };
    } else {
      throw new Error("Failed to load profile");
    }

    await this.loadLatestCheckedTweetId();
    await this.populateTimeline();
  }

  async fetchOwnPosts(count: number): Promise<Tweet[]> {
    logger.debug("fetching own posts");
    if (!this.profile?.id) {
      throw new Error("Profile not initialized");
    }
    const homeTimeline = await this.twitterClient.getUserTweets(this.profile.id, count);
    // homeTimeline.tweets already contains Tweet objects from v2 API, no parsing needed
    return homeTimeline.tweets;
  }

  /**
   * Fetch timeline for twitter account, optionally only from followed accounts
   */
  async fetchHomeTimeline(count: number, following?: boolean): Promise<Tweet[]> {
    logger.debug("fetching home timeline");
    const homeTimeline = following
      ? await this.twitterClient.fetchFollowingTimeline(count, [])
      : await this.twitterClient.fetchHomeTimeline(count, []);

    // homeTimeline already contains Tweet objects from v2 API, no parsing needed
    return homeTimeline;
  }

  async fetchSearchTweets(
    query: string,
    maxTweets: number,
    searchMode: SearchMode,
    cursor?: string
  ): Promise<QueryTweetsResponse> {
    // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
    // if we dont get a response in 5 seconds, something is wrong
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ tweets: [] }), 15000)
    );

    const result = await this.requestQueue.add(
      async () =>
        await Promise.race([
          this.twitterClient.fetchSearchTweets(query, maxTweets, searchMode, cursor),
          timeoutPromise,
        ])
    );
    return (result ?? { tweets: [] }) as QueryTweetsResponse;
  }

  private async populateTimeline() {
    logger.debug("populating timeline...");

    const cachedTimeline = await this.getCachedTimeline();

    // Check if the cache file exists
    if (cachedTimeline) {
      // Read the cached search results from the file

      // Get the existing memories from the database
      const existingMemories = await this.runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds: cachedTimeline
          .map((tweet) => tweet.conversationId)
          .filter((id): id is string => !!id)
          .map((id) => createUniqueUuid(this.runtime, id as string)),
      });

      //TODO: load tweets not in cache?

      // Create a Set to store the IDs of existing memories
      const existingMemoryIds = new Set(
        existingMemories.map((memory) => memory.id?.toString()).filter((id): id is string => !!id)
      );

      // Check if any of the cached tweets exist in the existing memories
      const someCachedTweetsExist = cachedTimeline.some((tweet) =>
        tweet.id ? existingMemoryIds.has(createUniqueUuid(this.runtime, tweet.id as string)) : false
      );

      if (someCachedTweetsExist) {
        // Filter out the cached tweets that already exist in the database
        const tweetsToSave = cachedTimeline.filter(
          (tweet) =>
            tweet.userId &&
            tweet.id &&
            tweet.userId !== this.profile?.id &&
            !existingMemoryIds.has(createUniqueUuid(this.runtime, tweet.id as string))
        );

        // Save the missing tweets as memories
        for (const tweet of tweetsToSave) {
          if (!tweet.id || !tweet.userId || !tweet.conversationId || !tweet.username) {
            logger.warn("Skipping tweet with missing required fields");
            continue;
          }

          logger.log("Saving Tweet", tweet.id);

          if (tweet.userId === this.profile?.id) {
            continue;
          }

          // Create a world for this Twitter user if it doesn't exist
          const worldId = createUniqueUuid(this.runtime, tweet.userId) as UUID;
          await this.runtime.ensureWorldExists({
            id: worldId,
            name: `${tweet.username}'s Twitter`,
            agentId: this.runtime.agentId,
            serverId: createUniqueUuid(this.runtime, tweet.userId) as UUID,
            metadata: {
              ownership: { ownerId: tweet.userId },
              twitter: {
                username: tweet.username,
                id: tweet.userId,
              },
            },
          });

          const roomId = createUniqueUuid(this.runtime, tweet.conversationId as string);
          const entityId =
            tweet.userId === this.profile?.id
              ? this.runtime.agentId
              : createUniqueUuid(this.runtime, tweet.userId as string);

          // Ensure the entity exists with proper world association
          await this.runtime.ensureConnection({
            entityId,
            roomId,
            userName: tweet.username as string,
            name: (tweet.name || tweet.username) as string,
            source: "twitter",
            type: ChannelType.FEED,
            worldId: worldId,
          });

          const content = {
            text: tweet.text || "",
            url: tweet.permanentUrl,
            source: "twitter",
            inReplyTo: tweet.inReplyToStatusId
              ? createUniqueUuid(this.runtime, tweet.inReplyToStatusId as string)
              : undefined,
          } as Content;

          await this.runtime.createMemory(
            {
              id: createUniqueUuid(this.runtime, tweet.id as string),
              entityId,
              content: content,
              agentId: this.runtime.agentId,
              roomId,
              createdAt: getEpochMs(tweet.timestamp),
            },
            "messages"
          );

          await this.cacheTweet(tweet);
        }

        logger.log(`Populated ${tweetsToSave.length} missing tweets from the cache.`);
        return;
      }
    }

    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);

    // Get the most recent 20 mentions and interactions
    if (!this.profile?.username) {
      logger.warn("Profile username not available, skipping mentions fetch");
      return;
    }

    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${this.profile.username}`,
      20,
      SearchMode.Latest
    );

    // Combine the timeline tweets and mentions/interactions
    const allTweets = [...timeline, ...mentionsAndInteractions.tweets];

    // Create a Set to store unique tweet IDs
    const tweetIdsToCheck = new Set<string>();
    const roomIds = new Set<UUID>();

    // Add tweet IDs to the Set
    for (const tweet of allTweets) {
      if (!tweet.id || !tweet.conversationId) {
        continue;
      }
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(createUniqueUuid(this.runtime, tweet.conversationId));
    }

    // Check the existing memories in the database
    const existingMemories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: Array.from(roomIds),
    });

    // Create a Set to store the existing memory IDs
    const existingMemoryIds = new Set<UUID>(
      existingMemories.map((memory) => memory.id).filter((id): id is UUID => !!id)
    );

    // Filter out the tweets that already exist in the database
    const tweetsToSave = allTweets.filter(
      (tweet) =>
        tweet.userId &&
        tweet.id &&
        tweet.userId !== this.profile?.id &&
        !existingMemoryIds.has(createUniqueUuid(this.runtime, tweet.id))
    );

    logger.debug({
      processingTweets: tweetsToSave
        .map((tweet) => tweet.id)
        .filter(Boolean)
        .join(","),
    });

    // Save the new tweets as memories
    for (const tweet of tweetsToSave) {
      if (!tweet.id || !tweet.userId || !tweet.conversationId || !tweet.username) {
        logger.warn("Skipping tweet with missing required fields");
        continue;
      }

      logger.log("Saving Tweet", tweet.id);

      if (tweet.userId === this.profile?.id) {
        continue;
      }

      // Create a world for this Twitter user if it doesn't exist
      const worldId = createUniqueUuid(this.runtime, tweet.userId) as UUID;
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `${tweet.username}'s Twitter`,
        agentId: this.runtime.agentId,
        serverId: createUniqueUuid(this.runtime, tweet.userId) as UUID,
        metadata: {
          ownership: { ownerId: tweet.userId },
          twitter: {
            username: tweet.username,
            id: tweet.userId,
          },
        },
      });

      const roomId = createUniqueUuid(this.runtime, tweet.conversationId);

      const entityId =
        tweet.userId === this.profile?.id
          ? this.runtime.agentId
          : createUniqueUuid(this.runtime, tweet.userId);

      // Ensure the entity exists with proper world association
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: tweet.username,
        name: tweet.name,
        source: "twitter",
        type: ChannelType.FEED,
        worldId: worldId,
      });

      const content = {
        text: tweet.text || "",
        url: tweet.permanentUrl,
        source: "twitter",
        inReplyTo: tweet.inReplyToStatusId
          ? createUniqueUuid(this.runtime, tweet.inReplyToStatusId)
          : undefined,
      } as Content;

      await createMemorySafe(
        this.runtime,
        {
          id: createUniqueUuid(this.runtime, tweet.id),
          entityId,
          content: content,
          agentId: this.runtime.agentId,
          roomId,
          createdAt: getEpochMs(tweet.timestamp),
        },
        "messages"
      );

      await this.cacheTweet(tweet);
    }

    // Cache
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.tweets);
  }

  async saveRequestMessage(message: Memory, state: State) {
    if (message.content.text) {
      const recentMessage = await this.runtime.getMemories({
        tableName: "messages",
        roomId: message.roomId,
        count: 1,
        unique: false,
      });

      if (recentMessage.length > 0 && recentMessage[0].content === message.content) {
        logger.debug("Message already saved", recentMessage[0].id);
      } else {
        await createMemorySafe(this.runtime, message, "messages");
      }

      await this.runtime.evaluate(message, {
        ...state,
        twitterClient: this.twitterClient,
      });
    }
  }

  async loadLatestCheckedTweetId(): Promise<void> {
    if (!this.profile?.username) {
      return;
    }
    const latestCheckedTweetId = await this.runtime.getCache<string>(
      `twitter/${this.profile.username}/latest_checked_tweet_id`
    );

    if (latestCheckedTweetId) {
      this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
    }
  }

  async cacheLatestCheckedTweetId() {
    if (this.lastCheckedTweetId && this.profile?.username) {
      await this.runtime.setCache<string>(
        `twitter/${this.profile.username}/latest_checked_tweet_id`,
        this.lastCheckedTweetId.toString()
      );
    }
  }

  async getCachedTimeline(): Promise<Tweet[] | undefined> {
    if (!this.profile?.username) {
      return undefined;
    }
    const cached = await this.runtime.getCache<Tweet[]>(
      `twitter/${this.profile.username}/timeline`
    );

    if (!cached) {
      return undefined;
    }

    return cached;
  }

  async cacheTimeline(timeline: Tweet[]) {
    if (!this.profile?.username) {
      return;
    }
    await this.runtime.setCache<Tweet[]>(`twitter/${this.profile.username}/timeline`, timeline);
  }

  async cacheMentions(mentions: Tweet[]) {
    if (!this.profile?.username) {
      return;
    }
    await this.runtime.setCache<Tweet[]>(`twitter/${this.profile.username}/mentions`, mentions);
  }

  async fetchProfile(username: string): Promise<TwitterProfile> {
    const profile = await this.requestQueue.add(async () => {
      const profile = await this.twitterClient.getProfile(username);

      // Handle case where runtime.character might be undefined
      const defaultName = "AI Assistant";
      const defaultBio = "";

      let characterName = defaultName;
      let characterBio = defaultBio;

      if (this.runtime?.character) {
        characterName = this.runtime.character.name || defaultName;

        if (typeof this.runtime.character.bio === "string") {
          characterBio = this.runtime.character.bio;
        } else if (
          Array.isArray(this.runtime.character.bio) &&
          this.runtime.character.bio.length > 0
        ) {
          characterBio = this.runtime.character.bio[0];
        }
      }

      if (!profile.userId) {
        throw new Error("Profile missing userId");
      }
      return {
        id: profile.userId,
        username: username || "",
        screenName: profile.name || characterName || "",
        bio: profile.biography || characterBio || "",
        nicknames: this.profile?.nicknames || [],
      } satisfies TwitterProfile;
    });

    return profile;
  }

  /**
   * Fetches recent interactions (likes, retweets, quotes) for the authenticated user's tweets
   */
  async fetchInteractions() {
    if (!this.profile?.username) {
      return [];
    }
    const username = this.profile.username;
    // Use fetchSearchTweets to get mentions instead of the non-existent get method
    const mentionsResponse = await this.requestQueue.add(() =>
      this.twitterClient.fetchSearchTweets(`@${username}`, 100, SearchMode.Latest)
    );

    // Process tweets directly into the expected interaction format
    return mentionsResponse.tweets.map((tweet: Tweet) => this.formatTweetToInteraction(tweet));
  }

  formatTweetToInteraction(tweet: Tweet): TwitterInteractionPayload | null {
    if (!tweet) return null;

    const isQuote = tweet.isQuoted;
    const isRetweet = !!tweet.retweetedStatus;
    const type: "quote" | "retweet" | "like" = isQuote ? "quote" : isRetweet ? "retweet" : "like";

    if (!tweet.id || !tweet.userId || !tweet.username) {
      return null;
    }

    return {
      id: tweet.id,
      type,
      userId: tweet.userId,
      username: tweet.username,
      name: tweet.name || tweet.username,
      targetTweetId: tweet.inReplyToStatusId || tweet.quotedStatusId || undefined,
      targetTweet: tweet.quotedStatus || tweet,
      quoteTweet: isQuote ? tweet : undefined,
      retweetId: tweet.retweetedStatus?.id,
    };
  }
}
