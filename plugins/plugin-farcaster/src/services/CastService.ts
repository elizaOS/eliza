import {
  type IAgentRuntime,
  type UUID,
  ModelType,
  createUniqueUuid,
} from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { getFarcasterFid } from '../common/config';
import { castUuid, neynarCastToCast } from '../common/utils';
import { FARCASTER_SOURCE } from '../common/constants';
import type { Cast } from '../common/types';

// Simple interface for Cast data
interface FarcasterCast {
  id: string;
  agentId: UUID;
  roomId: UUID;
  userId: string;
  username: string;
  text: string;
  timestamp: number;
  inReplyTo?: string;
  media?: any[];
  metadata?: any;
}

export interface CastServiceInterface {
  getCasts(params: { agentId: UUID; limit?: number; cursor?: string }): Promise<FarcasterCast[]>;

  createCast(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    media?: string[];
    replyTo?: {
      hash: string;
      fid: number;
    };
  }): Promise<FarcasterCast>;

  deleteCast(params: { agentId: UUID; castHash: string }): Promise<void>;

  likeCast(params: { agentId: UUID; castHash: string }): Promise<void>;

  unlikeCast(params: { agentId: UUID; castHash: string }): Promise<void>;

  recast(params: { agentId: UUID; castHash: string }): Promise<void>;

  unrecast(params: { agentId: UUID; castHash: string }): Promise<void>;

  getMentions(params: { agentId: UUID; limit?: number }): Promise<FarcasterCast[]>;
}

export class FarcasterCastService implements CastServiceInterface {
  static serviceType = 'ICastService';

  constructor(
    private client: FarcasterClient,
    private runtime: IAgentRuntime
  ) {}

