/**
 * Database Adapter for MessageBusCore
 * Uses runtime's ensureConnection for proper room/world/participant setup
 * Works in both browser and server modes
 * Each agent gets its own adapter instance for independent storage
 */

import type { MessageBusAdapter, Message } from '../types';
import type { IAgentRuntime, UUID, Media } from '../../types';
import { createUniqueUuid } from '../../entities';

/**
 * Database adapter that stores messages using runtime's database methods
 * Properly creates rooms/worlds/participants before storing
 */
export class MessageDatabaseAdapter implements MessageBusAdapter {
  name: string;

  constructor(private runtime: IAgentRuntime) {
    this.name = `message-database-${runtime.character.name}`;
  }

  /**
   * Store a message in the database
   * Uses runtime.ensureConnection to create room/world/participants first
   */
  async onMessage(message: Message): Promise<void> {
    try {
      console.log(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Storing message ${message.id} from ${message.authorName}`
      );

      // Create agent-specific UUIDs
      const roomId = createUniqueUuid(this.runtime, message.channelId);
      const worldId = createUniqueUuid(this.runtime, message.serverId);
      const entityId = createUniqueUuid(this.runtime, message.authorId);
      const messageId = createUniqueUuid(this.runtime, message.id);

      // Ensure connection (creates world, room, participants)
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        worldId,
        worldName: `Server ${message.serverId.substring(0, 8)}`,
        userName: message.authorName,
        name: `Channel ${message.channelId.substring(0, 8)}`,
        source: message.source || 'message-bus',
        type: 'group',
        channelId: message.channelId,
        serverId: message.serverId,
        userId: message.authorId as UUID,
        metadata: message.metadata,
      });

      // Store message
      await this.runtime.createMemory(
        {
          id: messageId,
          entityId,
          agentId: this.runtime.agentId,
          roomId,
          worldId,
          content: {
            text: message.content,
            source: message.source || 'message-bus',
            attachments: (message.attachments as Media[]) || [],
            metadata: message.metadata,
            inReplyTo: message.inReplyTo
              ? (createUniqueUuid(this.runtime, message.inReplyTo) as UUID)
              : undefined,
          },
          createdAt: message.timestamp,
        },
        'messages'
      );

      console.log(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Successfully stored message ${message.id}`
      );
    } catch (error) {
      console.error(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Error storing message:`,
        error
      );
      // Don't throw - let other adapters continue
    }
  }

  /**
   * Handle user joining a channel
   */
  async onJoin(channelId: string, userId: string): Promise<void> {
    try {
      const roomId = createUniqueUuid(this.runtime, channelId);
      const entityId = createUniqueUuid(this.runtime, userId);

      // Ensure participant is in room
      await this.runtime.ensureParticipantInRoom(entityId, roomId);
      console.log(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] User ${userId} joined channel ${channelId}`
      );
    } catch (error) {
      console.error(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Error on join:`,
        error
      );
    }
  }

  /**
   * Handle user leaving a channel
   */
  async onLeave(_channelId: string, _userId: string): Promise<void> {
    // Keep participant in room for history
  }

  /**
   * Handle message deletion
   */
  async onDelete(messageId: string, _channelId: string): Promise<void> {
    try {
      const agentMessageId = createUniqueUuid(this.runtime, messageId);
      await this.runtime.deleteMemory(agentMessageId);
      console.log(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Deleted message ${messageId}`
      );
    } catch (error) {
      console.error(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Error deleting message:`,
        error
      );
    }
  }

  /**
   * Handle channel clearing
   */
  async onClear(channelId: string): Promise<void> {
    try {
      const roomId = createUniqueUuid(this.runtime, channelId);

      // Get all messages in this room
      const memories = await this.runtime.getMemories({
        roomId: roomId,
        tableName: 'messages',
        count: 1000,
      });

      // Delete all messages
      for (const memory of memories) {
        if (memory.id) {
          await this.runtime.deleteMemory(memory.id);
        }
      }

      console.log(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Cleared ${memories.length} messages from channel ${channelId}`
      );
    } catch (error) {
      console.error(
        `[MessageDatabaseAdapter:${this.runtime.character.name}] Error clearing channel:`,
        error
      );
    }
  }
}
