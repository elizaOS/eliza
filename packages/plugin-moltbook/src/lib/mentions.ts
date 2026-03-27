/**
 * Mention Detection and Reply Handling
 *
 * ## WHY THIS MODULE?
 *
 * Moltbook doesn't have webhooks or push notifications. We need to poll for:
 * 1. Comments on our posts - People replying to things we posted
 * 2. Mentions in comments - Someone @mentioning our agent
 *
 * This module handles:
 * - Fetching comments on agent's posts
 * - Detecting new/unseen comments
 * - Converting them to Memory objects
 * - Emitting events for core to process
 *
 * ## WHY POLLING?
 *
 * Without webhooks, polling is the only option. We rate-limit this to be
 * respectful of the Moltbook API and to avoid IP bans.
 */

import type { Content, HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { createUniqueUuid, EventType } from "@elizaos/core";
import type { MoltbookService } from "../service";
import type { MoltbookComment, MoltbookPost } from "../types";

/**
 * Key prefix for tracking which comments we've seen/processed
 */
const SEEN_COMMENT_PREFIX = "moltbook_seen_comment";

/**
 * Key for tracking which posts we've created (to check for replies)
 */
const MY_POSTS_KEY = "moltbook_my_posts";

/**
 * Metadata stored when we see a comment
 */
interface SeenCommentMetadata {
  type: "moltbook_seen_comment";
  commentId: string;
  postId: string;
  seenAt: number;
  processed: boolean;
  responded: boolean;
}

/**
 * Metadata for tracking our own posts
 */
interface MyPostMetadata {
  type: "moltbook_my_post";
  postId: string;
  title: string;
  createdAt: number;
}

/**
 * A mention or reply that needs handling
 */
export interface MentionEvent {
  type: "reply" | "mention";
  comment: MoltbookComment;
  post: MoltbookPost;
  /** If this is a reply to our comment specifically */
  parentComment?: MoltbookComment;
}

/**
 * Record that we created a post, so we can check for replies later
 *
 * WHY TRACK OUR POSTS?
 * We only want to monitor posts WE created for replies.
 * Tracking allows efficient polling - we only check our posts.
 */
export async function recordMyPost(runtime: IAgentRuntime, post: MoltbookPost): Promise<void> {
  const memoryId = createUniqueUuid(runtime, `${MY_POSTS_KEY}_${post.id}`);

  const metadata: MyPostMetadata = {
    type: "moltbook_my_post",
    postId: post.id,
    title: post.title,
    createdAt: Date.now(),
  };

  await runtime.createMemory(
    {
      id: memoryId,
      agentId: runtime.agentId,
      roomId: runtime.agentId, // Agent's own room
      entityId: runtime.agentId,
      content: {
        text: `Created Moltbook post: "${post.title}"`,
        metadata: metadata as any,
      },
    },
    "moltbook_my_posts"
  );

  runtime.logger.debug(
    { postId: post.id, title: post.title },
    "Moltbook: Recorded my post for reply monitoring"
  );
}

/**
 * Get list of posts we've created (to monitor for replies)
 */
export async function getMyPosts(
  runtime: IAgentRuntime
): Promise<{ postId: string; title: string }[]> {
  try {
    const memories = await runtime.getMemories({
      tableName: "moltbook_my_posts",
      roomId: runtime.agentId,
      count: 50, // Recent posts only
    });

    return memories
      .filter((m) => (m.content.metadata as any)?.type === "moltbook_my_post")
      .map((m) => {
        const meta = m.content.metadata as any as MyPostMetadata;
        return { postId: meta.postId, title: meta.title };
      });
  } catch (error) {
    runtime.logger.error({ error }, "Moltbook: Failed to get my posts");
    return [];
  }
}

/**
 * Check if we've already processed a comment
 */
async function hasSeenComment(runtime: IAgentRuntime, commentId: string): Promise<boolean> {
  const memoryId = createUniqueUuid(runtime, `${SEEN_COMMENT_PREFIX}_${commentId}`);

  try {
    const memory = await runtime.getMemoryById(memoryId);
    return !!memory;
  } catch {
    return false;
  }
}

/**
 * Mark a comment as seen/processed
 */
async function markCommentSeen(
  runtime: IAgentRuntime,
  comment: MoltbookComment,
  processed: boolean,
  responded: boolean
): Promise<void> {
  const memoryId = createUniqueUuid(runtime, `${SEEN_COMMENT_PREFIX}_${comment.id}`);

  const metadata: SeenCommentMetadata = {
    type: "moltbook_seen_comment",
    commentId: comment.id,
    postId: comment.postId,
    seenAt: Date.now(),
    processed,
    responded,
  };

  await runtime.createMemory(
    {
      id: memoryId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
      content: {
        text: `Seen comment by @${comment.author.username}: ${comment.content.slice(0, 100)}`,
        metadata: metadata as any,
      },
    },
    "moltbook_seen_comments"
  );
}

/**
 * Poll for new mentions and replies on our posts
 *
 * WHY THIS APPROACH?
 * 1. Get list of our posts
 * 2. For each post, fetch recent comments
 * 3. Filter to comments we haven't seen
 * 4. Detect mentions of our username
 * 5. Return as MentionEvents for processing
 */
export async function pollForMentions(
  runtime: IAgentRuntime,
  service: MoltbookService
): Promise<MentionEvent[]> {
  const mentions: MentionEvent[] = [];

  // Get our profile to know our username
  const profile = await service.getOwnProfile();
  if (!profile) {
    runtime.logger.debug("Moltbook: No profile found, skipping mention poll");
    return [];
  }

  const myUsername = profile.username.toLowerCase();

  // Get posts we've created
  const myPosts = await getMyPosts(runtime);

  if (myPosts.length === 0) {
    runtime.logger.debug("Moltbook: No posts to monitor for replies");
    return [];
  }

  runtime.logger.debug({ postCount: myPosts.length }, "Moltbook: Polling for mentions on my posts");

  // Check each post for new comments
  for (const { postId } of myPosts.slice(0, 10)) {
    // Only check recent 10 posts
    try {
      const post = await service.getPost(postId);
      if (!post) continue;

      const comments = await service.getComments(postId);

      for (const comment of comments) {
        // Skip our own comments
        if (comment.author.username.toLowerCase() === myUsername) {
          continue;
        }

        // Skip already seen comments
        if (await hasSeenComment(runtime, comment.id)) {
          continue;
        }

        // Determine if this is a mention or reply
        const isMention = comment.content.toLowerCase().includes(`@${myUsername}`);

        // Any comment on our post is considered a "reply" to us
        mentions.push({
          type: isMention ? "mention" : "reply",
          comment,
          post,
        });

        // Also check nested replies
        if (comment.replies) {
          for (const reply of comment.replies) {
            if (reply.author.username.toLowerCase() === myUsername) {
              continue;
            }

            if (await hasSeenComment(runtime, reply.id)) {
              continue;
            }

            const isReplyMention = reply.content.toLowerCase().includes(`@${myUsername}`);

            mentions.push({
              type: isReplyMention ? "mention" : "reply",
              comment: reply,
              post,
              parentComment: comment,
            });
          }
        }
      }
    } catch (error) {
      runtime.logger.warn({ error, postId }, "Moltbook: Failed to check post for mentions");
    }
  }

  runtime.logger.debug({ mentionCount: mentions.length }, "Moltbook: Found new mentions/replies");

  return mentions;
}

/**
 * Convert a Moltbook comment to an elizaOS Memory for processing
 *
 * WHY CONVERT TO MEMORY?
 * elizaOS processes all interactions as Memory objects.
 * Converting allows us to use the standard message handling pipeline,
 * so the agent responds to Moltbook comments like any other message.
 */
export function commentToMemory(runtime: IAgentRuntime, mention: MentionEvent): Memory {
  // Create deterministic room ID for Moltbook post conversations
  const roomId = createUniqueUuid(runtime, `moltbook_post_${mention.post.id}`);

  // Create deterministic entity ID for the commenter
  const entityId = createUniqueUuid(runtime, `moltbook_user_${mention.comment.authorId}`);

  // Create deterministic memory ID for this comment
  const memoryId = createUniqueUuid(runtime, `moltbook_comment_${mention.comment.id}`);

  return {
    id: memoryId,
    agentId: runtime.agentId,
    roomId,
    entityId,
    content: {
      text: mention.comment.content,
      source: "moltbook",
      metadata: {
        platform: "moltbook",
        commentId: mention.comment.id,
        postId: mention.post.id,
        postTitle: mention.post.title,
        authorId: mention.comment.authorId,
        authorUsername: mention.comment.author.username,
        parentCommentId: mention.parentComment?.id,
        mentionType: mention.type,
        isReply: mention.type === "reply",
        isMention: mention.type === "mention",
        upvotes: mention.comment.upvotes,
        downvotes: mention.comment.downvotes,
        createdAt: mention.comment.createdAt,
      },
    },
  };
}

/**
 * Process mentions by emitting MESSAGE_RECEIVED events
 *
 * WHY EMIT EVENTS?
 * This integrates with elizaOS's standard message handling.
 * The bootstrap plugin will pick up these events and handle responses.
 */
export async function processMentions(
  runtime: IAgentRuntime,
  service: MoltbookService,
  mentions: MentionEvent[]
): Promise<number> {
  let processed = 0;

  for (const mention of mentions) {
    try {
      // Convert to Memory
      const memory = commentToMemory(runtime, mention);

      // Create a callback that will post the reply to Moltbook
      const callback: HandlerCallback = async (response: Content): Promise<Memory[]> => {
        if (!response.text) return [];

        runtime.logger.info(
          {
            postId: mention.post.id,
            commentId: mention.comment.id,
            responseLength: response.text.length,
          },
          "Moltbook: Sending reply to comment"
        );

        // Post reply as a comment
        const result = await service.createComment(
          mention.post.id,
          response.text,
          mention.comment.id // Reply to the specific comment
        );

        if (result) {
          runtime.logger.info(
            { newCommentId: result.id },
            "Moltbook: Successfully replied to comment"
          );
        }

        // Return empty array - the message service handles memory creation
        return [];
      };

      // Try using messageService (preferred) or emit event (fallback)
      if (runtime.messageService) {
        await runtime.messageService.handleMessage(runtime, memory, callback);
      } else {
        // Fallback to event emission
        await runtime.emitEvent([EventType.MESSAGE_RECEIVED], {
          runtime,
          message: memory,
          callback,
          source: "moltbook",
        });
      }

      // Mark as seen and processed
      await markCommentSeen(runtime, mention.comment, true, true);
      processed++;
    } catch (error) {
      runtime.logger.error(
        { error, commentId: mention.comment.id },
        "Moltbook: Failed to process mention"
      );

      // Mark as seen but not successfully processed
      await markCommentSeen(runtime, mention.comment, false, false);
    }
  }

  return processed;
}