  /**
   * Get recent casts from the timeline
   */
  async getCasts(params: {
    agentId: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<FarcasterCast[]> {
    try {
      const fid = getFarcasterFid(this.runtime);
      if (!fid) {
        this.runtime.logger.error('FARCASTER_FID is not configured');
        return [];
      }

      const { timeline } = await this.client.getTimeline({
        fid,
        pageSize: params.limit || 50,
      });

      return timeline.map((cast) => this.castToFarcasterCast(cast, params.agentId));
    } catch (error) {
      this.runtime.logger.error(`Failed to get casts: ${JSON.stringify({ params, error })}`);
      return [];
    }
  }

  /**
   * Create a new cast
   */
  async createCast(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    media?: string[];
    replyTo?: {
      hash: string;
      fid: number;
    };
  }): Promise<FarcasterCast> {
    try {
      // Generate cast content using AI if needed
      let castText = params.text;

      if (!castText || castText.trim() === '') {
        castText = await this.generateCastContent();
      }

      // Ensure cast doesn't exceed character limit (320 characters for Farcaster)
      if (castText.length > 320) {
        castText = await this.truncateCast(castText);
      }

      // Send the cast
      const casts = await this.client.sendCast({
        content: { text: castText },
        inReplyTo: params.replyTo
          ? { hash: params.replyTo.hash, fid: params.replyTo.fid }
          : undefined,
      });

      if (casts.length === 0) {
        throw new Error('No cast was created');
      }

      const cast = neynarCastToCast(casts[0]);
      const farcasterCast: FarcasterCast = {
        id: castUuid({ hash: cast.hash, agentId: params.agentId }),
        agentId: params.agentId,
        roomId: params.roomId,
        userId: cast.profile.fid.toString(),
        username: cast.profile.username,
        text: cast.text,
        timestamp: cast.timestamp.getTime(),
        inReplyTo: params.replyTo?.hash,
        media: [], // TODO: Handle media upload when Farcaster API supports it
        metadata: {
          castHash: cast.hash,
          threadId: cast.threadId,
          authorFid: cast.authorFid,
          source: FARCASTER_SOURCE,
        },
      };

      // Store the cast in memory
      await this.storeCastInMemory(params.roomId, farcasterCast);

      return farcasterCast;
    } catch (error) {
      this.runtime.logger.error(`Failed to create cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  /**
   * Delete a cast
   */
  async deleteCast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      // Farcaster doesn't support deleting casts via API
      this.runtime.logger.warn(`Cast deletion is not supported by the Farcaster API: ${JSON.stringify({ castHash: params.castHash })}`);
    } catch (error) {
      this.runtime.logger.error(`Failed to delete cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  /**
   * Like a cast
   */
  async likeCast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      // TODO: Implement like functionality when Neynar API supports it
      this.runtime.logger.info(`Like functionality not yet implemented for cast: ${JSON.stringify({ castHash: params.castHash })}`);

      // In a full implementation, this would call the Neynar API
      // await this.client.neynar.likeCast({ signerUuid, castHash: params.castHash });
    } catch (error) {
      this.runtime.logger.error(`Failed to like cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  /**
   * Unlike a cast
   */
  async unlikeCast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      // TODO: Implement unlike functionality when Neynar API supports it
      this.runtime.logger.info(`Unlike functionality not yet implemented for cast: ${JSON.stringify({ castHash: params.castHash })}`);

      // In a full implementation, this would call the Neynar API
      // await this.client.neynar.unlikeCast({ signerUuid, castHash: params.castHash });
    } catch (error) {
      this.runtime.logger.error(`Failed to unlike cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  /**
   * Recast a cast
   */
  async recast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      // TODO: Implement recast functionality when Neynar API supports it
      this.runtime.logger.info(`Recast functionality not yet implemented for cast: ${JSON.stringify({ castHash: params.castHash })}`);

      // In a full implementation, this would call the Neynar API
      // await this.client.neynar.recast({ signerUuid, castHash: params.castHash });
    } catch (error) {
      this.runtime.logger.error(`Failed to recast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  /**
   * Remove a recast
   */
  async unrecast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      // TODO: Implement unrecast functionality when Neynar API supports it
      this.runtime.logger.info(`Remove recast functionality not yet implemented for cast: ${JSON.stringify({ castHash: params.castHash })}`);

      // In a full implementation, this would call the Neynar API
      // await this.client.neynar.unrecast({ signerUuid, castHash: params.castHash });
    } catch (error) {
      this.runtime.logger.error(`Failed to remove recast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  /**
   * Get mentions
   */
  async getMentions(params: { agentId: UUID; limit?: number }): Promise<FarcasterCast[]> {
    try {
      const fid = getFarcasterFid(this.runtime);
      if (!fid) {
        this.runtime.logger.error('FARCASTER_FID is not configured');
        return [];
      }

      const mentions = await this.client.getMentions({
        fid,
        pageSize: params.limit || 20,
      });

      return mentions.map((castWithInteractions) => {
        const cast = neynarCastToCast(castWithInteractions);
        return this.castToFarcasterCast(cast, params.agentId);
      });
    } catch (error) {
      this.runtime.logger.error(`Failed to get mentions: ${JSON.stringify({ params, error })}`);
      return [];
    }
  }

  /**
   * Generate cast content using AI
   */
  private async generateCastContent(): Promise<string> {
    const prompt = `Generate an interesting and engaging Farcaster cast. It should be conversational, authentic, and under 320 characters. Topics can include technology, AI, crypto, decentralized social media, or general observations about life.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
      });

      return response as string;
    } catch (error) {
      this.runtime.logger.error(`Failed to generate cast content: ${JSON.stringify({ error })}`);
      return 'Hello Farcaster! 👋';
    }
  }

  /**
   * Truncate cast to fit character limit
   */
  private async truncateCast(text: string): Promise<string> {
    const prompt = `Shorten this text to under 320 characters while keeping the main message intact: "${text}"`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
      });

      const truncated = response as string;

      // Ensure it's actually under the limit
      if (truncated.length > 320) {
        return truncated.substring(0, 317) + '...';
      }

      return truncated;
    } catch (error) {
      this.runtime.logger.error(`Failed to truncate cast: ${JSON.stringify({ error })}`);
      return text.substring(0, 317) + '...';
    }
  }

  /**
   * Store cast in agent memory
   */
  private async storeCastInMemory(roomId: UUID, cast: FarcasterCast): Promise<void> {
    try {
      const memory = {
        id: createUniqueUuid(this.runtime, cast.id),
        agentId: this.runtime.agentId,
        content: {
          text: cast.text,
          castHash: cast.metadata?.castHash,
          castId: cast.id,
          author: cast.username,
          timestamp: cast.timestamp,
        },
        roomId,
        userId: cast.userId,
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
        this.runtime.logger.warn('Memory storage method not available in runtime');
      }
    } catch (error) {
      this.runtime.logger.error(`Failed to store cast in memory: ${JSON.stringify({ error })}`);
    }
  }

  /**
   * Convert internal Cast type to FarcasterCast
   */
  private castToFarcasterCast(cast: Cast, agentId: UUID): FarcasterCast {
    return {
      id: castUuid({ hash: cast.hash, agentId }),
      agentId,
      roomId: createUniqueUuid(this.runtime, cast.threadId || cast.hash),
      userId: cast.profile.fid.toString(),
      username: cast.profile.username,
      text: cast.text,
      timestamp: cast.timestamp.getTime(),
      media: [], // Farcaster casts can have embedded media but not in our Cast type
      metadata: {
        castHash: cast.hash,
        threadId: cast.threadId,
        authorFid: cast.authorFid,
        source: FARCASTER_SOURCE,
        stats: cast.stats,
      },
    };
  }
}
