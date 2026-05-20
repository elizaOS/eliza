/**
 * Social Feed Provider
 * Provides access to social feed and posts via A2A protocol
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../shared/logger';
import type { BabylonRuntime } from '../types';
// import type { A2AFeedResponse, A2ATrendingTagsResponse } from '../../../types/a2a-responses' // Commented out - not needed

/**
 * Provider: Recent Feed
 * Gets recent posts from the Babylon social feed via A2A
 */
export const feedProvider: Provider = {
  name: 'BABYLON_FEED',
  description: 'Get recent posts from the Babylon social feed via A2A protocol',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const babylonRuntime = runtime as BabylonRuntime;

    // A2A is required
    if (!babylonRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - feed provider requires A2A',
        undefined,
        runtime.agentId
      );
      return {
        text: 'ERROR: A2A client not connected. Cannot fetch feed. Please ensure A2A server is running.',
      };
    }

    // Validate feedResult structure
    const feedResult = await babylonRuntime.a2aClient.getFeed({ limit: 20 });
    if (!feedResult || typeof feedResult !== 'object') {
      throw new Error('Invalid feed result format from A2A client');
    }
    type FeedResult = {
      posts?: Array<{
        id: string;
        content: string;
        authorId: string;
        timestamp: string | Date;
        type?: string;
      }>;
    };
    const typedFeedResult = feedResult as FeedResult;
    const posts = typedFeedResult.posts || [];

    if (posts.length === 0) {
      return { text: 'No posts in feed.' };
    }

    const feedText = `Recent Feed Posts:\n${posts
      .map(
        (p, idx) =>
          `${idx + 1}. [${p.type || 'post'}] ${p.content?.substring(0, 200) ?? ''}${(p.content?.length ?? 0) > 200 ? '...' : ''} (Author: ${p.authorId}, ID: ${p.id})`
      )
      .join('\n\n')}`;

    return { text: feedText };
  },
};

/**
 * Provider: Trending Topics
 * Gets trending tags and topics via A2A
 */
export const trendingProvider: Provider = {
  name: 'BABYLON_TRENDING',
  description: 'Get trending topics and tags on Babylon via A2A protocol',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const babylonRuntime = runtime as BabylonRuntime;

    // A2A is required
    if (!babylonRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - trending provider requires A2A',
        undefined,
        runtime.agentId
      );
      return {
        text: 'ERROR: A2A client not connected. Cannot fetch trending topics. Please ensure A2A server is running.',
      };
    }

    try {
      const trendingResult = await babylonRuntime.a2aClient.getTrendingTags(20);
      const tags =
        (
          trendingResult as {
            tags?: Array<{
              id: string;
              name: string;
              displayName?: string;
            }>;
          }
        )?.tags || [];

      if (tags.length === 0) {
        return { text: 'No trending tags available.' };
      }

      const trendingText = `Trending Topics:\n${tags
        .map(
          (t, idx) => `${idx + 1}. #${t.displayName || t.name} (ID: ${t.id})`
        )
        .join('\n')}`;

      return { text: trendingText };
    } catch (error) {
      logger.error(
        'Error fetching trending tags via A2A',
        { error, agentId: runtime.agentId },
        'TrendingProvider'
      );
      throw error;
    }
  },
};
