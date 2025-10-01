/**
 * Database Adapter for MessageBusCore
 * Stores messages in the existing database schema
 * Simplified version: just stores messages, lets runtime handle world/room creation
 */

import type { MessageBusAdapter, Message } from '../types';
import type { IDatabaseAdapter, Memory, UUID, Media, IAgentRuntime } from '../../types';

/**
 * Database adapter that stores messages using the existing schema
 * Works with existing memories table
 */
export class MessageDatabaseAdapter implements MessageBusAdapter {
  name = 'message-database';

  constructor(
    private runtime: IAgentRuntime,
    private db: IDatabaseAdapter
  ) {}

  /**
   * Store a message in the database
   * Simplified: just store the memory, let the runtime handle world/room creation
   */
  async onMessage(message: Message): Promise<void> {
    try {
      // Store message as Memory
      // Use channelId and serverId directly as UUIDs (room and world will be created by runtime if needed)
      const memory: Memory = {
        id: message.id as UUID,
        entityId: message.authorId as UUID,
        agentId: this.runtime.agentId,
        roomId: message.channelId as UUID,
        worldId: message.serverId as UUID,
        content: {
          text: message.content,
          source: message.source || 'message-bus',
          attachments: (message.attachments as Media[]) || [],
          metadata: message.metadata,
          inReplyTo: message.inReplyTo as UUID | undefined,
        },
        createdAt: message.timestamp,
      };

      await this.db.createMemory(memory, 'messages');
    } catch (error) {
      console.error('[DatabaseAdapter] Error storing message:', error);
      throw error;
    }
  }

  /**
   * Handle user joining a channel
   * Simplified: Just a notification, actual room/participant creation handled by runtime
   */
  async onJoin(_channelId: string, _userId: string): Promise<void> {
    // Room/participant management handled by runtime
  }

  /**
   * Handle user leaving a channel
   * Simplified: Just a notification
   */
  async onLeave(_channelId: string, _userId: string): Promise<void> {
    // Room/participant management handled by runtime
  }

  /**
   * Handle message deletion
   * Note: IDatabaseAdapter doesn't have removeMemory, so this is a no-op for now
   */
  async onDelete(_messageId: string, _channelId: string): Promise<void> {
    // Message deletion would need to be implemented via direct database access
    console.log('[DatabaseAdapter] Message deletion not implemented (no removeMemory method)');
  }

  /**
   * Handle channel clearing
   * Note: Would need custom implementation via direct database access
   */
  async onClear(_channelId: string): Promise<void> {
    // Channel clearing would need to be implemented via direct database access
    console.log('[DatabaseAdapter] Channel clearing not implemented');
  }
}
