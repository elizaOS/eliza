import { createUniqueUuid, type IAgentRuntime, ModelType, type UUID } from "@elizaos/core";
import type { FarcasterClient } from "../client/FarcasterClient";
import { type Cast, FARCASTER_SOURCE } from "../types";
import { castUuid, neynarCastToCast } from "../utils";
import { getFarcasterFid } from "../utils/config";

interface FarcasterCast {
  id: string;
  agentId: UUID;
  roomId: UUID;
  userId: string;
  username: string;
  text: string;
  timestamp: number;
  inReplyTo?: string;
  media?: Array<Record<string, string | number | boolean>>;
  metadata?: Record<string, string | number | boolean>;
}

export interface CastServiceInterface {
  getCasts(params: { agentId: UUID; limit?: number; cursor?: string }): Promise<FarcasterCast[]>;
  createCast(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    media?: string[];
    replyTo?: { hash: string; fid: number };
  }): Promise<FarcasterCast>;
  deleteCast(params: { agentId: UUID; castHash: string }): Promise<void>;
  likeCast(params: { agentId: UUID; castHash: string }): Promise<void>;
  unlikeCast(params: { agentId: UUID; castHash: string }): Promise<void>;
  recast(params: { agentId: UUID; castHash: string }): Promise<void>;
  unrecast(params: { agentId: UUID; castHash: string }): Promise<void>;
  getMentions(params: { agentId: UUID; limit?: number }): Promise<FarcasterCast[]>;
}

export class FarcasterCastService implements CastServiceInterface {
  static serviceType = "ICastService";

  constructor(
    private client: FarcasterClient,
    private runtime: IAgentRuntime
  ) {}

  async getCasts(params: {
    agentId: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<FarcasterCast[]> {
    try {
      const fid = getFarcasterFid(this.runtime);
      if (!fid) {
        this.runtime.logger.error("FARCASTER_FID is not configured");
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

  async createCast(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    media?: string[];
    replyTo?: { hash: string; fid: number };
  }): Promise<FarcasterCast> {
    try {
      let castText = params.text;

      if (!castText || castText.trim() === "") {
        castText = await this.generateCastContent();
      }

      if (castText.length > 320) {
        castText = await this.truncateCast(castText);
      }

      const casts = await this.client.sendCast({
        content: { text: castText },
        inReplyTo: params.replyTo
          ? { hash: params.replyTo.hash, fid: params.replyTo.fid }
          : undefined,
      });

      if (casts.length === 0) {
        throw new Error("No cast was created");
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
        media: [],
        metadata: {
          castHash: cast.hash,
          authorFid: cast.authorFid,
          source: FARCASTER_SOURCE,
          ...(cast.threadId ? { threadId: cast.threadId } : {}),
        },
      };

      await this.storeCastInMemory(params.roomId, farcasterCast);

      return farcasterCast;
    } catch (error) {
      this.runtime.logger.error(`Failed to create cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  async deleteCast(params: { agentId: UUID; castHash: string }): Promise<void> {
    this.runtime.logger.warn(
      `Cast deletion is not supported by the Farcaster API: ${JSON.stringify({ castHash: params.castHash })}`
    );
  }

  async likeCast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      const result = await this.client.publishReaction({
        reactionType: "like",
        target: params.castHash,
      });

      if (!result.success) {
        throw new Error(`Failed to like cast: ${params.castHash}`);
      }

      this.runtime.logger.info(`Liked cast: ${params.castHash}`);
    } catch (error) {
      this.runtime.logger.error(`Failed to like cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  async unlikeCast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      const result = await this.client.deleteReaction({
        reactionType: "like",
        target: params.castHash,
      });

      if (!result.success) {
        throw new Error(`Failed to unlike cast: ${params.castHash}`);
      }

      this.runtime.logger.info(`Unliked cast: ${params.castHash}`);
    } catch (error) {
      this.runtime.logger.error(`Failed to unlike cast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  async recast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      const result = await this.client.publishReaction({
        reactionType: "recast",
        target: params.castHash,
      });

      if (!result.success) {
        throw new Error(`Failed to recast: ${params.castHash}`);
      }

      this.runtime.logger.info(`Recasted: ${params.castHash}`);
    } catch (error) {
      this.runtime.logger.error(`Failed to recast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  async unrecast(params: { agentId: UUID; castHash: string }): Promise<void> {
    try {
      const result = await this.client.deleteReaction({
        reactionType: "recast",
        target: params.castHash,
      });

      if (!result.success) {
        throw new Error(`Failed to remove recast: ${params.castHash}`);
      }

      this.runtime.logger.info(`Removed recast: ${params.castHash}`);
    } catch (error) {
      this.runtime.logger.error(`Failed to remove recast: ${JSON.stringify({ params, error })}`);
      throw error;
    }
  }

  async getMentions(params: { agentId: UUID; limit?: number }): Promise<FarcasterCast[]> {
    try {
      const fid = getFarcasterFid(this.runtime);
      if (!fid) {
        this.runtime.logger.error("FARCASTER_FID is not configured");
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
      return "Hello Farcaster! 👋";
    }
  }

  private async truncateCast(text: string): Promise<string> {
    const prompt = `Shorten this text to under 320 characters while keeping the main message intact: "${text}"`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
      });

      const truncated = response as string;

      if (truncated.length > 320) {
        return `${truncated.substring(0, 317)}...`;
      }

      return truncated;
    } catch (error) {
      this.runtime.logger.error(`Failed to truncate cast: ${JSON.stringify({ error })}`);
      return `${text.substring(0, 317)}...`;
    }
  }

  private async storeCastInMemory(roomId: UUID, cast: FarcasterCast): Promise<void> {
    try {
      const entityId = createUniqueUuid(this.runtime, cast.userId);
      const memory = {
        id: createUniqueUuid(this.runtime, cast.id),
        agentId: this.runtime.agentId,
        entityId,
        content: {
          text: cast.text,
          castHash: String(cast.metadata?.castHash || ""),
          castId: cast.id,
          author: cast.username,
          timestamp: cast.timestamp,
        },
        roomId,
        createdAt: Date.now(),
      };

      // Use the database adapter's createMemory method
      await this.runtime.createMemory(memory, "farcaster_casts");
    } catch (error) {
      this.runtime.logger.error(`Failed to store cast in memory: ${JSON.stringify({ error })}`);
    }
  }

  private castToFarcasterCast(cast: Cast, agentId: UUID): FarcasterCast {
    return {
      id: castUuid({ hash: cast.hash, agentId }),
      agentId,
      roomId: createUniqueUuid(this.runtime, cast.threadId || cast.hash),
      userId: cast.profile.fid.toString(),
      username: cast.profile.username,
      text: cast.text,
      timestamp: cast.timestamp.getTime(),
      media: [],
      metadata: {
        castHash: cast.hash,
        authorFid: cast.authorFid,
        source: FARCASTER_SOURCE,
        ...(cast.threadId ? { threadId: cast.threadId } : {}),
        ...(cast.stats
          ? {
              recasts: cast.stats.recasts,
              replies: cast.stats.replies,
              likes: cast.stats.likes,
            }
          : {}),
      },
    };
  }
}
