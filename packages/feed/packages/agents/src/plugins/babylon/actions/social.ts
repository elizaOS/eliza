/**
 * Social Actions
 * Actions for social interactions (posts, comments, likes)
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
// import { logger } from '../../../shared/logger' // Commented out - not needed
import type { BabylonRuntime } from '../types';

/**
 * Action: Create Post
 * Allows agent to create a post on the social feed
 */
export const createPostAction: Action = {
  name: 'CREATE_POST',
  description: 'Create a post on the Babylon social feed',
  similes: ['post', 'share thought', 'publish', 'create post', 'write post'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Post about market analysis' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Creating post...', action: 'CREATE_POST' },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return (
      content.includes('post') ||
      content.includes('share') ||
      content.includes('publish')
    );
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot create post.',
          action: 'CREATE_POST',
        });
      }
      return;
    }

    // Extract post content
    const content = message.content.text || '';
    const postContent = content.replace(/^(post|share|publish)\s+/i, '').trim();

    if (!postContent) {
      if (callback) {
        callback({
          text: 'No content provided for post.',
          action: 'CREATE_POST',
        });
      }
      return;
    }

    const result = (await babylonRuntime.a2aClient.createPost(
      postContent,
      'post'
    )) as { success?: boolean; postId?: string; message?: string };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to create post: ${result.message || 'Unknown error'}`,
          action: 'CREATE_POST',
        });
      } else {
        callback({
          text: `Successfully created post! Post ID: ${result.postId || 'unknown'}`,
          action: 'CREATE_POST',
        });
      }
    }
  }) as unknown as Action['handler'],
};

/**
 * Action: Comment on Post
 * Allows agent to comment on a post
 */
export const commentAction: Action = {
  name: 'COMMENT_ON_POST',
  description: 'Comment on a post',
  similes: ['comment', 'reply', 'respond to post'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Comment on post post-123 with "Great analysis!"' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Commenting on post...', action: 'COMMENT_ON_POST' },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return content.includes('comment') || content.includes('reply');
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot comment.',
          action: 'COMMENT_ON_POST',
        });
      }
      return;
    }

    // Parse message
    const content = message.content.text || '';
    const postIdMatch = content.match(/post[:\s-]+([a-zA-Z0-9-]+)/);
    const commentMatch =
      content.match(/(?:with|:)\s*["'](.+?)["']/) ||
      content.match(/comment\s+(.+)$/i);

    if (!postIdMatch || !commentMatch) {
      if (callback) {
        callback({
          text: 'Could not parse comment parameters. Please specify post ID and comment text.',
          action: 'COMMENT_ON_POST',
        });
      }
      return;
    }

    const postId = postIdMatch[1]!;
    const commentContent = commentMatch[1]!;

    const result = (await babylonRuntime.a2aClient.createComment(
      postId,
      commentContent
    )) as { success?: boolean; commentId?: string; message?: string };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to create comment: ${result.message || 'Unknown error'}`,
          action: 'COMMENT_ON_POST',
        });
      } else {
        callback({
          text: `Successfully commented on post! Comment ID: ${result.commentId || 'unknown'}`,
          action: 'COMMENT_ON_POST',
        });
      }
    }
  }) as unknown as Action['handler'],
};

/**
 * Action: Like Post
 * Allows agent to like a post
 */
export const likePostAction: Action = {
  name: 'LIKE_POST',
  description: 'Like a post on the feed',
  similes: ['like', 'upvote', 'react to post'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Like post post-123' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Liking post...', action: 'LIKE_POST' },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return content.includes('like') || content.includes('upvote');
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot like post.',
          action: 'LIKE_POST',
        });
      }
      return;
    }

    // Parse message
    const content = message.content.text || '';
    const postIdMatch = content.match(/post[:\s-]+([a-zA-Z0-9-]+)/);

    if (!postIdMatch) {
      if (callback) {
        callback({
          text: 'Could not parse post ID. Please specify which post to like.',
          action: 'LIKE_POST',
        });
      }
      return;
    }

    const postId = postIdMatch[1]!;

    const result = (await babylonRuntime.a2aClient.likePost(postId)) as {
      success?: boolean;
      likeCount?: number;
      message?: string;
    };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to like post: ${result.message || 'Unknown error'}`,
          action: 'LIKE_POST',
        });
      } else {
        callback({
          text: `Successfully liked post ${postId}!${result.likeCount !== undefined ? ` Total likes: ${result.likeCount}` : ''}`,
          action: 'LIKE_POST',
        });
      }
    }
  }) as unknown as Action['handler'],
};
