/**
 * Check Feed Posts Action (Coordinator)
 *
 * Returns the latest posts from the global feed.
 * Similar to what users see on the /feed page.
 */

import type { MessageTag } from '@feed/shared';
import { getTimeAgo } from '@feed/shared';
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '../../../../shared/logger';

/** Extended ActionResult with optional tag for UI */
interface ActionResultWithTag extends ActionResult {
  tag?: MessageTag;
}

/** Options for check feed posts action */
interface CheckFeedPostsOptions extends HandlerOptions {
  limit?: number;
}

interface FeedPost {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string;
  authorProfileImageUrl?: string | null;
  timestamp: string;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
}

interface FeedApiResponse {
  success: boolean;
  posts: FeedPost[];
  limit: number;
  cursor: string | null;
  hasMore: boolean;
}

export const checkFeedPostsAction: Action = {
  name: 'CHECK_FEED_POSTS',
  description:
    'Check the latest posts from the global feed. Help users discover trending content and community discussions.',

  parameters: {
    limit: {
      type: 'number',
      description: 'Number of posts to retrieve (default: 10, max: 50)',
      required: false,
    },
  } as unknown as Action['parameters'],

  examples: [
    [
      {
        name: 'user',
        content: { text: "What's happening on the feed?" },
      },
      {
        name: 'coordinator',
        content: { text: 'Let me check the latest posts on the feed...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Show me the latest 5 posts' },
      },
      {
        name: 'coordinator',
        content: { text: "I'll fetch the 5 most recent posts for you." },
      },
    ],
    [
      {
        name: 'user',
        content: { text: "What's trending right now?" },
      },
      {
        name: 'coordinator',
        content: { text: 'Let me check the recent activity on the feed...' },
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
    _options?: CheckFeedPostsOptions,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | CheckFeedPostsOptions
      | undefined;

    // Limit between 1 and 50, default to 10
    const limit = Math.min(Math.max(actionParams?.limit ?? 10, 1), 50);

    // Fetch posts from the API with timeout to prevent hanging
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/posts?limit=${limit}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return {
        success: false,
        text: `Failed to fetch feed: ${response.status}`,
        error: `HTTP ${response.status}`,
      };
    }

    const rawData: unknown = await response.json();

    // Runtime validation of API response structure
    if (
      typeof rawData !== 'object' ||
      rawData === null ||
      !('success' in rawData) ||
      typeof (rawData as Record<string, unknown>).success !== 'boolean' ||
      !('posts' in rawData) ||
      !Array.isArray((rawData as Record<string, unknown>).posts)
    ) {
      return {
        success: false,
        text: 'Failed to retrieve feed posts.',
        error: 'Invalid API response: missing required fields',
      };
    }

    const data = rawData as FeedApiResponse;

    if (!data.success) {
      return {
        success: false,
        text: 'Failed to retrieve feed posts.',
        error: 'API returned unsuccessful response',
      };
    }

    const feedPosts = data.posts;

    if (feedPosts.length === 0) {
      return {
        success: true,
        text: 'The feed is empty. No posts yet.',
        data: { posts: [], count: 0 },
        values: { count: 0 },
      };
    }

    // Format posts for display
    const formattedPosts = feedPosts.map((post, i) => ({
      index: i + 1,
      id: post.id,
      content: post.content,
      authorName: post.authorName || post.authorUsername || 'Unknown',
      authorId: post.authorId,
      authorProfileImageUrl: post.authorProfileImageUrl,
      timeAgo: getTimeAgo(new Date(post.timestamp)),
      likeCount: post.likeCount ?? 0,
      commentCount: post.commentCount ?? 0,
      shareCount: post.shareCount ?? 0,
    }));

    logger.info(
      `[CHECK_FEED_POSTS] Retrieved ${feedPosts.length} posts from feed`,
      undefined,
      'CheckFeedPosts'
    );

    // Build a summary text
    const postSummaries = formattedPosts
      .slice(0, 5)
      .map(
        (p) =>
          `${p.index}. @${p.authorName} (${p.timeAgo}): "${p.content.substring(0, 80)}${p.content.length > 80 ? '...' : ''}"`
      )
      .join('\n');

    return {
      success: true,
      text: `Retrieved ${feedPosts.length} posts from the feed.\n\nLatest posts:\n${postSummaries}`,
      data: {
        posts: formattedPosts,
        count: feedPosts.length,
        hasMore: data.hasMore,
      },
      values: {
        count: feedPosts.length,
        hasMore: data.hasMore,
        posts: formattedPosts.map((p) => ({
          id: p.id,
          authorName: p.authorName,
          content: p.content.substring(0, 100),
          timeAgo: p.timeAgo,
          likeCount: p.likeCount,
          commentCount: p.commentCount,
        })),
      },
      // Tag for sidebar display
      tag: {
        type: 'feed',
        label: 'Feed',
        icon: 'Newspaper',
        data: {
          posts: formattedPosts,
          count: feedPosts.length,
          hasMore: data.hasMore,
        },
      },
    } as ActionResultWithTag;
  },
};
