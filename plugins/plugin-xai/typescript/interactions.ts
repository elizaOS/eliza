import {
  ChannelType,
  type Content,
  type ContentValue,
  createUniqueUuid,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type MessagePayload,
  ModelType,
} from "@elizaos/core";

// WorldOwnership type for world metadata
type WorldOwnership = { ownerId: string };

import type { ClientBase } from "./base";
import { SearchMode } from "./client/index";
import type { Post as ClientPost } from "./client/posts";
import { getRandomInterval, getTargetUsers, shouldTargetUser } from "./environment";
/**
 * Template for generating dialog and actions for a X message handler.
 *
 * @type {string}
 */
/**
 * Templates for XAI plugin interactions.
 * Auto-generated from prompts/*.txt
 * DO NOT EDIT - Generated from ./generated/prompts/typescript/prompts.ts
 */
import {
  messageHandlerTemplate,
  xMessageHandlerTemplate,
} from "./generated/prompts/typescript/prompts.js";
import type {
  XInteractionMemory,
  XInteractionPayload,
  XLikeReceivedPayload,
  XMemory,
  XQuoteReceivedPayload,
  XRepostReceivedPayload,
} from "./types";
import { XEventTypes } from "./types";
import { sendPost } from "./utils";
import { createMemorySafe, ensureXContext as ensureContext, isPostProcessed } from "./utils/memory";
import { getSetting } from "./utils/settings";
import { getEpochMs } from "./utils/time";
export { xMessageHandlerTemplate, messageHandlerTemplate };

/**
 * The XInteractionClient class manages X interactions,
 * including handling mentions, managing timelines, and engaging with other users.
 * It extends the base X client functionality to provide mention handling,
 * user interaction, and follow change detection capabilities.
 *
 * @extends ClientBase
 */
