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

// WorldOwnership type for world metadata
type WorldOwnership = { ownerId: string };

import { createXAuthProvider, getXAuthMode } from "./client/auth-providers/factory";
import { Client, type Post, type QueryPostsResponse, SearchMode } from "./client/index";
import type { XInteractionPayload } from "./types";
import { createMemorySafe } from "./utils/memory";
import { getSetting } from "./utils/settings";
import { getEpochMs } from "./utils/time";

export function extractAnswer(text: string): string {
  const startIndex = text.indexOf("Answer: ") + 8;
  const endIndex = text.indexOf("<|endoftext|>", 11);
  return text.slice(startIndex, endIndex);
}

type XProfile = {
  id: string;
  username: string;
  screenName: string;
  bio: string;
  nicknames: string[];
};

class RequestQueue {
  private queue: (() => Promise<unknown>)[] = [];
  private processing = false;
  private maxRetries = 3;
  private retryAttempts = new Map<() => Promise<unknown>, number>();

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
        this.retryAttempts.delete(request);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Error processing request:", errorMsg);

        const retryCount = (this.retryAttempts.get(request) || 0) + 1;

        if (retryCount < this.maxRetries) {
          this.retryAttempts.set(request, retryCount);
          this.queue.unshift(request);
          await this.exponentialBackoff(retryCount);
          break;
        } else {
          logger.error(`Max retries (${this.maxRetries}) exceeded for request, skipping`);
          this.retryAttempts.delete(request);
        }
      }
      await this.randomDelay();
    }

    this.processing = false;

    if (this.queue.length > 0) {
      this.processQueue();
    }
  }

  private async exponentialBackoff(retryCount: number): Promise<void> {
    const delay = 2 ** retryCount * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async randomDelay(): Promise<void> {
    const delay = Math.floor(Math.random() * 2000) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export class ClientBase {
  static _xClients: { [accountIdentifier: string]: Client } = {};
  xClient: Client;
  runtime: IAgentRuntime;
  lastCheckedPostId: bigint | null = null;
  temperature = 0.5;

  requestQueue: RequestQueue = new RequestQueue();

  profile: XProfile | null = null;

  async cachePost(post: Post): Promise<void> {
    if (!post) {
      logger.warn("Post is undefined, skipping cache");
      return;
    }

    this.runtime.setCache<Post>(`x/posts/${post.id}`, post);
  }

  async getCachedPost(postId: string): Promise<Post | undefined> {
    const cached = await this.runtime.getCache<Post>(`x/posts/${postId}`);

    if (!cached) {
      return undefined;
    }

    return cached;
  }

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

  onReady() {
    throw new Error("Not implemented in base class, please call from subclass");
  }

  state: Record<string, unknown>;

  constructor(runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.runtime = runtime;
    this.state = state;

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
          const delay = 2 ** retryCount * 1000;
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
        username: profile.username,
        screenName: profile.name,
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
    return homeTimeline.posts;
  }

  async fetchHomeTimeline(count: number, following?: boolean): Promise<Post[]> {
    logger.debug("fetching home timeline");
    const homeTimeline = following
      ? await this.xClient.fetchFollowingTimeline(count, [])
      : await this.xClient.fetchHomeTimeline(count, []);

    return homeTimeline;
  }

  async fetchSearchPosts(
    query: string,
    maxPosts: number,
    searchMode: SearchMode,
    cursor?: string
  ): Promise<QueryPostsResponse> {
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

    if (cachedTimeline) {
      const existingMemories = await this.runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds: cachedTimeline
          .map((post) => post.conversationId)
          .filter((id): id is string => !!id)
          .map((id) => createUniqueUuid(this.runtime, id as string)),
      });

      const existingMemoryIds = new Set(
        existingMemories.map((memory) => memory.id?.toString()).filter((id): id is string => !!id)
      );

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

        for (const post of postsToSave) {
          if (!post.id || !post.userId || !post.conversationId || !post.username) {
            logger.warn("Skipping post with missing required fields");
            continue;
          }

          logger.log("Saving Post", post.id);

          if (post.userId === this.profile?.id) {
            continue;
          }

          const worldId = createUniqueUuid(this.runtime, post.userId) as UUID;
          await this.runtime.ensureWorldExists({
            id: worldId,
            name: `${post.username}'s X`,
            agentId: this.runtime.agentId,
            messageServerId: createUniqueUuid(this.runtime, post.userId) as UUID,
            metadata: {
              ownership: { ownerId: post.userId } as unknown as WorldOwnership,
              extra: {
                x: {
                  username: post.username,
                  id: post.userId,
                },
              },
            },
          });

          const roomId = createUniqueUuid(this.runtime, post.conversationId as string);
          const entityId =
            post.userId === this.profile?.id
              ? this.runtime.agentId
              : createUniqueUuid(this.runtime, post.userId as string);

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

    if (!this.profile?.username) {
      logger.warn("Profile username not available, skipping mentions fetch");
      return;
    }

    const mentionsAndInteractions = await this.fetchSearchPosts(
      `@${this.profile.username}`,
      20,
      SearchMode.Latest
    );

    const allPosts = [...timeline, ...mentionsAndInteractions.posts];

    const postIdsToCheck = new Set<string>();
    const roomIds = new Set<UUID>();

    for (const post of allPosts) {
      if (!post.id || !post.conversationId) {
        continue;
      }
      postIdsToCheck.add(post.id);
      roomIds.add(createUniqueUuid(this.runtime, post.conversationId));
    }

    const existingMemories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: Array.from(roomIds),
    });

    const existingMemoryIds = new Set<UUID>(
      existingMemories.map((memory) => memory.id).filter((id): id is UUID => !!id)
    );

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

    for (const post of postsToSave) {
      if (!post.id || !post.userId || !post.conversationId || !post.username) {
        logger.warn("Skipping post with missing required fields");
        continue;
      }

      logger.log("Saving Post", post.id);

      if (post.userId === this.profile?.id) {
        continue;
      }

      const worldId = createUniqueUuid(this.runtime, post.userId) as UUID;
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `${post.username}'s X`,
        agentId: this.runtime.agentId,
        messageServerId: createUniqueUuid(this.runtime, post.userId) as UUID,
        metadata: {
          ownership: { ownerId: post.userId } as unknown as WorldOwnership,
          extra: {
            x: {
              username: post.username,
              id: post.userId,
            },
          },
        },
      });

      const roomId = createUniqueUuid(this.runtime, post.conversationId);

      const entityId =
        post.userId === this.profile?.id
          ? this.runtime.agentId
          : createUniqueUuid(this.runtime, post.userId);

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

  async fetchInteractions() {
    if (!this.profile?.username) {
      return [];
    }
    const username = this.profile.username;
    const mentionsResponse = await this.requestQueue.add(() =>
      this.xClient.fetchSearchPosts(`@${username}`, 100, SearchMode.Latest)
    );

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
