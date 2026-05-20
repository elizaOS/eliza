/**
 * CHECK_POST_DETAIL Action
 *
 * Returns detailed information about a post including all comments with thread structure.
 * Shows IDs for each comment so agent can reference them for replies.
 */

import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  isNull,
  posts,
  shares,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import type { MessageTag } from '@feed/shared';
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '../../../../shared/logger';

/** Extended ActionResult with optional tag for UI */
interface ActionResultWithTag extends ActionResult {
  tag?: MessageTag;
}

interface CommentWithAuthor {
  id: string;
  content: string;
  authorId: string;
  parentCommentId: string | null;
  createdAt: Date;
  authorName: string;
  authorProfileImageUrl?: string | null;
}

interface CommentThread {
  id: string;
  author: string;
  content: string;
  depth: number;
  createdAt: Date;
  replies: CommentThread[];
}

/**
 * Build a tree structure from flat comments
 */
function buildCommentTree(flatComments: CommentWithAuthor[]): CommentThread[] {
  const commentMap = new Map<string, CommentThread>();
  const rootComments: CommentThread[] = [];

  // First pass: create all comment nodes
  for (const comment of flatComments) {
    commentMap.set(comment.id, {
      id: comment.id,
      author: comment.authorName,
      content: comment.content,
      depth: 0,
      createdAt: comment.createdAt,
      replies: [],
    });
  }

  // Second pass: build tree structure
  for (const comment of flatComments) {
    const node = commentMap.get(comment.id);
    if (!node) continue;

    if (comment.parentCommentId) {
      const parent = commentMap.get(comment.parentCommentId);
      if (parent) {
        node.depth = parent.depth + 1;
        parent.replies.push(node);
      } else {
        // Parent not found, treat as root
        rootComments.push(node);
      }
    } else {
      rootComments.push(node);
    }
  }

  // Sort by createdAt
  rootComments.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return rootComments;
}

/**
 * Format comment tree for display with explicit "Reply to [id]" format
 */
function formatCommentTree(
  threads: CommentThread[],
  maxDepth = 10
): {
  formatted: string;
} {
  const lines: string[] = [];

  function traverse(
    node: CommentThread,
    depth: number,
    parentId: string | null
  ) {
    if (depth > maxDepth) return;

    const truncatedContent =
      node.content.length > 150
        ? `${node.content.substring(0, 150)}...`
        : node.content;

    // Format: "Comment" for top-level, "Reply to [parentId]" for replies
    const prefix =
      parentId === null
        ? `- Comment [ID: ${node.id}]`
        : `- Reply to ${parentId} [ID: ${node.id}]`;

    lines.push(`${prefix} by @${node.author}: "${truncatedContent}"`);

    // Sort replies by time
    const sortedReplies = [...node.replies].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    for (const reply of sortedReplies) {
      traverse(reply, depth + 1, node.id);
    }
  }

  for (const thread of threads) {
    traverse(thread, 0, null);
  }

  return { formatted: lines.join('\n') };
}

