import {
  ChannelType,
  composePromptFromState,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { Client, Post } from "./client/index";
import { quotePostTemplate, replyPostTemplate, xActionTemplate } from "./templates";
import type { ActionResponse } from "./types";
import { parseActionResponseFromText, sendPost } from "./utils";
import { createMemorySafe, ensureXContext, isPostProcessed } from "./utils/memory";
import { getSetting } from "./utils/settings";
import { getEpochMs } from "./utils/time";

enum TIMELINE_TYPE {
  ForYou = "foryou",
  Following = "following",
}

export class XTimelineClient {
  client: ClientBase;
  xClient: Client;
  runtime: IAgentRuntime;
  isDryRun: boolean;
  timelineType: TIMELINE_TYPE;
  private state: Record<string, unknown>;
  private isRunning: boolean = false;

  constructor(client: ClientBase, runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.client = client;
    this.xClient = client.xClient;
    this.runtime = runtime;
    this.state = state;

    const dryRunSetting =
      this.state?.X_DRY_RUN ?? getSetting(this.runtime, "X_DRY_RUN") ?? process.env.X_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
      dryRunSetting === "true" ||
      (typeof dryRunSetting === "string" && dryRunSetting.toLowerCase() === "true");

    // Load timeline mode from runtime settings or use default
    const timelineMode = getSetting(this.runtime, "X_TIMELINE_MODE") ?? process.env.X_TIMELINE_MODE;
    this.timelineType =
      timelineMode === TIMELINE_TYPE.Following ? TIMELINE_TYPE.Following : TIMELINE_TYPE.ForYou;
  }

  async start() {
    logger.info("Starting X timeline client...");
    this.isRunning = true;

    const handleXTimelineLoop = () => {
      if (!this.isRunning) {
        logger.info("X timeline client stopped, exiting loop");
        return;
      }

      // Use standard engagement interval
      const engagementIntervalMinutes = parseInt(
        (typeof this.state?.X_ENGAGEMENT_INTERVAL === "string"
          ? this.state.X_ENGAGEMENT_INTERVAL
          : null) ||
          (getSetting(this.runtime, "X_ENGAGEMENT_INTERVAL") as string) ||
          process.env.X_ENGAGEMENT_INTERVAL ||
          "30",
        10
      );
      const actionInterval = engagementIntervalMinutes * 60 * 1000;

      logger.info(`Timeline client will check every ${engagementIntervalMinutes} minutes`);

      this.handleTimeline();

      if (this.isRunning) {
        setTimeout(handleXTimelineLoop, actionInterval);
      }
    };
    handleXTimelineLoop();
  }

  async stop() {
    logger.info("Stopping X timeline client...");
    this.isRunning = false;
  }

  async getTimeline(count: number): Promise<Post[]> {
    const xUsername = this.client.profile?.username;
    const homeTimeline =
      this.timelineType === TIMELINE_TYPE.Following
        ? await this.xClient.fetchFollowingTimeline(count, [])
        : await this.xClient.fetchHomeTimeline(count, []);

    // The timeline methods now return Post objects directly from v2 API
    return homeTimeline.filter((post) => post.username !== xUsername); // do not perform action on self-posts
  }

  createPostId(runtime: IAgentRuntime, post: Post) {
    if (!post.id) {
      throw new Error("Post ID is required");
    }
    return createUniqueUuid(runtime, post.id);
  }

  formMessage(runtime: IAgentRuntime, post: Post) {
    if (!post.id || !post.userId || !post.conversationId) {
      throw new Error("Post missing required fields: id, userId, or conversationId");
    }
    return {
      id: this.createPostId(runtime, post),
      agentId: runtime.agentId,
      content: {
        text: post.text,
        url: post.permanentUrl,
        imageUrls: post.photos?.map((photo) => photo.url) || [],
        inReplyTo: post.inReplyToStatusId
          ? createUniqueUuid(runtime, post.inReplyToStatusId)
          : undefined,
        source: "x",
        channelType: ChannelType.GROUP,
        post: {
          id: post.id,
          text: post.text,
          userId: post.userId,
          username: post.username,
          timestamp: post.timestamp,
          conversationId: post.conversationId,
        } as Record<string, string | number | boolean | null | undefined>,
      },
      entityId: createUniqueUuid(runtime, post.userId),
      roomId: createUniqueUuid(runtime, post.conversationId),
      createdAt: getEpochMs(post.timestamp),
    };
  }

  async handleTimeline() {
    logger.info("Starting X timeline processing...");

    const posts = await this.getTimeline(20);
    logger.info(`Fetched ${posts.length} posts from timeline`);

    // Use max engagements per run from environment
    const maxActionsPerCycle = parseInt(
      (getSetting(this.runtime, "X_MAX_ENGAGEMENTS_PER_RUN") as string) ||
        process.env.X_MAX_ENGAGEMENTS_PER_RUN ||
        "10",
      10
    );

    const postDecisions: Array<{
      post: Post;
      actionResponse: ActionResponse;
      postState: State;
      roomId: UUID;
    }> = [];
    for (const post of posts) {
      try {
        // Check if already processed using utility
        if (!post.id) {
          logger.warn("Skipping post with no ID");
          continue;
        }
        const isProcessed = await isPostProcessed(this.runtime, post.id);
        if (isProcessed) {
          logger.log(`Already processed post ID: ${post.id}`);
          continue;
        }

        if (!post.conversationId) {
          logger.warn("Skipping post with no conversationId");
          continue;
        }
        const roomId = createUniqueUuid(this.runtime, post.conversationId);

        const message = this.formMessage(this.runtime, post);

        const state = await this.runtime.composeState(message);

        const actionRespondPrompt =
          composePromptFromState({
            state,
            template: this.runtime.character.templates?.xActionTemplate || xActionTemplate,
          }) +
          `
Post:
${post.text}

# Respond with qualifying action tags only.

Choose any combination of [LIKE], [REPOST], [QUOTE], and [REPLY] that are appropriate. Each action must be on its own line. Your response must only include the chosen actions.`;

        const actionResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: actionRespondPrompt,
        });
        const parsedResponse = parseActionResponseFromText(actionResponse);

        // Ensure a valid action response was generated
        if (!parsedResponse || !parsedResponse.actions) {
          logger.debug(`No action response generated for post ${post.id}`);
          continue;
        }

        postDecisions.push({
          post,
          actionResponse: parsedResponse.actions,
          postState: state,
          roomId,
        });

        // Limit the number of actions per cycle
        if (postDecisions.length >= maxActionsPerCycle) break;
      } catch (error) {
        logger.error(
          `Error processing post ${post.id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Rank by the quality of the response
    const rankByActionRelevance = (arr: typeof postDecisions) => {
      return arr.sort((a, b) => {
        const countTrue = (obj: typeof a.actionResponse) =>
          Object.values(obj).filter(Boolean).length;

        const countA = countTrue(a.actionResponse);
        const countB = countTrue(b.actionResponse);

        // Primary sort by number of true values
        if (countA !== countB) {
          return countB - countA;
        }

        // Secondary sort by the "like" property
        if (a.actionResponse.like !== b.actionResponse.like) {
          return a.actionResponse.like ? -1 : 1;
        }

        // Tertiary sort keeps the remaining objects with equal weight
        return 0;
      });
    };
    // Sort the timeline based on the action decision score,
    const prioritizedPosts = rankByActionRelevance(postDecisions);

    logger.info(`Processing ${prioritizedPosts.length} posts with actions`);
    if (prioritizedPosts.length > 0) {
      const actionSummary = prioritizedPosts.map((td: (typeof postDecisions)[0]) => {
        const actions = [];
        if (td.actionResponse.like) actions.push("LIKE");
        if (td.actionResponse.repost) actions.push("REPOST");
        if (td.actionResponse.quote) actions.push("QUOTE");
        if (td.actionResponse.reply) actions.push("REPLY");
        return `Post ${td.post.id}: ${actions.join(", ")}`;
      });
      logger.info(`Actions to execute:\n${actionSummary.join("\n")}`);
    }

    await this.processTimelineActions(prioritizedPosts);
    logger.info("Timeline processing complete");
  }

  private async processTimelineActions(
    postDecisions: {
      post: Post;
      actionResponse: ActionResponse;
      postState: State;
      roomId: UUID;
    }[]
  ): Promise<
    {
      postId: string;
      actionResponse: ActionResponse;
      executedActions: string[];
    }[]
  > {
    const results = [];

    for (const { post, actionResponse, postState: _postState, roomId } of postDecisions) {
      const postId = this.createPostId(this.runtime, post);
      const executedActions = [];

      // Ensure room exists before creating memory
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: `X conversation ${post.conversationId}`,
        source: "x",
        type: ChannelType.GROUP,
        channelId: post.conversationId,
        messageServerId: createUniqueUuid(this.runtime, post.userId || ""),
        worldId: createUniqueUuid(this.runtime, post.userId || ""),
      });

      // Update memory with processed post using safe method
      if (!post.userId) {
        logger.warn("Skipping post with no userId");
        continue;
      }
      const postMemory: Memory = {
        id: postId,
        entityId: createUniqueUuid(this.runtime, post.userId),
        content: {
          text: post.text,
          url: post.permanentUrl,
          source: "x",
          channelType: ChannelType.GROUP,
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
        roomId,
        createdAt: getEpochMs(post.timestamp),
      };

      await createMemorySafe(this.runtime, postMemory, "messages");

      try {
        // ensure world and rooms, connections, and worlds are created
        const userId = post.userId;
        if (!userId) {
          logger.warn("Cannot create world/entity: userId is undefined");
          continue;
        }
        const worldId = createUniqueUuid(this.runtime, userId);
        const entityId = createUniqueUuid(this.runtime, userId);

        await this.ensurePostWorldContext(post, roomId, worldId, entityId);

        if (actionResponse.like) {
          await this.handleLikeAction(post);
          executedActions.push("like");
        }

        if (actionResponse.repost) {
          await this.handleRepostAction(post);
          executedActions.push("repost");
        }

        if (actionResponse.quote) {
          await this.handleQuoteAction(post);
          executedActions.push("quote");
        }

        if (actionResponse.reply) {
          await this.handleReplyAction(post);
          executedActions.push("reply");
        }

        if (post.id) {
          results.push({ postId: post.id, actionResponse, executedActions });
        }
      } catch (error) {
        logger.error(
          `Error processing actions for post ${post.id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return results;
  }

  private async ensurePostWorldContext(post: Post, _roomId: UUID, _worldId: UUID, _entityId: UUID) {
    try {
      // Use the utility function for consistency
      if (!post.userId || !post.username || !post.conversationId) {
        logger.warn("Cannot ensure context: missing required post fields");
        return;
      }
      await ensureXContext(this.runtime, {
        userId: post.userId,
        username: post.username,
        name: post.name,
        conversationId: post.conversationId,
      });
    } catch (error) {
      logger.error(
        `Failed to ensure context for post ${post.id}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't fail the entire timeline processing
    }
  }

  async handleLikeAction(post: Post) {
    try {
      if (this.isDryRun) {
        logger.log(`[DRY RUN] Would have liked post ${post.id}`);
        return;
      }
      if (!post.id) {
        logger.warn("Cannot like post: missing post ID");
        return;
      }
      await this.xClient.likePost(post.id);
      logger.log(`Liked post ${post.id}`);
    } catch (error) {
      logger.error(
        `Error liking post ${post.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async handleRepostAction(post: Post) {
    try {
      if (this.isDryRun) {
        logger.log(`[DRY RUN] Would have reposted post ${post.id}`);
        return;
      }
      if (!post.id) {
        logger.warn("Cannot repost: missing post ID");
        return;
      }
      await this.xClient.repost(post.id);
      logger.log(`Reposted post ${post.id}`);
    } catch (error) {
      logger.error(
        `Error reposting post ${post.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async handleQuoteAction(post: Post) {
    try {
      const message = this.formMessage(this.runtime, post);

      const state = await this.runtime.composeState(message);

      const quotePrompt =
        composePromptFromState({
          state,
          template: this.runtime.character.templates?.quotePostTemplate || quotePostTemplate,
        }) +
        `
You are responding to this post:
${post.text}`;

      const quoteResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: quotePrompt,
      });
      const responseObject = parseKeyValueXml(quoteResponse);

      const postText = responseObject?.post;
      if (postText && typeof postText === "string") {
        if (this.isDryRun) {
          logger.log(`[DRY RUN] Would have quoted post ${post.id} with: ${postText}`);
          return;
        }

        if (!post.id) {
          logger.error("Cannot send quote post: post.id is undefined");
          return;
        }
        const postTextValue = postText; // Capture for closure
        const postIdValue = post.id; // Capture for closure
        const result = await this.client.requestQueue.add(
          async () => await this.xClient.sendQuotePost(postTextValue, postIdValue)
        );

        const body = (await result.json()) as {
          data?: {
            create_post?: { post_results?: { result?: { id?: string } } };
          };
          id?: string;
        };

        const postResult = body?.data?.create_post?.post_results?.result || body?.data || body;
        if (postResult) {
          logger.log("Successfully posted quote");
        } else {
          logger.error("Quote post creation failed:", body);
        }

        // Create memory for our response
        const postResultWithId = postResult as { id?: string };
        const postId = postResultWithId?.id || Date.now().toString();
        const responseId = createUniqueUuid(this.runtime, postId);
        const responseMemory: Memory = {
          id: responseId,
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: message.roomId,
          content: {
            text: responseObject.post as string,
            inReplyTo: message.id,
          },
          createdAt: Date.now(),
        };

        // Save the response to memory with error handling
        await createMemorySafe(this.runtime, responseMemory, "messages");
      }
    } catch (error) {
      logger.error(
        "Error in quote post generation:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async handleReplyAction(post: Post) {
    try {
      const message = this.formMessage(this.runtime, post);

      const state = await this.runtime.composeState(message);

      const replyPrompt =
        composePromptFromState({
          state,
          template: this.runtime.character.templates?.replyPostTemplate || replyPostTemplate,
        }) +
        `
You are replying to this post:
${post.text}`;

      const replyResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: replyPrompt,
      });
      const responseObject = parseKeyValueXml(replyResponse);

      if (responseObject?.post && typeof responseObject.post === "string") {
        if (this.isDryRun) {
          logger.log(
            `[DRY RUN] Would have replied to post ${post.id} with: ${responseObject.post}`
          );
          return;
        }

        const result = await sendPost(this.client, responseObject.post as string, [], post.id);

        if (result) {
          logger.log("Successfully posted reply");

          // Create memory for our response
          const replyPostId = result.id || result.data?.id || Date.now().toString();
          const responseId = createUniqueUuid(this.runtime, replyPostId);
          const responseMemory: Memory = {
            id: responseId,
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId: message.roomId,
            content: {
              ...responseObject,
              inReplyTo: message.id,
            },
            createdAt: Date.now(),
          };

          // Save the response to memory with error handling
          await createMemorySafe(this.runtime, responseMemory, "messages");
        }
      }
    } catch (error) {
      logger.error(
        "Error in reply generation:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
