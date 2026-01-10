import {
  logger,
  type IAgentRuntime,
  type UUID,
  type MessageType,
  type ServiceType,
  ModelType,
  createUniqueUuid,
} from '@elizaos/core';
import { BlueSkyClient } from '../client.js';
import {
  BlueSkyPost,
  BlueSkyTimelineResponse,
  CreatePostRequest,
  ServiceResponse,
} from '../common/types.js';
import { BLUESKY_MAX_POST_LENGTH } from '../common/constants.js';

export interface PostServiceInterface {
  getPosts(params: { agentId: UUID; limit?: number; cursor?: string }): Promise<BlueSkyPost[]>;

  createPost(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    media?: string[];
    replyTo?: {
      uri: string;
      cid: string;
    };
  }): Promise<BlueSkyPost>;

  deletePost(params: { agentId: UUID; postUri: string }): Promise<void>;
}

export class BlueSkyPostService implements PostServiceInterface {
  static serviceType = 'IPostService';

  constructor(
    private client: BlueSkyClient,
    private runtime: IAgentRuntime
  ) {}

  /**
   * Get recent posts from the timeline
   */
  async getPosts(params: {
    agentId: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<BlueSkyPost[]> {
    try {
      const response = await this.client.getTimeline({
        limit: params.limit || 50,
        cursor: params.cursor,
      });

      return response.feed.map((item) => item.post);
    } catch (error) {
      logger.error('Failed to get posts', { params, error });
      return [];
    }
  }

  /**
   * Create a new post
   */
  async createPost(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    media?: string[];
    replyTo?: {
      uri: string;
      cid: string;
    };
  }): Promise<BlueSkyPost> {
    try {
      // Generate post content using AI if needed
      let postText = params.text;

      if (!postText || postText.trim() === '') {
        postText = await this.generatePostContent();
      }

      // Ensure post doesn't exceed character limit
      if (postText.length > BLUESKY_MAX_POST_LENGTH) {
        postText = await this.truncatePost(postText);
      }

      const request: CreatePostRequest = {
        content: {
          text: postText,
        },
        replyTo: params.replyTo,
      };

      // Add media embed if provided
      if (params.media && params.media.length > 0) {
        // Note: Media handling would need to be implemented
        // This is a placeholder for future media support
        logger.info('Media upload not yet implemented', { media: params.media });
      }

      const post = await this.client.sendPost(request);

      // Store the post in memory
      await this.storePostInMemory(params.roomId, post);

      return post;
    } catch (error) {
      logger.error('Failed to create post', { params, error });
      throw error;
    }
  }

  /**
   * Delete a post
   */
  async deletePost(params: { agentId: UUID; postUri: string }): Promise<void> {
    try {
      await this.client.deletePost(params.postUri);
      logger.info('Successfully deleted post', { postUri: params.postUri });
    } catch (error) {
      logger.error('Failed to delete post', { params, error });
      throw error;
    }
  }

  /**
   * Generate post content using AI
   */
  private async generatePostContent(): Promise<string> {
    const prompt = `Generate an interesting and engaging BlueSky post. It should be conversational, authentic, and under ${BLUESKY_MAX_POST_LENGTH} characters. Topics can include technology, AI, social media trends, or general observations about life.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
      });

      return response as string;
    } catch (error) {
      logger.error('Failed to generate post content', { error });
      return 'Hello BlueSky! 👋';
    }
  }

  /**
   * Truncate post to fit character limit
   */
  private async truncatePost(text: string): Promise<string> {
    const prompt = `Shorten this text to under ${BLUESKY_MAX_POST_LENGTH} characters while keeping the main message intact: "${text}"`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
      });

      const truncated = response as string;

      // Ensure it's actually under the limit
      if (truncated.length > BLUESKY_MAX_POST_LENGTH) {
        return truncated.substring(0, BLUESKY_MAX_POST_LENGTH - 3) + '...';
      }

      return truncated;
    } catch (error) {
      logger.error('Failed to truncate post', { error });
      return text.substring(0, BLUESKY_MAX_POST_LENGTH - 3) + '...';
    }
  }

  /**
   * Store post in agent memory
   */
  private async storePostInMemory(roomId: UUID, post: BlueSkyPost): Promise<void> {
    try {
      const memory = {
        id: createUniqueUuid(this.runtime, post.uri),
        agentId: this.runtime.agentId,
        content: {
          text: post.record.text,
          postUri: post.uri,
          postCid: post.cid,
          author: post.author.handle,
          timestamp: post.record.createdAt,
        },
        roomId,
        userId: this.runtime.agentId,
        createdAt: Date.now(),
      };

      // Store memory using the runtime's API
      // Note: The exact method may vary based on ElizaOS version
      if (typeof (this.runtime as any).storeMemory === 'function') {
        await (this.runtime as any).storeMemory(memory);
      } else if (
        (this.runtime as any).memory &&
        typeof (this.runtime as any).memory.create === 'function'
      ) {
        await (this.runtime as any).memory.create(memory);
      } else {
        logger.warn('Memory storage method not available in runtime');
      }
    } catch (error) {
      logger.error('Failed to store post in memory', { error });
    }
  }
}