export const checkPostDetailAction: Action = {
  name: 'CHECK_POST_DETAIL',
  description:
    'Get detailed information about a post including all comments with thread structure.',

  parameters: {
    postId: {
      type: 'string',
      description: 'The ID of the post to retrieve',
      required: true,
    },
  } as unknown as Action['parameters'],

  examples: [
    [
      {
        name: 'user',
        content: { text: 'Show me post 123456' },
      },
      {
        name: 'assistant',
        content: { text: 'Let me get the details of that post...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'What are people saying on that post?' },
      },
      {
        name: 'assistant',
        content: { text: "I'll check the comments on that post..." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { postId?: string }
      | undefined;
    const postId = actionParams?.postId;

    if (!postId) {
      return {
        success: false,
        text: 'Missing postId parameter. Please provide the post ID.',
        error: 'Missing postId',
      };
    }

    try {
      // Get post with author
      const [post] = await db
        .select({
          id: posts.id,
          content: posts.content,
          authorId: posts.authorId,
          createdAt: posts.createdAt,
          authorUsername: users.username,
          authorDisplayName: users.displayName,
          authorProfileImageUrl: users.profileImageUrl,
        })
        .from(posts)
        .leftJoin(users, eq(posts.authorId, users.id))
        .where(eq(posts.id, postId))
        .limit(1);

      if (!post) {
        return {
          success: false,
          text: `Post not found with ID: ${postId}`,
          error: 'Post not found',
        };
      }

      // Get all comments on this post
      const postComments = await db
        .select({
          id: comments.id,
          content: comments.content,
          authorId: comments.authorId,
          parentCommentId: comments.parentCommentId,
          createdAt: comments.createdAt,
          authorUsername: users.username,
          authorDisplayName: users.displayName,
          authorProfileImageUrl: users.profileImageUrl,
        })
        .from(comments)
        .leftJoin(users, eq(comments.authorId, users.id))
        .where(and(eq(comments.postId, postId), isNull(comments.deletedAt)))
        .orderBy(desc(comments.createdAt));

      // Helper to get author info from StaticDataRegistry or user data
      const getAuthorInfo = (
        authorId: string,
        userDisplayName: string | null,
        userUsername: string | null,
        userProfileImageUrl: string | null
      ): { name: string; profileImageUrl: string | null } => {
        // Check if this is an actor/NPC
        const actor = StaticDataRegistry.getActor(authorId);
        if (actor) {
          return {
            name: actor.name,
            profileImageUrl: actor.profileImageUrl || null,
          };
        }

        // Check if this is an organization
        const org = StaticDataRegistry.getOrganization(authorId);
        if (org) {
          return {
            name: org.name,
            profileImageUrl: org.imageUrl || null,
          };
        }

        // Fall back to user data
        return {
          name: userDisplayName || userUsername || 'Unknown',
          profileImageUrl: userProfileImageUrl,
        };
      };

      // Transform to our format
      const commentsWithAuthor: CommentWithAuthor[] = postComments.map(
        (c: (typeof postComments)[number]) => {
          const authorInfo = getAuthorInfo(
            c.authorId,
            c.authorDisplayName,
            c.authorUsername,
            c.authorProfileImageUrl
          );
          return {
            id: c.id,
            content: c.content,
            authorId: c.authorId,
            parentCommentId: c.parentCommentId,
            createdAt: c.createdAt,
            authorName: authorInfo.name,
            authorProfileImageUrl: authorInfo.profileImageUrl,
          };
        }
      );

      // Build comment tree
      const commentTree = buildCommentTree(commentsWithAuthor);
      const { formatted: formattedComments } = formatCommentTree(commentTree);

      // Get share count
      const [shareResult] = await db
        .select({ count: count() })
        .from(shares)
        .where(eq(shares.postId, postId));
      const shareCount = shareResult?.count ?? 0;

      // Get post author info
      const postAuthorInfo = getAuthorInfo(
        post.authorId,
        post.authorDisplayName,
        post.authorUsername,
        post.authorProfileImageUrl
      );
      const postAuthorName = postAuthorInfo.name;
      const postAuthorProfileImageUrl = postAuthorInfo.profileImageUrl;

      // Build formatted view
      const formattedView = `POST [ID: ${post.id}] by @${postAuthorName}:
"${post.content.substring(0, 500)}${post.content.length > 500 ? '...' : ''}"

${postComments.length > 0 ? `COMMENTS (${postComments.length}):\n${formattedComments}` : 'No comments yet.'}`;

      logger.info(
        `[CHECK_POST_DETAIL] Retrieved post ${postId} with ${postComments.length} comments`,
        undefined,
        'CheckPostDetail'
      );

      return {
        success: true,
        text: `Retrieved post with ${postComments.length} comments.`,
        data: {
          post: {
            id: post.id,
            content: post.content,
            author: postAuthorName,
            authorId: post.authorId,
            authorProfileImageUrl: postAuthorProfileImageUrl,
            createdAt: post.createdAt.toISOString(),
          },
          comments: commentsWithAuthor,
        },
        values: {
          formattedView,
          postId: post.id,
          commentCount: postComments.length,
          shareCount,
        },
        // Tag for sidebar display (simplified - no comments)
        tag: {
          type: 'post',
          label: 'Post',
          icon: 'FileText',
          entityId: post.id,
          data: {
            post: {
              id: post.id,
              content: post.content,
              author: postAuthorName,
              authorId: post.authorId,
              authorProfileImageUrl: postAuthorProfileImageUrl,
              createdAt: post.createdAt.toISOString(),
            },
            commentCount: postComments.length,
            shareCount,
          },
        },
      } as ActionResultWithTag;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[CHECK_POST_DETAIL] Error:', errorMsg);

      return {
        success: false,
        text: `Failed to retrieve post: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