export class XInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  xUsername: string;
  xUserId: string;
  private isDryRun: boolean;
  private state: Record<string, unknown>;
  private isRunning: boolean = false;

  /**
   * Constructor to initialize the X interaction client with runtime and state management.
   *
   * @param {ClientBase} client - The client instance.
   * @param {IAgentRuntime} runtime - The runtime instance for agent operations.
   * @param {Record<string, unknown>} state - The state object containing configuration settings.
   */
  constructor(client: ClientBase, runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.client = client;
    this.runtime = runtime;
    this.state = state;

    const dryRunSetting =
      this.state?.X_DRY_RUN ?? getSetting(this.runtime, "X_DRY_RUN") ?? process.env.X_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
      dryRunSetting === "true" ||
      (typeof dryRunSetting === "string" && dryRunSetting.toLowerCase() === "true");

    // Initialize X username and user ID from client profile
    const usernameSetting = getSetting(this.runtime, "X_USERNAME") || this.state?.X_USERNAME;
    this.xUsername =
      typeof usernameSetting === "string" ? usernameSetting : client.profile?.username || "";
    this.xUserId = client.profile?.id || "";
  }

  /**
   * Asynchronously starts the process of handling X interactions on a loop.
   * Uses the X_ENGAGEMENT_INTERVAL setting.
   */
  async start() {
    this.isRunning = true;

    const handleXInteractionsLoop = () => {
      if (!this.isRunning) {
        logger.info("X interaction client stopped, exiting loop");
        return;
      }

      // Get random engagement interval in minutes
      const engagementIntervalMinutes = getRandomInterval(this.runtime, "engagement");

      const interactionInterval = engagementIntervalMinutes * 60 * 1000;

      logger.info(
        `X interaction client will check in ${engagementIntervalMinutes.toFixed(1)} minutes`
      );

      this.handleXInteractions();

      if (this.isRunning) {
        setTimeout(handleXInteractionsLoop, interactionInterval);
      }
    };
    handleXInteractionsLoop();
  }

  /**
   * Stops the X interaction client
   */
  async stop() {
    logger.log("Stopping X interaction client...");
    this.isRunning = false;
  }

  /**
   * Asynchronously handles X interactions by checking for mentions and target user posts.
   */
  async handleXInteractions() {
    logger.log("Checking X interactions");

    const xUsername = this.client.profile?.username;

    try {
      // Check for mentions first (replies enabled by default)
      const repliesEnabled =
        (getSetting(this.runtime, "X_ENABLE_REPLIES") ?? process.env.X_ENABLE_REPLIES) !== "false";

      if (repliesEnabled && xUsername) {
        await this.handleMentions(xUsername);
      }

      // Check target users' posts for autonomous engagement
      const targetUsersConfig =
        ((getSetting(this.runtime, "X_TARGET_USERS") ?? process.env.X_TARGET_USERS) as string) ||
        "";

      if (targetUsersConfig?.trim()) {
        await this.handleTargetUserPosts(targetUsersConfig);
      }

      // Save the latest checked post ID to the file
      await this.client.cacheLatestCheckedPostId();

      logger.log("Finished checking X interactions");
    } catch (error) {
      logger.error(
        "Error handling X interactions:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Handle mentions and replies
   */
  private async handleMentions(xUsername: string) {
    try {
      // Check for mentions
      const cursorKey = `x/${xUsername}/mention_cursor`;
      const cachedCursor: string | undefined = await this.runtime.getCache<string>(cursorKey);

      const searchResult = await this.client.fetchSearchPosts(
        `@${xUsername}`,
        20,
        SearchMode.Latest,
        cachedCursor ?? undefined
      );

      const mentionCandidates = searchResult.posts;

      // If we got posts and there's a valid cursor, cache it
      if (mentionCandidates.length > 0 && searchResult.previous) {
        await this.runtime.setCache(cursorKey, searchResult.previous);
      } else if (!searchResult.previous && !searchResult.next) {
        // If both previous and next are missing, clear the outdated cursor
        await this.runtime.setCache(cursorKey, "");
      }

      await this.processMentionPosts(mentionCandidates);
    } catch (error) {
      logger.error(
        "Error handling mentions:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Handle autonomous engagement with target users' posts
   */
  private async handleTargetUserPosts(targetUsersConfig: string) {
    try {
      const targetUsers = getTargetUsers(targetUsersConfig);

      if (targetUsers.length === 0 && !targetUsersConfig.includes("*")) {
        return; // No target users configured
      }

      logger.info(`Checking posts from target users: ${targetUsers.join(", ") || "everyone (*)"}`);

      // For each target user, search their recent posts
      for (const targetUser of targetUsers) {
        try {
          const normalizedUsername = targetUser.replace(/^@/, "");

          // Search for recent posts from this user
          const searchQuery = `from:${normalizedUsername} -is:reply -is:repost`;
          const searchResult = await this.client.fetchSearchPosts(
            searchQuery,
            10, // Get up to 10 recent posts per user
            SearchMode.Latest
          );

          if (searchResult.posts.length > 0) {
            logger.info(`Found ${searchResult.posts.length} posts from @${normalizedUsername}`);

            // Process these posts for potential engagement
            await this.processTargetUserPosts(searchResult.posts, normalizedUsername);
          }
        } catch (error) {
          logger.error(
            `Error searching posts from @${targetUser}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      // If wildcard is configured, also check timeline for any interesting posts
      if (targetUsersConfig.includes("*")) {
        await this.processTimelineForEngagement();
      }
    } catch (error) {
      logger.error(
        "Error handling target user posts:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Process posts from target users for potential engagement
   */
  private async processTargetUserPosts(posts: ClientPost[], username: string) {
    const maxEngagementsPerRun = parseInt(
      (getSetting(this.runtime, "X_MAX_ENGAGEMENTS_PER_RUN") as string) ||
        process.env.X_MAX_ENGAGEMENTS_PER_RUN ||
        "10",
      10
    );

    let engagementCount = 0;

    for (const post of posts) {
      if (engagementCount >= maxEngagementsPerRun) {
        logger.info(`Reached max engagements limit (${maxEngagementsPerRun})`);
        break;
      }

      // Skip if already processed
      if (!post.id) {
        continue;
      }
      const isProcessed = await isPostProcessed(this.runtime, post.id);
      if (isProcessed) {
        continue; // Already processed
      }

      // Skip if post is too old (older than 24 hours)
      const postAge = Date.now() - getEpochMs(post.timestamp);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      if (postAge > maxAge) {
        continue;
      }

      // Decide whether to engage with this post
      const shouldEngage = await this.shouldEngageWithPost(post);

      if (shouldEngage) {
        logger.info(
          `Engaging with post from @${username}: ${post.text?.substring(0, 50) || "no text"}...`
        );

        // Create necessary context for the post
        await this.ensurePostContext(post);

        // Handle the post (generate and send reply)
        const engaged = await this.engageWithPost(post);

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
      // we'll do a general search for recent popular posts
      const searchResult = await this.client.fetchSearchPosts(
        "min_reposts:10 min_faves:20 -is:reply -is:repost lang:en",
        20,
        SearchMode.Latest
      );

      const relevantPosts = searchResult.posts.filter((post) => {
        // Filter for posts from the last 12 hours
        const postAge = Date.now() - getEpochMs(post.timestamp);
        return postAge < 12 * 60 * 60 * 1000;
      });

      if (relevantPosts.length > 0) {
        logger.info(`Found ${relevantPosts.length} relevant posts from timeline`);
        await this.processTargetUserPosts(relevantPosts, "timeline");
      }
    } catch (error) {
      logger.error(
        "Error processing timeline for engagement:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Determine if the bot should engage with a specific post
   */
  private async shouldEngageWithPost(post: ClientPost): Promise<boolean> {
    try {
      // Create a simple evaluation prompt
      const evaluationContext = {
        post: post.text,
        author: post.username,
        metrics: {
          likes: post.likes || 0,
          reposts: post.reposts || 0,
          replies: post.replies || 0,
        },
      };

      if (!post.id) {
        return false;
      }
      const shouldEngageMemory: Memory = {
        id: createUniqueUuid(this.runtime, `eval-${post.id}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: createUniqueUuid(this.runtime, post.conversationId || post.id),
        content: {
          text: `Should I engage with this post? Post: "${post.text}" by @${post.username}`,
          evaluationContext,
        },
        createdAt: Date.now(),
      };

      const _state = await this.runtime.composeState(shouldEngageMemory);
      const characterName = this.runtime?.character?.name || "AI Assistant";
      const context = `You are ${characterName}. Should you reply to this post based on your interests and expertise?
      
Post by @${post.username}: "${post.text}"

Reply with YES if:
- The topic relates to your interests or expertise
- You can add valuable insights or perspective
- The conversation seems constructive

Reply with NO if:
- The topic is outside your knowledge
- The post is inflammatory or controversial
- You have nothing meaningful to add

Response (YES/NO):`;

      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: context,
        temperature: 0.3,
        maxTokens: 10,
      });

      return response.trim().toUpperCase().includes("YES");
    } catch (error) {
      logger.error(
        "Error determining engagement:",
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Ensure post context exists (world, room, entity)
   */
  private async ensurePostContext(post: ClientPost) {
    try {
      if (!post.userId || !post.username) {
        logger.warn("Cannot ensure context: missing userId or username");
        return;
      }
      const context = await ensureContext(this.runtime, {
        userId: post.userId,
        username: post.username,
        name: post.name,
        conversationId: post.conversationId || post.id,
      });

      // Save post as memory with error handling
      // Convert Post to ContentValue-compatible format
      // Post properties are JSON-serializable and compatible with ContentValue
      const postContentValue: Record<string, ContentValue> = {
        id: post.id ?? null,
        text: post.text ?? null,
        userId: post.userId ?? null,
        username: post.username ?? null,
        timestamp: post.timestamp ?? null,
        conversationId: post.conversationId ?? null,
        likes: post.likes ?? null,
        reposts: post.reposts ?? null,
        replies: post.replies ?? null,
        quotes: post.quotes ?? null,
        permanentUrl: post.permanentUrl ?? null,
      };

      const postMemory: Memory = {
        id: createUniqueUuid(this.runtime, post.id || ""),
        entityId: context.entityId,
        content: {
          text: post.text,
          url: post.permanentUrl,
          source: "x",
          post: postContentValue,
        },
        agentId: this.runtime.agentId,
        roomId: context.roomId,
        createdAt: getEpochMs(post.timestamp),
      };

      await createMemorySafe(this.runtime, postMemory, "messages");
    } catch (error) {
      logger.error(
        `Failed to ensure context for post ${post.id}:`,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Engage with a post by generating and sending a reply
   */
  private async engageWithPost(post: ClientPost): Promise<boolean> {
    try {
      const message: Memory = {
        id: createUniqueUuid(this.runtime, post.id || ""),
        entityId: createUniqueUuid(this.runtime, post.userId || ""),
        content: {
          text: post.text,
          source: "x",
          post: {
            id: post.id,
            text: post.text,
            userId: post.userId,
            username: post.username,
            timestamp: post.timestamp,
            conversationId: post.conversationId,
          } as Record<string, string | number | boolean | null | undefined>,
        },
        agentId: this.runtime.agentId,
        roomId: createUniqueUuid(this.runtime, post.conversationId || post.id || ""),
        createdAt: getEpochMs(post.timestamp),
      };

      const result = await this.handlePost({
        post,
        message,
        thread: post.thread || [post],
      });

      return typeof result.text === "string" && result.text.length > 0;
    } catch (error) {
      logger.error(
        "Error engaging with post:",
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Processes all incoming posts that mention the bot.
   * For each new post:
   *  - Ensures world, room, and connection exist
   *  - Saves the post as memory
   *  - Emits thread-related events (THREAD_CREATED / THREAD_UPDATED)
   *  - Delegates post content to `handlePost` for reply generation
   */
  async processMentionPosts(mentionCandidates: ClientPost[]) {
    logger.log("Completed checking mentioned posts:", mentionCandidates.length.toString());
    let uniquePostCandidates = [...mentionCandidates];

    // Sort post candidates by ID in ascending order
    uniquePostCandidates = uniquePostCandidates
      .sort((a, b) => (a.id || "").localeCompare(b.id || ""))
      .filter((post) => post.userId && post.userId !== this.client.profile?.id);

    // Get X_TARGET_USERS configuration
    const targetUsersConfig =
      ((getSetting(this.runtime, "X_TARGET_USERS") ?? process.env.X_TARGET_USERS) as string) || "";

    // Filter posts based on X_TARGET_USERS if configured
    if (targetUsersConfig?.trim()) {
      uniquePostCandidates = uniquePostCandidates.filter((post) => {
        const shouldTarget = shouldTargetUser(post.username || "", targetUsersConfig);
        if (!shouldTarget) {
          logger.log(`Skipping post from @${post.username} - not in target users list`);
        }
        return shouldTarget;
      });
    }

    // Get max interactions per run setting
    const maxInteractionsPerRun = parseInt(
      (getSetting(this.runtime, "X_MAX_ENGAGEMENTS_PER_RUN") as string) ||
        process.env.X_MAX_ENGAGEMENTS_PER_RUN ||
        "10",
      10
    );

    // Limit the number of interactions per run
    const postsToProcess = uniquePostCandidates.slice(0, maxInteractionsPerRun);
    logger.info(
      `Processing ${postsToProcess.length} of ${uniquePostCandidates.length} mention posts (max: ${maxInteractionsPerRun})`
    );

    // for each post candidate, handle the post
    for (const post of postsToProcess) {
      if (
        !this.client.lastCheckedPostId ||
        (post.id && BigInt(post.id) > this.client.lastCheckedPostId)
      ) {
        // Generate the postId UUID the same way it's done in handlePost
        const postId = createUniqueUuid(this.runtime, post.id || "");

        // Check if we've already processed this post
        const existingResponse = await this.runtime.getMemoryById(postId);

        if (existingResponse) {
          logger.log(`Already responded to post ${post.id}, skipping`);
          continue;
        }

        // Also check if we've already responded to this post (for chunked responses)
        // by looking for any memory with inReplyTo pointing to this post
        const conversationRoomId = createUniqueUuid(
          this.runtime,
          post.conversationId || post.id || ""
        );
        const existingReplies = await this.runtime.getMemories({
          tableName: "messages",
          roomId: conversationRoomId,
          count: 10, // Check recent messages in this room
        });

        // Check if any of the found memories is a reply to this specific post
        const hasExistingReply = existingReplies.some(
          (memory) => memory.content.inReplyTo === postId || memory.content.inReplyTo === post.id
        );

        if (hasExistingReply) {
          logger.log(
            `Already responded to post ${post.id} (found in conversation history), skipping`
          );
          continue;
        }

        logger.log("New Post found", post.id);

        const userId = post.userId;
        if (!userId || !post.id) {
          logger.warn("Skipping post with missing required fields", post.id);
          continue;
        }
        const conversationId = post.conversationId || post.id;
        if (!userId || !post.id) {
          logger.warn("Skipping post with missing required fields", post.id);
          continue;
        }
        const roomId = createUniqueUuid(this.runtime, conversationId || "");
        const username = post.username;

        logger.log("----");
        logger.log(`User: ${username} (${userId})`);
        logger.log(`Post: ${post.id}`);
        logger.log(`Conversation: ${conversationId}`);
        logger.log(`Room: ${roomId}`);
        logger.log("----");

        // 1. Ensure world exists for the user
        const worldId = createUniqueUuid(this.runtime, userId || "");
        await this.runtime.ensureWorldExists({
          id: worldId,
          name: `${username}'s X`,
          agentId: this.runtime.agentId,
          messageServerId: userId as `${string}-${string}-${string}-${string}-${string}`,
          metadata: {
            ownership: { ownerId: userId || "" } as unknown as WorldOwnership,
            extra: {
              x: {
                username: username,
                id: userId,
              },
            },
          },
        });

        // 2. Ensure entity connection
        const entityId = createUniqueUuid(this.runtime, userId);
        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: username,
          name: post.name,
          source: "x",
          type: ChannelType.FEED,
          worldId: worldId,
        });

        // 2.5. Ensure room exists
        await this.runtime.ensureRoomExists({
          id: roomId,
          name: `X conversation ${conversationId}`,
          source: "x",
          type: ChannelType.FEED,
          channelId: conversationId,
          messageServerId: createUniqueUuid(this.runtime, userId),
          worldId: worldId,
        });

        // 3. Create a memory for the post
        // Convert Post to ContentValue-compatible format
        const postContentValue: Record<string, ContentValue> = {
          id: post.id ?? null,
          text: post.text ?? null,
          userId: post.userId ?? null,
          username: post.username ?? null,
          timestamp: post.timestamp ?? null,
          conversationId: post.conversationId ?? null,
        };

        const memory: Memory = {
          id: postId,
          entityId,
          content: {
            text: post.text,
            url: post.permanentUrl,
            source: "x",
            post: postContentValue,
          },
          agentId: this.runtime.agentId,
          roomId,
          createdAt: getEpochMs(post.timestamp),
        };

        logger.log("Saving post memory...");
        await createMemorySafe(this.runtime, memory, "messages");

        // 4. Handle thread-specific events
        if (post.thread && post.thread.length > 0) {
          const threadStartId = post.thread[0].id;
          const threadMemoryId = createUniqueUuid(this.runtime, `thread-${threadStartId}`);

          const threadPayload = {
            runtime: this.runtime,
            source: "x",
            entityId,
            conversationId: threadStartId,
            roomId: roomId,
            memory: memory,
            post: post,
            threadId: threadStartId,
            threadMemoryId: threadMemoryId,
          };

          // Check if this is a reply to an existing thread
          const previousThreadMemory = await this.runtime.getMemoryById(threadMemoryId);
          if (previousThreadMemory) {
            // This is a reply to an existing thread
            this.runtime.emitEvent(XEventTypes.THREAD_UPDATED, threadPayload);
          } else if (post.thread[0].id === post.id) {
            // This is the start of a new thread
            this.runtime.emitEvent(XEventTypes.THREAD_CREATED, threadPayload);
          }
        }

        await this.handlePost({
          post,
          message: memory,
          thread: post.thread,
        });

        // Update the last checked post ID after processing each post
        this.client.lastCheckedPostId = BigInt(post.id);
      }
    }
  }

  /**
   * Handles X interactions such as likes, reposts, and quotes.
   * For each interaction:
   *  - Creates a memory object
   *  - Emits platform-specific events (LIKE_RECEIVED, REPOST_RECEIVED, QUOTE_RECEIVED)
   *  - Emits a generic REACTION_RECEIVED event with metadata
   */
  async handleInteraction(interaction: XInteractionPayload) {
    if (interaction?.targetPost?.conversationId) {
      const memory = this.createMemoryObject(
        interaction.type,
        `${interaction.id}-${interaction.type}`,
        interaction.userId,
        interaction.targetPost.conversationId
      );

      await createMemorySafe(this.runtime, memory, "messages");

      // Create message for reaction
      const reactionMessage: XMemory = {
        id: createUniqueUuid(this.runtime, interaction.targetPostId || ""),
        content: {
          text: interaction.targetPost.text || "",
          source: "x",
        },
        entityId: createUniqueUuid(this.runtime, interaction.userId || ""),
        roomId: createUniqueUuid(this.runtime, interaction.targetPost.conversationId || ""),
        agentId: this.runtime.agentId,
        createdAt: Date.now(),
      };

      // Emit specific event for each type of interaction
      switch (interaction.type) {
        case "like": {
          const payload: XLikeReceivedPayload = {
            runtime: this.runtime,
            post: interaction.targetPost,
            user: {
              id: interaction.userId,
              username: interaction.username,
              name: interaction.name,
            },
            source: "x",
          };
          this.runtime.emitEvent(XEventTypes.LIKE_RECEIVED, payload);
          break;
        }
        case "repost": {
          const payload: XRepostReceivedPayload = {
            runtime: this.runtime,
            post: interaction.targetPost,
            repostId: interaction.repostId || interaction.id,
            user: {
              id: interaction.userId,
              username: interaction.username,
              name: interaction.name,
            },
            source: "x",
          };
          this.runtime.emitEvent(XEventTypes.REPOST_RECEIVED, payload);
          break;
        }
        case "quote": {
          const payload: XQuoteReceivedPayload = {
            runtime: this.runtime,
            quotedPost: interaction.targetPost,
            quotePost: interaction.quotePost || interaction.targetPost,
            user: {
              id: interaction.userId,
              username: interaction.username,
              name: interaction.name,
            },
            message: reactionMessage,
            callback: async () => [],
            reaction: {
              type: "quote",
              entityId: createUniqueUuid(this.runtime, interaction.userId),
            },
            source: "x",
          };
          this.runtime.emitEvent(XEventTypes.QUOTE_RECEIVED, payload);
          break;
        }
      }

      // Also emit generic REACTION_RECEIVED event
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        entityId: createUniqueUuid(this.runtime, interaction.userId),
        roomId: createUniqueUuid(this.runtime, interaction.targetPost.conversationId),
        world: createUniqueUuid(this.runtime, interaction.userId),
        message: reactionMessage,
        source: "x",
        metadata: {
          type: interaction.type,
          targetPostId: interaction.targetPostId,
          username: interaction.username,
          userId: interaction.userId,
          timestamp: Date.now(),
          quoteText: interaction.type === "quote" ? interaction.quotePost?.text || "" : undefined,
        },
        callback: async () => [],
      } as MessagePayload);
    }
  }

  /**
   * Creates a memory object for a given X interaction.
   *
   * @param {string} type - The type of interaction (e.g., 'like', 'repost', 'quote').
   * @param {string} id - The unique identifier for the interaction.
   * @param {string} userId - The ID of the user who initiated the interaction.
   * @param {string} conversationId - The ID of the conversation context.
   * @returns {XInteractionMemory} The constructed memory object.
   */
  createMemoryObject(
    type: string,
    id: string,
    userId: string,
    conversationId: string
  ): XInteractionMemory {
    return {
      id: createUniqueUuid(this.runtime, id),
      agentId: this.runtime.agentId,
      entityId: createUniqueUuid(this.runtime, userId),
      roomId: createUniqueUuid(this.runtime, conversationId),
      content: {
        type,
        source: "x",
      },
      createdAt: Date.now(),
    };
  }

  /**
   * Asynchronously handles a post by generating a response and sending it.
   * This method processes the post content, determines if a response is needed,
   * generates appropriate response text, and sends the post reply.
   *
   * @param {object} params - The parameters object containing the post, message, and thread.
   * @param {Post} params.post - The post object to handle.
   * @param {Memory} params.message - The memory object associated with the post.
   * @param {Post[]} params.thread - The array of posts in the thread.
   * @returns {object} - An object containing the text of the response and any relevant actions.
   */
  async handlePost({
    post,
    message,
    thread,
  }: {
    post: ClientPost;
    message: Memory;
    thread: ClientPost[];
  }) {
    if (!message.content.text) {
      logger.log("Skipping Post with no text", post.id);
      return { text: "", actions: ["IGNORE"] };
    }

    // Create a callback for handling the response
    const callback: HandlerCallback = async (response: Content, postId?: string) => {
      try {
        if (!response.text) {
          logger.warn("No text content in response, skipping post reply");
          return [];
        }

        const postToReplyTo = postId || post.id;

        if (this.isDryRun) {
          logger.info(`[DRY RUN] Would have replied to ${post.username} with: ${response.text}`);
          return [];
        }

        logger.info(`Replying to post ${postToReplyTo}`);

        // Create the actual post using the X API through the client
        const postResult = await sendPost(this.client, response.text, [], postToReplyTo);

        if (!postResult) {
          throw new Error("Failed to get post result from response");
        }

        // Create memory for our response
        const responsePostId = postResult.id || postResult.data?.id || Date.now().toString();
        const responseId = createUniqueUuid(this.runtime, responsePostId);
        const responseMemory: Memory = {
          id: responseId,
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: message.roomId,
          content: {
            text: response.text,
            source: "x",
            inReplyTo: message.id,
          },
          createdAt: Date.now(),
        };

        await createMemorySafe(this.runtime, responseMemory, "messages");

        // Return the created memory
        return [responseMemory];
      } catch (error) {
        logger.error(
          "Error in post reply callback:",
          error instanceof Error ? error.message : String(error)
        );
        return [];
      }
    };

    const xUserId = post.userId || "";
    const entityId = createUniqueUuid(this.runtime, xUserId);
    const xUsername = post.username || "";

    // Add X-specific metadata to message
    if (!message.metadata || Array.isArray(message.metadata)) {
      message.metadata = { type: MemoryType.CUSTOM };
    }
    const metadataObj =
      typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? message.metadata
        : { type: MemoryType.CUSTOM };

    // Create properly typed CustomMetadata with X-specific properties
    // CustomMetadata allows additional properties via index signature
    message.metadata = {
      ...metadataObj,
      type: (metadataObj.type as MemoryType) || MemoryType.CUSTOM,
      x: {
        entityId: entityId as string,
        xUserId: xUserId as string,
        xUsername: xUsername as string,
        thread: thread,
      },
    } as unknown as MemoryMetadata;

    // Process message through message service
    const result = await this.runtime.messageService?.handleMessage(
      this.runtime,
      message,
      callback
    );

    // Extract response for X posting
    const response = result?.responseMessages || [];

    // Check if response is an array of memories and extract the text
    let responseText = "";
    if (Array.isArray(response) && response.length > 0) {
      const firstResponse = response[0];
      if (firstResponse?.content?.text) {
        responseText = firstResponse.content.text;
      }
    }

    return {
      text: responseText,
      actions: responseText ? ["REPLY"] : ["IGNORE"],
    };
  }
}
