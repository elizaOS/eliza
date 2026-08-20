/**
 * Per-account X transport core shared by autonomous loops and connector handlers.
 * It authenticates through the selected provider, keeps the public compatibility
 * profile synchronized with the credential-aware client, and owns timeline state.
 *
 * On `init` it also seeds the runtime with `FEED` rooms and message memories for
 * recent timeline + mention tweets, and tracks the last-checked tweet id (via the
 * runtime cache) so loops don't re-process the same tweet. `RequestQueue` serializes
 * API calls with retry + exponential backoff; `extractAnswer` and `TwitterProfile`
 * are shared primitives the loops build on.
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import type { TwitterApi } from "twitter-api-v2";
import {
  resolveRequestedXAccountId,
  resolveTwitterAccountConfig,
} from "./client/accounts";
import { createTwitterAuthProvider } from "./client/auth-providers/factory";
import {
  Client,
  type QueryTweetsResponse,
  SearchMode,
  type Tweet,
} from "./client/index";
import {
  convertClientTweetToCoreTweet,
  type TwitterClientState,
  type TwitterInteractionPayload,
} from "./types";
import {
  buildTwitterMessageMetadata,
  createMemorySafe,
  reconcileTwitterWorld,
} from "./utils/memory";
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
export type TwitterProfile = {
  id: string;
  username: string;
  screenName: string;
  bio: string;
  nicknames: string[];
};

export type TwitterAccountSession = {
  client: TwitterApi;
  profile: TwitterProfile;
  revision: number;
};

/**
 * Resolves the agent's known nicknames/aliases for its X account.
 *
 * Sources, in order:
 *  - the `TWITTER_NICKNAMES` setting (comma-separated),
 *  - the runtime character `name`,
 * excluding values that simply duplicate the `@username` or screen name.
 */
function resolveAgentNicknames(
  runtime: IAgentRuntime,
  identity: { username: string; screenName: string },
): string[] {
  const reserved = new Set(
    [identity.username, identity.screenName]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );

  const candidates = [
    ...(getSetting(runtime, "TWITTER_NICKNAMES") ?? "").split(","),
    runtime.character?.name ?? "",
  ];

  const nicknames: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (reserved.has(key) || seen.has(key)) continue;
    seen.add(key);
    nicknames.push(trimmed);
  }
  return nicknames;
}

type TweetWithIdentity = Tweet & {
  id: string;
  userId: string;
  username: string;
};

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_MAX_AUTH_RETRIES = 3;

/**
 * Resolve the authentication retry budget from MAX_RETRIES. The budget feeds
 * both `retryCount < maxRetries` and the `retryCount >= maxRetries` failure
 * guard, and NaN is false in both — a non-numeric value would skip the
 * authenticate loop AND its failure throw, letting init() continue
 * unauthenticated. Surrounding environment whitespace is ignored, but any
 * token that is not a canonical positive safe integer falls back to the
 * default so authentication always gets at least one attempt.
 */
export function resolveMaxAuthRetries(raw: string | undefined): number {
  const normalized = raw?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(normalized)) return DEFAULT_MAX_AUTH_RETRIES;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_MAX_AUTH_RETRIES;
}

/**
 * Class representing a request queue for handling asynchronous requests in a controlled manner.
 */

type QueuedRequest = () => Promise<unknown>;

