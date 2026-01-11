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
import { createXAuthProvider, getXAuthMode } from "./client/auth-providers/factory";
import { Client, type Post, type QueryPostsResponse, SearchMode } from "./client/index";
import type { XInteractionPayload } from "./types";
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
 * Represents an X Profile.
 * @typedef {Object} XProfile
 * @property {string} id - The unique identifier of the profile.
 * @property {string} username - The username of the profile.
 * @property {string} screenName - The screen name of the profile.
 * @property {string} bio - The biography of the profile.
 * @property {string[]} nicknames - An array of nicknames associated with the profile.
 */
type XProfile = {
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
 * Class representing a base client for interacting with X.
 * @extends EventEmitter
 */
export class ClientBase {
  static _xClients: { [accountIdentifier: string]: Client } = {};
  xClient: Client;
  runtime: IAgentRuntime;
  lastCheckedPostId: bigint | null = null;
  temperature = 0.5;

  requestQueue: RequestQueue = new RequestQueue();

  profile: XProfile | null = null;

  /**
   * Caches a post in the database.
   *
   * @param {Post} post - The post to cache.
   * @returns {Promise<void>} A promise that resolves once the post is cached.
   */
  async cachePost(post: Post): Promise<void> {
    if (!post) {
      logger.warn("Post is undefined, skipping cache");
      return;
    }

    this.runtime.setCache<Post>(`x/posts/${post.id}`, post);
  }

  /**
   * Retrieves a cached post by its ID.
   * @param {string} postId - The ID of the post to retrieve from the cache.
   * @returns {Promise<Post | undefined>} A Promise that resolves to the cached post, or undefined if the post is not found in the cache.
   */
  async getCachedPost(postId: string): Promise<Post | undefined> {
    const cached = await this.runtime.getCache<Post>(`x/posts/${postId}`);

    if (!cached) {
      return undefined;
    }

    return cached;
  }

  /**
   * Asynchronously retrieves a post with the specified ID.
   * If the post is found in the cache, it is returned from the cache.
   * If not, a request is made to the X API to get the post, which is then cached and returned.
   * @param {string} postId - The ID of the post to retrieve.
   * @returns {Promise<Post>} A Promise that resolves to the retrieved post.
   */
  async getPost(postId: string): Promise<Post> {
    const cachedPost = await this.getCachedPost(postId);

    if (cachedPost) {
      return cachedPost;
    }

    const post = await this.requestQueue.add(() => this.xClient.getPost(postId));

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    await this.cachePost(post);
    return post as Post;
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

  state: Record<string, unknown>;

  constructor(runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.runtime = runtime;
    this.state = state;

    // Use a stable identifier for client reuse per auth mode.
    const mode = getXAuthMode(runtime, state);
    const reuseKey =
      mode === "env"
        ? typeof state?.X_API_KEY === "string"
          ? state.X_API_KEY
          : getSetting(runtime, "X_API_KEY")
        : mode === "oauth"
          ? typeof state?.X_CLIENT_ID === "string"
            ? state.X_CLIENT_ID
            : getSetting(runtime, "X_CLIENT_ID")
          : typeof state?.X_BROKER_URL === "string"
            ? state.X_BROKER_URL
            : getSetting(runtime, "X_BROKER_URL");

    if (typeof reuseKey === "string" && reuseKey && ClientBase._xClients[reuseKey]) {
      this.xClient = ClientBase._xClients[reuseKey];
    } else {
      this.xClient = new Client();
      if (typeof reuseKey === "string" && reuseKey) {
        ClientBase._xClients[reuseKey] = this.xClient;
      }
    }
  }

  async init() {
    // First ensure the agent exists in the database
    // await this.runtime.ensureAgentExists(this.runtime.character);

    const provider = createXAuthProvider(this.runtime, this.state);

    const maxRetries = process.env.MAX_RETRIES ? Number.parseInt(process.env.MAX_RETRIES, 10) : 3;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.log("Initializing X API v2 client");
        await this.xClient.authenticate(provider);

        if (await this.xClient.isLoggedIn()) {
          logger.info("Successfully authenticated with X API v2");
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
        `X authentication failed after ${maxRetries} attempts. Last error: ${lastError?.message}`
      );
    }

    // Initialize X profile from the authenticated user
    const profile = await this.xClient.me();
    if (profile) {
      logger.log("X user ID:", profile.userId);
      logger.log("X loaded:", JSON.stringify(profile, null, 10));

      const agentId = this.runtime.agentId;

      const entity = await this.runtime.getEntityById(agentId);
      const entityMetadata = entity?.metadata;
      const xMetadata = entityMetadata?.x as { userName?: string; name?: string } | undefined;
      if (xMetadata?.userName !== profile.username) {
        logger.log("Updating Agents known X handle", profile.username, "was", entityMetadata?.x);
        const names = [profile.name, profile.username].filter((n): n is string => !!n);
        if (!entity) {
          throw new Error("Entity not found");
        }
        await this.runtime.updateEntity({
          id: agentId,
          names: [...new Set([...(entity.names || []), ...names])],
          metadata: {
            ...(entityMetadata || {}),
            x: {
              ...(xMetadata || {}),
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

    await this.loadLatestCheckedPostId();
    await this.populateTimeline();
  }

  async fetchOwnPosts(count: number): Promise<Post[]> {
    logger.debug("fetching own posts");
    if (!this.profile?.id) {
      throw new Error("Profile not initialized");
    }
    const homeTimeline = await this.xClient.getUserPosts(this.profile.id, count);
    // homeTimeline.posts already contains Post objects from v2 API, no parsing needed
    return homeTimeline.posts;
  }

  /**
   * Fetch timeline for X account, optionally only from followed accounts
   */
  async fetchHomeTimeline(count: number, following?: boolean): Promise<Post[]> {
    logger.debug("fetching home timeline");
    const homeTimeline = following
      ? await this.xClient.fetchFollowingTimeline(count, [])
      : await this.xClient.fetchHomeTimeline(count, []);

    // homeTimeline already contains Post objects from v2 API, no parsing needed
    return homeTimeline;
  }

  async fetchSearchPosts(
    query: string,
    maxPosts: number,
    searchMode: SearchMode,
    cursor?: string
  ): Promise<QueryPostsResponse> {
    // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
    // if we dont get a response in 5 seconds, something is wrong
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ posts: [] }), 15000)
    );

    const result = await this.requestQueue.add(
      async () =>
        await Promise.race([
          this.xClient.fetchSearchPosts(query, maxPosts, searchMode, cursor),
          timeoutPromise,
        ])
    );
    return (result ?? { posts: [] }) as QueryPostsResponse;
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
          .map((post) => post.conversationId)
          .filter((id): id is string => !!id)
          .map((id) => createUniqueUuid(this.runtime, id as string)),
      });

      // Create a Set to store the IDs of existing memories
      const existingMemoryIds = new Set(
        existingMemories.map((memory) => memory.id?.toString()).filter((id): id is string => !!id)
      );

      // Check if any of the cached posts exist in the existing memories
      const someCachedPostsExist = cachedTimeline.some((post) =>
        post.id ? existingMemoryIds.has(createUniqueUuid(this.runtime, post.id as string)) : false
      );

      if (someCachedPostsExist) {
        // Filter out the cached posts that already exist in the database
        const postsToSave = cachedTimeline.filter(
          (post) =>
            post.userId &&
            post.id &&
            post.userId !== this.profile?.id &&
            !existingMemoryIds.has(createUniqueUuid(this.runtime, post.id as string))
        );

        // Save the missing posts as memories
        for (const post of postsToSave) {
          if (!post.id || !post.userId || !post.conversationId || !post.username) {
            logger.warn("Skipping post with missing required fields");
            continue;
          }

          logger.log("Saving Post", post.id);

          if (post.userId === this.profile?.id) {
            continue;
          }

          // Create a world for this X user if it doesn't exist
          const worldId = createUniqueUuid(this.runtime, post.userId) as UUID;
          await this.runtime.ensureWorldExists({
            id: worldId,
            name: `${post.username}'s X`,
            agentId: this.runtime.agentId,
            messageServerId: createUniqueUuid(this.runtime, post.userId) as UUID,
            metadata: {
              ownership: { ownerId: post.userId },
              x: {
                username: post.username,
                id: post.userId,
              },
            },
          });

          const roomId = createUniqueUuid(this.runtime, post.conversationId as string);
          const entityId =
            post.userId === this.profile?.id
              ? this.runtime.agentId
              : createUniqueUuid(this.runtime, post.userId as string);

          // Ensure the entity exists with proper world association
          await this.runtime.ensureConnection({
            entityId,
            roomId,
            userName: post.username as string,
            name: (post.name || post.username) as string,
            source: "x",
            type: ChannelType.FEED,
            worldId: worldId,
          });

          const content = {
            text: post.text || "",
            url: post.permanentUrl,
            source: "x",
            inReplyTo: post.inReplyToStatusId
              ? createUniqueUuid(this.runtime, post.inReplyToStatusId as string)
              : undefined,
          } as Content;

          await this.runtime.createMemory(
            {
              id: createUniqueUuid(this.runtime, post.id as string),
              entityId,
              content: content,
              agentId: this.runtime.agentId,
              roomId,
              createdAt: getEpochMs(post.timestamp),
            },
            "messages"
          );

          await this.cachePost(post);
        }

        logger.log(`Populated ${postsToSave.length} missing posts from the cache.`);
        return;
      }
    }

    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);

    // Get the most recent 20 mentions and interactions
    if (!this.profile?.username) {
      logger.warn("Profile username not available, skipping mentions fetch");
      return;
    }

    const mentionsAndInteractions = await this.fetchSearchPosts(
      `@${this.profile.username}`,
      20,
      SearchMode.Latest
    );

    // Combine the timeline posts and mentions/interactions
    const allPosts = [...timeline, ...mentionsAndInteractions.posts];

    // Create a Set to store unique post IDs
    const postIdsToCheck = new Set<string>();
    const roomIds = new Set<UUID>();

    // Add post IDs to the Set
    for (const post of allPosts) {
      if (!post.id || !post.conversationId) {
        continue;
      }
      postIdsToCheck.add(post.id);
      roomIds.add(createUniqueUuid(this.runtime, post.conversationId));
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

    // Filter out the posts that already exist in the database
    const postsToSave = allPosts.filter(
      (post) =>
        post.userId &&
        post.id &&
        post.userId !== this.profile?.id &&
        !existingMemoryIds.has(createUniqueUuid(this.runtime, post.id))
    );

    logger.debug({
      processingPosts: postsToSave
        .map((post) => post.id)
        .filter(Boolean)
        .join(","),
    });

    // Save the new posts as memories
    for (const post of postsToSave) {
      if (!post.id || !post.userId || !post.conversationId || !post.username) {
        logger.warn("Skipping post with missing required fields");
        continue;
      }

      logger.log("Saving Post", post.id);

      if (post.userId === this.profile?.id) {
        continue;
      }

      // Create a world for this X user if it doesn't exist
      const worldId = createUniqueUuid(this.runtime, post.userId) as UUID;
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `${post.username}'s X`,
        agentId: this.runtime.agentId,
        messageServerId: createUniqueUuid(this.runtime, post.userId) as UUID,
        metadata: {
          ownership: { ownerId: post.userId },
          x: {
            username: post.username,
            id: post.userId,
          },
        },
      });

      const roomId = createUniqueUuid(this.runtime, post.conversationId);

      const entityId =
        post.userId === this.profile?.id
          ? this.runtime.agentId
          : createUniqueUuid(this.runtime, post.userId);

      // Ensure the entity exists with proper world association
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: post.username,
        name: post.name,
        source: "x",
        type: ChannelType.FEED,
        worldId: worldId,
      });

      const content = {
        text: post.text || "",
        url: post.permanentUrl,
        source: "x",
        inReplyTo: post.inReplyToStatusId
          ? createUniqueUuid(this.runtime, post.inReplyToStatusId)
          : undefined,
      } as Content;

      await createMemorySafe(
        this.runtime,
        {
          id: createUniqueUuid(this.runtime, post.id),
          entityId,
          content: content,
          agentId: this.runtime.agentId,
          roomId,
          createdAt: getEpochMs(post.timestamp),
        },
        "messages"
      );

      await this.cachePost(post);
    }

    // Cache
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.posts);
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
        xClient: this.xClient,
      });
    }
  }

  async loadLatestCheckedPostId(): Promise<void> {
    if (!this.profile?.username) {
      return;
    }
    const latestCheckedPostId = await this.runtime.getCache<string>(
      `x/${this.profile.username}/latest_checked_post_id`
    );

    if (latestCheckedPostId) {
      this.lastCheckedPostId = BigInt(latestCheckedPostId);
    }
  }

  async cacheLatestCheckedPostId() {
    if (this.lastCheckedPostId && this.profile?.username) {
      await this.runtime.setCache<string>(
        `x/${this.profile.username}/latest_checked_post_id`,
        this.lastCheckedPostId.toString()
      );
    }
  }

  async getCachedTimeline(): Promise<Post[] | undefined> {
    if (!this.profile?.username) {
      return undefined;
    }
    const cached = await this.runtime.getCache<Post[]>(`x/${this.profile.username}/timeline`);

    if (!cached) {
      return undefined;
    }

    return cached;
  }

  async cacheTimeline(timeline: Post[]) {
    if (!this.profile?.username) {
      return;
    }
    await this.runtime.setCache<Post[]>(`x/${this.profile.username}/timeline`, timeline);
  }

  async cacheMentions(mentions: Post[]) {
    if (!this.profile?.username) {
      return;
    }
    await this.runtime.setCache<Post[]>(`x/${this.profile.username}/mentions`, mentions);
  }

  async fetchProfile(username: string): Promise<XProfile> {
    const profile = await this.requestQueue.add(async () => {
      const profile = await this.xClient.getProfile(username);

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
      } satisfies XProfile;
    });

    return profile;
  }

  /**
   * Fetches recent interactions (likes, reposts, quotes) for the authenticated user's posts
   */
  async fetchInteractions() {
    if (!this.profile?.username) {
      return [];
    }
    const username = this.profile.username;
    // Use fetchSearchPosts to get mentions instead of the non-existent get method
    const mentionsResponse = await this.requestQueue.add(() =>
      this.xClient.fetchSearchPosts(`@${username}`, 100, SearchMode.Latest)
    );

    // Process posts directly into the expected interaction format
    return mentionsResponse.posts.map((post: Post) => this.formatPostToInteraction(post));
  }

  formatPostToInteraction(post: Post): XInteractionPayload | null {
    if (!post) return null;

    const isQuote = post.isQuoted;
    const isRepost = !!post.repostedStatus;
    const type: "quote" | "repost" | "like" = isQuote ? "quote" : isRepost ? "repost" : "like";

    if (!post.id || !post.userId || !post.username) {
      return null;
    }

    return {
      id: post.id,
      type,
      userId: post.userId,
      username: post.username,
      name: post.name || post.username,
      targetPostId: post.inReplyToStatusId || post.quotedStatusId || undefined,
      targetPost: post.quotedStatus || post,
      quotePost: isQuote ? post : undefined,
      repostId: post.repostedStatus?.id,
    };
  }
}
