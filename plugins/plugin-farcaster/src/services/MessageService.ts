import { type UUID, createUniqueUuid } from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { getFarcasterFid } from '../common/config';
import { castUuid, neynarCastToCast } from '../common/utils';
import { FARCASTER_SOURCE } from '../common/constants';
import { FarcasterMessageType, FarcasterEventTypes } from '../common/types';
import type { Cast } from '../common/types';

// Simple interfaces for MessageService compatibility
interface Message {
  id: string;
  agentId: UUID;
  roomId: string;
  userId: string;
  username: string;
  text: string;
  type: FarcasterMessageType;
  timestamp: number;
  inReplyTo?: string;
  metadata?: any;
}

interface GetMessagesOptions {
  agentId: UUID;
  roomId?: string;
  limit?: number;
}

interface SendMessageOptions {
  agentId: UUID;
  roomId: string;
  text: string;
  type: string;
  replyToId?: string;
  metadata?: any;
}

interface IMessageService {
  getMessages(options: GetMessagesOptions): Promise<Message[]>;
  sendMessage(options: SendMessageOptions): Promise<Message>;
  getMessage(messageId: string, agentId: UUID): Promise<Message | null>;
}

export class FarcasterMessageService implements IMessageService {
  constructor(
    private client: FarcasterClient,
    private runtime: any
  ) { }

  private castToMessage(
    cast: Cast,
    agentId: UUID,
    extraMetadata?: Record<string, unknown>
  ): Message {
    return {
      id: castUuid({ hash: cast.hash, agentId }),
      agentId,
      roomId: createUniqueUuid(this.runtime, cast.threadId || cast.hash),
      userId: cast.profile.fid.toString(),
      username: cast.profile.username,
      text: cast.text,
      type: cast.inReplyTo ? FarcasterMessageType.REPLY : FarcasterMessageType.CAST,
      timestamp: cast.timestamp.getTime(),
      inReplyTo: cast.inReplyTo ? castUuid({ hash: cast.inReplyTo.hash, agentId }) : undefined,
      metadata: {
        source: FARCASTER_SOURCE,
        castHash: cast.hash,
        threadId: cast.threadId,
        authorFid: cast.authorFid,
        ...(extraMetadata || {}),
      },
    };
  }

  async getMessages(options: GetMessagesOptions): Promise<Message[]> {
    try {
      const { agentId, roomId, limit = 20 } = options;

      // Get mentions and timeline
      const fid = getFarcasterFid(this.runtime);
      if (!fid) {
        this.runtime.logger.error('[Farcaster] FARCASTER_FID is not configured');
        return [];
      }

      const { timeline } = await this.client.getTimeline({
        fid,
        pageSize: limit,
      });

      const messages: Message[] = timeline
        .map((cast) => this.castToMessage(cast, agentId))
        .filter((message) => {
          if (roomId) {
            return message.roomId === roomId;
          }
          return true;
        });

      return messages;
    } catch (error) {
      this.runtime.logger.error({ error }, '[Farcaster] Error fetching messages');
      return [];
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<Message> {
    try {
      const { text, type, roomId, replyToId, agentId } = options;

      let inReplyTo: { hash: string; fid: number } | undefined = undefined;
      if (replyToId && type === FarcasterMessageType.REPLY) {
        // Extract cast hash from the message ID (which is a UUID)
        // In a real implementation, you'd need to maintain a mapping or extract from metadata
        const parentHash = options.metadata?.parentHash || replyToId;
        const fid = getFarcasterFid(this.runtime);
        if (!fid) {
          throw new Error('FARCASTER_FID is not configured');
        }
        inReplyTo = {
          hash: parentHash as string,
          fid,
        };
      }

      const casts = await this.client.sendCast({
        content: { text },
        inReplyTo,
      });

      if (casts.length === 0) {
        throw new Error('No cast was created');
      }

      const cast = neynarCastToCast(casts[0]);
      const message = this.castToMessage(cast, agentId, options.metadata);
      message.roomId = roomId;
      message.type = type as FarcasterMessageType;

      // Emit event for metadata tracking
      await this.runtime.emitEvent(FarcasterEventTypes.CAST_GENERATED, {
        runtime: this.runtime,
        castHash: cast.hash,
        message,
        threadId: cast.threadId,
      });

      return message;
    } catch (error) {
      this.runtime.logger.error({ error }, '[Farcaster] Error sending message');
      throw error;
    }
  }

  async deleteMessage(messageId: string, agentId: UUID): Promise<void> {
    // Farcaster doesn't support deleting casts via API
    this.runtime.logger.warn('[Farcaster] Cast deletion is not supported by the Farcaster API');
  }

  async getMessage(messageId: string, agentId: UUID): Promise<Message | null> {
    try {
      // Extract cast hash from the message ID
      // In production, you'd need to maintain a proper mapping
      const castHash = messageId; // Simplified for now

      const cast = await this.client.getCast(castHash);
      const farcasterCast = neynarCastToCast(cast);

      return this.castToMessage(farcasterCast, agentId);
    } catch (error) {
      this.runtime.logger.error({ error }, '[Farcaster] Error fetching message');
      return null;
    }
  }

  async getThread(params: { agentId: UUID; castHash: string }): Promise<Message[]> {
    try {
      const thread: Message[] = [];
      const visited = new Set<string>();
      let currentHash: string | undefined = params.castHash;

      while (currentHash) {
        if (visited.has(currentHash)) {
          break;
        }
        visited.add(currentHash);

        const cast = neynarCastToCast(await this.client.getCast(currentHash));
        thread.unshift(this.castToMessage(cast, params.agentId));

        currentHash = cast.inReplyTo?.hash;
      }

      return thread;
    } catch (error) {
      this.runtime.logger.error({ error }, '[Farcaster] Error fetching thread');
      return [];
    }
  }

  async markAsRead(messageIds: string[], agentId: UUID): Promise<void> {
    // Farcaster doesn't have a read/unread concept
    this.runtime.logger.debug('[Farcaster] Mark as read is not applicable for Farcaster casts');
  }
}