class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private maxRetries = 3;
  private retryAttempts = new Map<QueuedRequest, number>();

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
      if (!request) break;
      try {
        await request();
        // Clear retry count on success
        this.retryAttempts.delete(request);
      } catch (error) {
        logger.error("Error processing request:", errorDetail(error));

        const retryCount = (this.retryAttempts.get(request) || 0) + 1;

        if (retryCount < this.maxRetries) {
          this.retryAttempts.set(request, retryCount);
          this.queue.unshift(request);
          await this.exponentialBackoff(retryCount);
          // Break the loop to allow exponential backoff to take effect
          break;
        } else {
          logger.error(
            `Max retries (${this.maxRetries}) exceeded for request, skipping`,
          );
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
  twitterClient: Client;
  runtime: IAgentRuntime;
  /**
   * Connector account this client represents. Used to stamp Memory.metadata
   * and routing context for inbound X traffic. Defaults to "default" when the
   * plugin is running in single-account mode; resolved from the connector
   * account manager via {@link resolveRequestedXAccountId} otherwise.
   */
  accountId = "default";
  lastCheckedTweetId: bigint | null = null;
  private lastCheckedTweetProfileId: string | null = null;
  temperature = 0.5;

  requestQueue: RequestQueue = new RequestQueue();

  private synchronizedProfile: TwitterProfile | null = null;
  private synchronizedProfileSession: Pick<
    TwitterAccountSession,
    "client" | "revision"
  > | null = null;
  private readonly publishLegacyIdentity: boolean;
  private readonly legacyCacheUsernames = new Map<string, string>();
  private latestCursorWrite: Promise<void> = Promise.resolve();

  get profile(): TwitterProfile | null {
    if (!this.synchronizedProfile || !this.synchronizedProfileSession) {
      return this.synchronizedProfile;
    }
    return this.twitterClient.isAuthenticatedSessionCurrent(
      this.synchronizedProfileSession,
    )
      ? this.synchronizedProfile
      : null;
  }

  set profile(profile: TwitterProfile | null) {
    this.synchronizedProfile = profile;
    this.synchronizedProfileSession = null;
  }

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

    await this.runtime.setCache<Tweet>(`twitter/tweets/${tweet.id}`, tweet);
  }

  /**
   * Retrieves a cached tweet by its ID.
   * @param {string} tweetId - The ID of the tweet to retrieve from the cache.
   * @returns {Promise<Tweet | undefined>} A Promise that resolves to the cached tweet, or undefined if the tweet is not found in the cache.
   */
  async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
    const cached = await this.runtime.getCache<Tweet>(
      `twitter/tweets/${tweetId}`,
    );

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

    const tweet = await this.requestQueue.add(() =>
      this.twitterClient.getTweet(tweetId),
    );

    if (!tweet) {
      throw new Error(`Tweet ${tweetId} not found`);
    }

    await this.cacheTweet(tweet);
    return tweet;
  }

  callback: ((self: ClientBase) => void | Promise<void>) | null = null;

  /**
   * This method is called when the application is ready.
   * It throws an error indicating that subclasses must override it.
   */
  onReady() {
    throw new Error("ClientBase.onReady must be implemented by a subclass");
  }

  state: TwitterClientState;

  constructor(
    runtime: IAgentRuntime,
    state: TwitterClientState,
    options: { publishLegacyIdentity?: boolean } = {},
  ) {
    this.runtime = runtime;
    this.state = state;
    this.accountId = resolveRequestedXAccountId(
      runtime,
      state,
      state.accountId,
    );
    this.publishLegacyIdentity = options.publishLegacyIdentity ?? true;
    this.twitterClient = new Client();
  }

  identityCacheKey(profile: TwitterProfile, suffix: string): string {
    return `twitter/${encodeURIComponent(this.accountId)}/${profile.id}/${suffix}`;
  }

  async getIdentityCache<T>(
    profile: TwitterProfile,
    suffix: string,
  ): Promise<T | undefined> {
    const key = this.identityCacheKey(profile, suffix);
    const current = await this.runtime.getCache<T>(key);
    const legacyUsername = this.legacyCacheUsernames.get(profile.id);
    if (current !== undefined || !legacyUsername) {
      return current;
    }
    const legacy = await this.runtime.getCache<T>(
      `twitter/${legacyUsername}/${suffix}`,
    );
    if (legacy !== undefined) {
      await this.runtime.setCache(key, legacy);
    }
    return legacy;
  }

  async setIdentityCache<T>(
    profile: TwitterProfile,
    suffix: string,
    value: T,
    session?: TwitterAccountSession,
  ): Promise<void> {
    if (session && !this.isAuthenticatedSessionCurrent(session)) {
      throw new ElizaError("X credentials rotated before cache persistence", {
        code: "X_AUTH_SESSION_ROTATED",
      });
    }
    await this.runtime.setCache(this.identityCacheKey(profile, suffix), value);
    if (session && !this.isAuthenticatedSessionCurrent(session)) {
      throw new ElizaError("X credentials rotated during cache persistence", {
        code: "X_AUTH_SESSION_ROTATED",
      });
    }
  }

  private async synchronizeAuthenticatedSession(
    session: Awaited<ReturnType<Client["getAuthenticatedSession"]>>,
  ): Promise<TwitterAccountSession> {
    const profile = session.profile;
    if (!profile.userId || !profile.username) {
      throw new ElizaError(
        "Authenticated Twitter profile is missing id or username",
        { code: "X_PROFILE_INVALID" },
      );
    }

    const nextProfile: TwitterProfile = {
      id: profile.userId,
      username: profile.username,
      screenName: profile.name ?? profile.username,
      bio: profile.biography || "",
      nicknames: resolveAgentNicknames(this.runtime, {
        username: profile.username,
        screenName: profile.name ?? profile.username,
      }),
    };
    const identityChanged =
      this.profile?.id !== nextProfile.id ||
      this.profile.username !== nextProfile.username ||
      this.profile.screenName !== nextProfile.screenName;
    if (identityChanged) {
      this.profile = null;
    }
    if (this.lastCheckedTweetProfileId !== nextProfile.id) {
      this.lastCheckedTweetId = null;
      this.lastCheckedTweetProfileId = nextProfile.id;
    }

    const entity = this.publishLegacyIdentity
      ? await this.runtime.getEntityById(this.runtime.agentId)
      : null;
    const entityMetadata = entity?.metadata as
      | {
          twitter?: {
            id?: string;
            userName?: string;
            name?: string;
            [k: string]: unknown;
          };
          [k: string]: unknown;
        }
      | undefined;
    const storedIdentity = entityMetadata?.twitter;
    if (this.publishLegacyIdentity && storedIdentity?.id === nextProfile.id) {
      this.legacyCacheUsernames.set(
        nextProfile.id,
        storedIdentity.userName ?? nextProfile.username,
      );
    }
    if (
      this.publishLegacyIdentity &&
      (storedIdentity?.id !== nextProfile.id ||
        storedIdentity?.userName !== nextProfile.username ||
        storedIdentity?.name !== nextProfile.screenName)
    ) {
      const priorXNames = new Set(
        [storedIdentity?.userName, storedIdentity?.name]
          .filter((name): name is string => Boolean(name))
          .map((name) => name.toLowerCase()),
      );
      const canonicalCharacterNames = new Set(
        [this.runtime.character?.name]
          .filter((name): name is string => Boolean(name))
          .map((name) => name.toLowerCase()),
      );
      const retainedNames = (entity?.names || []).filter(
        (name) =>
          !priorXNames.has(name.toLowerCase()) ||
          canonicalCharacterNames.has(name.toLowerCase()),
      );
      const currentXNames = [nextProfile.screenName, nextProfile.username];
      await this.runtime.updateEntity({
        id: this.runtime.agentId,
        names: [...new Set([...retainedNames, ...currentXNames])],
        metadata: {
          ...(entityMetadata || {}),
          twitter: {
            ...(storedIdentity || {}),
            id: nextProfile.id,
            name: nextProfile.screenName,
            userName: nextProfile.username,
          },
        },
        agentId: this.runtime.agentId,
      });
    }

    if (identityChanged) {
      const latestCheckedTweetId = await this.getIdentityCache<string>(
        nextProfile,
        "latest_checked_tweet_id",
      );
      this.lastCheckedTweetProfileId = nextProfile.id;
      this.lastCheckedTweetId = latestCheckedTweetId
        ? BigInt(latestCheckedTweetId)
        : null;
    }
    this.synchronizedProfile = nextProfile;
    this.synchronizedProfileSession = {
      client: session.client,
      revision: session.revision,
    };
    return {
      client: session.client,
      profile: nextProfile,
      revision: session.revision,
    };
  }

  async withAuthenticatedSession<T>(
    operation: (session: TwitterAccountSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.twitterClient.withAuthenticatedSession(
        async (session) => {
          const synchronized = await this.twitterClient.withCurrentSession(
            session,
            () => this.synchronizeAuthenticatedSession(session),
          );
          return operation(synchronized);
        },
      );
    } catch (error) {
      this.synchronizedProfile = null;
      this.synchronizedProfileSession = null;
      throw error;
    }
  }

  async getAuthenticatedSession(): Promise<TwitterAccountSession> {
    return this.withAuthenticatedSession(async (session) => session);
  }

  isAuthenticatedSessionCurrent(session: TwitterAccountSession): boolean {
    return this.twitterClient.isAuthenticatedSessionCurrent(session);
  }

  async getAuthenticatedProfile(): Promise<TwitterProfile> {
    return (await this.getAuthenticatedSession()).profile;
  }

  private hasTweetIdentity(tweet: Tweet): tweet is TweetWithIdentity {
    return (
      typeof tweet.id === "string" &&
      typeof tweet.userId === "string" &&
      typeof tweet.username === "string"
    );
  }

  private tweetRoomKey(tweet: TweetWithIdentity): string {
    return tweet.conversationId ?? tweet.id;
  }

  async init() {
    this.state = await resolveTwitterAccountConfig(this.runtime, {
      accountId: this.accountId,
      state: this.state,
    });
    this.accountId = resolveRequestedXAccountId(
      this.runtime,
      this.state,
      this.state.accountId,
    );
    const provider = createTwitterAuthProvider(this.runtime, this.state);

    const maxRetries = resolveMaxAuthRetries(process.env.MAX_RETRIES);
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.log(
          `Initializing Twitter API v2 client for accountId=${this.accountId}`,
        );
        await this.twitterClient.authenticate(provider);

        if (await this.twitterClient.isLoggedIn()) {
          logger.info(
            `Successfully authenticated with Twitter API v2 for accountId=${this.accountId}`,
          );
          break;
        } else {
          // Authentication succeeded but verification failed - treat as auth failure
          throw new Error(
            "Authentication verification failed - credentials may be invalid",
          );
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Authentication attempt ${retryCount + 1} failed: ${lastError.message}`,
        );
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
        `Twitter authentication failed after ${maxRetries} attempts. Last error: ${lastError?.message}`,
      );
    }

    await this.getAuthenticatedProfile();

    await this.populateTimeline();
  }

  async fetchOwnPosts(count: number): Promise<Tweet[]> {
    return this.withAuthenticatedSession(async ({ profile }) => {
      logger.debug("fetching own posts");
      const homeTimeline = await this.twitterClient.getUserTweets(
        profile.id,
        count,
      );
      // homeTimeline.tweets already contains Tweet objects from v2 API, no parsing needed
      return homeTimeline.tweets;
    });
  }

  /**
   * Fetch timeline for twitter account, optionally only from followed accounts
   */
  async fetchHomeTimeline(
    count: number,
    following?: boolean,
  ): Promise<Tweet[]> {
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
    cursor?: string,
  ): Promise<QueryTweetsResponse> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new ElizaError("X search timed out", {
                code: "X_SEARCH_TIMEOUT",
              }),
            ),
          15_000,
        );
      });
      const result = await this.requestQueue.add(() =>
        Promise.race([
          this.twitterClient.fetchSearchTweets(
            query,
            maxTweets,
            searchMode,
            cursor,
          ),
          timeoutPromise,
        ]),
      );
      if (!result) {
        throw new ElizaError("X search returned no response", {
          code: "X_SEARCH_RESPONSE_INVALID",
        });
      }
      return result as QueryTweetsResponse;
    } catch (error) {
      if (error instanceof ElizaError) throw error;
      // error-policy:J2 preserve the provider failure as the cause while adding
      // the connector operation context expected by agent-facing boundaries.
      throw new ElizaError("Failed to fetch X search results", {
        code: "X_SEARCH_FAILED",
        cause: error,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async populateTimeline() {
    return this.withAuthenticatedSession(({ profile }) =>
      this.populateTimelineFor(profile),
    );
  }

  private async populateTimelineFor(profile: TwitterProfile) {
    logger.debug("populating timeline...");

    const cachedTimeline = await this.getCachedTimeline(profile);
    const validCachedTimeline =
      cachedTimeline?.filter((tweet): tweet is TweetWithIdentity =>
        this.hasTweetIdentity(tweet),
      ) ?? undefined;

    // Check if the cache file exists
    if (validCachedTimeline) {
      // Read the cached search results from the file

      // Get the existing memories from the database
      const existingMemories = await this.runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds: validCachedTimeline.map((tweet) =>
          createUniqueUuid(this.runtime, this.tweetRoomKey(tweet)),
        ),
      });

      // Create a Set to store the IDs of existing memories
      const existingMemoryIds = new Set(
        existingMemories
          .map((memory) => memory.id)
          .filter((id): id is UUID => typeof id === "string")
          .map((id) => id.toString()),
      );

      // Check if any of the cached tweets exist in the existing memories
      const someCachedTweetsExist = validCachedTimeline.some((tweet) =>
        existingMemoryIds.has(createUniqueUuid(this.runtime, tweet.id)),
      );

      if (someCachedTweetsExist) {
        // Filter out the cached tweets that already exist in the database
        const tweetsToSave = validCachedTimeline.filter(
          (tweet) =>
            tweet.userId !== profile.id &&
            !existingMemoryIds.has(createUniqueUuid(this.runtime, tweet.id)),
        );

        // Save the missing tweets as memories
        for (const tweet of tweetsToSave) {
          logger.log("Saving Tweet", tweet.id);

          if (tweet.userId === profile.id) {
            continue;
          }

          // Normalize once per row before any context side effects; a
          // present-but-unusable timestamp fails the row closed (#18965).
          const createdAt = getEpochMs(tweet.timestamp);
          if (createdAt === undefined) {
            logger.debug(
              `Skipping cached tweet ${tweet.id}: unusable timestamp`,
            );
            continue;
          }

          // Create a world for this Twitter user if it doesn't exist
          const worldId = createUniqueUuid(this.runtime, tweet.userId) as UUID;
          const entityId =
            tweet.userId === profile.id
              ? this.runtime.agentId
              : createUniqueUuid(this.runtime, tweet.userId);
          await reconcileTwitterWorld(this.runtime, {
            id: worldId,
            name: `${tweet.username}'s Twitter`,
            agentId: this.runtime.agentId,
            metadata: {
              ownership: { ownerId: entityId },
              twitter: {
                username: tweet.username,
                id: tweet.userId,
              },
            },
          });

          const roomId = createUniqueUuid(
            this.runtime,
            this.tweetRoomKey(tweet),
          );
          // Ensure the entity exists with proper world association
          await this.runtime.ensureConnection({
            entityId,
            roomId,
            userId: createUniqueUuid(this.runtime, tweet.userId),
            userName: tweet.username,
            name: tweet.name,
            source: "twitter",
            type: ChannelType.FEED,
            worldId: worldId,
          });

          const content = {
            text: tweet.text,
            url: tweet.permanentUrl,
            source: "twitter",
            inReplyTo: tweet.inReplyToStatusId
              ? createUniqueUuid(this.runtime, tweet.inReplyToStatusId)
              : undefined,
          } as Content;

          await this.runtime.createMemory(
            {
              id: createUniqueUuid(this.runtime, tweet.id),
              entityId,
              content: content,
              agentId: this.runtime.agentId,
              roomId,
              metadata: buildTwitterMessageMetadata(
                tweet,
                entityId,
                createdAt,
                this.accountId,
              ),
              createdAt,
            },
            "messages",
          );

          await this.cacheTweet(tweet);
        }

        logger.log(
          `Populated ${tweetsToSave.length} missing tweets from the cache.`,
        );
        return;
      }
    }

    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);

    // Get the most recent 20 mentions and interactions
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${profile.username}`,
      20,
      SearchMode.Latest,
    );

    // Combine the timeline tweets and mentions/interactions
    const allTweets = [...timeline, ...mentionsAndInteractions.tweets].filter(
      (tweet): tweet is TweetWithIdentity => this.hasTweetIdentity(tweet),
    );

    // Create a Set to store unique tweet IDs
    const tweetIdsToCheck = new Set<string>();
    const roomIds = new Set<UUID>();

    // Add tweet IDs to the Set
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(createUniqueUuid(this.runtime, this.tweetRoomKey(tweet)));
    }

    // Check the existing memories in the database
    const existingMemories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: Array.from(roomIds),
    });

    // Create a Set to store the existing memory IDs
    const existingMemoryIds = new Set<UUID>(
      existingMemories
        .map((memory) => memory.id)
        .filter((id): id is UUID => typeof id === "string"),
    );

    // Filter out the tweets that already exist in the database
    const tweetsToSave = allTweets.filter(
      (tweet) =>
        tweet.userId !== profile.id &&
        !existingMemoryIds.has(createUniqueUuid(this.runtime, tweet.id)),
    );

    logger.debug({
      processingTweets: tweetsToSave.map((tweet) => tweet.id).join(","),
    });

    // Save the new tweets as memories
    for (const tweet of tweetsToSave) {
      logger.log("Saving Tweet", tweet.id);

      if (tweet.userId === profile.id) {
        continue;
      }

      // Normalize once per row before any context side effects; a
      // present-but-unusable timestamp fails the row closed (#18965).
      const createdAt = getEpochMs(tweet.timestamp);
      if (createdAt === undefined) {
        logger.debug(`Skipping fetched tweet ${tweet.id}: unusable timestamp`);
        continue;
      }

      // Create a world for this Twitter user if it doesn't exist
      const worldId = createUniqueUuid(this.runtime, tweet.userId) as UUID;
      const entityId =
        tweet.userId === profile.id
          ? this.runtime.agentId
          : createUniqueUuid(this.runtime, tweet.userId);
      await reconcileTwitterWorld(this.runtime, {
        id: worldId,
        name: `${tweet.username}'s Twitter`,
        agentId: this.runtime.agentId,
        metadata: {
          ownership: { ownerId: entityId },
          twitter: {
            username: tweet.username,
            id: tweet.userId,
          },
        },
      });

      const roomId = createUniqueUuid(this.runtime, this.tweetRoomKey(tweet));

      // Ensure the entity exists with proper world association
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userId: createUniqueUuid(this.runtime, tweet.userId),
        userName: tweet.username,
        name: tweet.name,
        source: "twitter",
        type: ChannelType.FEED,
        worldId: worldId,
      });

      const content = {
        text: tweet.text,
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
          metadata: buildTwitterMessageMetadata(
            tweet,
            entityId,
            createdAt,
            this.accountId,
          ),
          createdAt,
        },
        "messages",
      );

      await this.cacheTweet(tweet);
    }

    // Cache
    await this.cacheTimeline(timeline, profile);
    await this.cacheMentions(mentionsAndInteractions.tweets, profile);
  }

  async saveRequestMessage(message: Memory, _state: State) {
    if (message.content.text) {
      const recentMessage = await this.runtime.getMemories({
        tableName: "messages",
        roomId: message.roomId,
        count: 1,
        unique: false,
      });

      const latestMessage = recentMessage[0];
      if (latestMessage && latestMessage.content === message.content) {
        logger.debug("Message already saved", latestMessage.id);
      } else {
        await createMemorySafe(this.runtime, message, "messages");
      }
    }
  }

  async loadLatestCheckedTweetId(): Promise<void> {
    await this.withAuthenticatedSession(async (session) => {
      const { profile } = session;
      const latestCheckedTweetId = await this.getIdentityCache<string>(
        profile,
        "latest_checked_tweet_id",
      );
      if (!this.isAuthenticatedSessionCurrent(session)) {
        throw new ElizaError("X credentials rotated while loading cursor", {
          code: "X_AUTH_SESSION_ROTATED",
        });
      }
      this.lastCheckedTweetProfileId = profile.id;
      this.lastCheckedTweetId = latestCheckedTweetId
        ? BigInt(latestCheckedTweetId)
        : null;
    });
  }

  async cacheLatestCheckedTweetId(
    authenticatedProfile?: TwitterProfile,
  ): Promise<void> {
    if (!authenticatedProfile) {
      return this.withAuthenticatedSession(({ profile }) =>
        this.cacheLatestCheckedTweetId(profile),
      );
    }
    const profile = authenticatedProfile;
    const write = this.latestCursorWrite.then(async () => {
      if (
        this.lastCheckedTweetId !== null &&
        this.lastCheckedTweetProfileId === profile.id
      ) {
        await this.setIdentityCache(
          profile,
          "latest_checked_tweet_id",
          this.lastCheckedTweetId.toString(),
        );
      }
    });
    this.latestCursorWrite = write.catch(() => undefined);
    await write;
  }

  getLatestCheckedTweetId(profileId: string): bigint | null {
    return this.lastCheckedTweetProfileId === profileId
      ? this.lastCheckedTweetId
      : null;
  }

  recordLatestCheckedTweetId(profileId: string, tweetId: bigint): void {
    if (this.profile?.id !== profileId) {
      return;
    }
    if (
      this.lastCheckedTweetProfileId === profileId &&
      this.lastCheckedTweetId !== null &&
      tweetId <= this.lastCheckedTweetId
    ) {
      return;
    }
    this.lastCheckedTweetProfileId = profileId;
    this.lastCheckedTweetId = tweetId;
  }

  async getCachedTimeline(
    profile?: TwitterProfile,
  ): Promise<Tweet[] | undefined> {
    const currentProfile = profile ?? (await this.getAuthenticatedProfile());
    const cached = await this.getIdentityCache<Tweet[]>(
      currentProfile,
      "timeline",
    );

    if (!cached) {
      return undefined;
    }

    return cached;
  }

  async cacheTimeline(timeline: Tweet[], profile?: TwitterProfile) {
    const currentProfile = profile ?? (await this.getAuthenticatedProfile());
    await this.setIdentityCache(currentProfile, "timeline", timeline);
  }

  async cacheMentions(mentions: Tweet[], profile?: TwitterProfile) {
    const currentProfile = profile ?? (await this.getAuthenticatedProfile());
    await this.setIdentityCache(currentProfile, "mentions", mentions);
  }

  async fetchProfile(username: string): Promise<TwitterProfile> {
    try {
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
            characterBio = this.runtime.character.bio[0] ?? defaultBio;
          }
        }

        if (!profile.userId) {
          throw new Error(
            `Twitter profile for ${username} is missing a user id`,
          );
        }

        return {
          id: profile.userId,
          username,
          screenName: profile.name || characterName,
          bio: profile.biography || characterBio,
          nicknames: [],
        } satisfies TwitterProfile;
      });

      return profile;
    } catch (error) {
      const candidate =
        typeof error === "object" && error !== null
          ? (error as {
              code?: unknown;
              status?: unknown;
              statusCode?: unknown;
            })
          : null;
      const status = [
        candidate?.code,
        candidate?.status,
        candidate?.statusCode,
      ].find((value): value is number => typeof value === "number");
      if (status === 404) {
        throw new ElizaError(`X profile @${username} was not found`, {
          code: "X_PROFILE_NOT_FOUND",
          cause: error,
          context: { username },
        });
      }
      logger.error("Error fetching Twitter profile:", errorDetail(error));
      throw error;
    }
  }

  /**
   * Fetches recent interactions (likes, retweets, quotes) for the authenticated user's tweets
   */
  async fetchInteractions() {
    try {
      return await this.withAuthenticatedSession(async ({ profile }) => {
        // Use fetchSearchTweets to get mentions instead of the non-existent get method
        const mentionsResponse = await this.requestQueue.add(() =>
          this.twitterClient.fetchSearchTweets(
            `@${profile.username}`,
            100,
            SearchMode.Latest,
          ),
        );

        // Process tweets directly into the expected interaction format
        return mentionsResponse.tweets.map((tweet) =>
          this.formatTweetToInteraction(tweet),
        );
      });
    } catch (error) {
      // error-policy:J7 a mentions/interactions fetch failure must surface to the
      // agent rather than reading as no interactions; degrade to an empty list
      // after reporting.
      this.runtime.reportError("XClientBase.getInteractions", error);
      return [];
    }
  }

  formatTweetToInteraction(tweet: Tweet): TwitterInteractionPayload | null {
    if (!tweet?.id || !tweet.userId || !tweet.username) return null;

    const isQuote = tweet.isQuoted;
    const isRetweet = !!tweet.retweetedStatus;
    const type = isQuote ? "quote" : isRetweet ? "retweet" : "like";

    return {
      id: tweet.id,
      type,
      userId: tweet.userId,
      username: tweet.username,
      name: tweet.name || tweet.username,
      targetTweetId: tweet.inReplyToStatusId || tweet.quotedStatusId || "",
      targetTweet: convertClientTweetToCoreTweet(tweet.quotedStatus || tweet),
      quoteTweet: isQuote ? convertClientTweetToCoreTweet(tweet) : undefined,
      retweetId: tweet.retweetedStatus?.id,
    };
  }
}
