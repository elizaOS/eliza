import { MessageBus } from './message-bus';
import { MessageBusEvent, type Message } from './types';
import type { IAgentRuntime } from '../types/runtime';
import type { UUID, Content } from '../types/primitives';
import type { Memory } from '../types/memory';
import { EventType } from '../types/events';
import { ChannelType } from '../types/environment';
import { v4 as uuidv4 } from 'uuid';

/**
 * Connects AgentRuntime to MessageBus
 *
 * This replaces the old MessageBusService (990 lines!) with a simple connector.
 * No HTTP calls, no UUID mapping, no complexity.
 *
 * Usage:
 * ```typescript
 * const messageBus = new MessageBus(transport);
 * const connector = new MessageBusConnector(runtime, messageBus);
 * await connector.connect();
 * ```
 */
export class MessageBusConnector {
  constructor(
    private runtime: IAgentRuntime,
    private messageBus: MessageBus
  ) {}

  /**
   * Connect runtime to message bus
   */
  async connect(): Promise<void> {
    // Subscribe to incoming messages
    this.messageBus.on(MessageBusEvent.MESSAGE_RECEIVED, async (message: Message) => {
      await this.handleIncomingMessage(message);
    });

    // Subscribe to message deletions
    this.messageBus.on(MessageBusEvent.MESSAGE_DELETED, async ({ messageId }) => {
      await this.runtime.deleteMemory(messageId);
    });

    // Subscribe to room cleared
    this.messageBus.on(MessageBusEvent.ROOM_CLEARED, async ({ roomId }) => {
      const memories = await this.runtime.getMemoriesByRoomIds({
        tableName: 'messages',
        roomIds: [roomId],
      });
      for (const memory of memories) {
        if (memory.id) {
          await this.runtime.deleteMemory(memory.id);
        }
      }
    });
  }

  /**
   * Disconnect from message bus
   */
  async disconnect(): Promise<void> {
    this.messageBus.removeAllListeners(MessageBusEvent.MESSAGE_RECEIVED);
    this.messageBus.removeAllListeners(MessageBusEvent.MESSAGE_DELETED);
    this.messageBus.removeAllListeners(MessageBusEvent.ROOM_CLEARED);
  }

  /**
   * Handle incoming message from MessageBus
   */
  private async handleIncomingMessage(message: Message): Promise<void> {
    console.log(
      `[MessageBusConnector] Received message in room ${message.roomId} from ${message.authorId}`
    );

    // Check if agent is participant
    if (!this.messageBus.isParticipant(message.roomId, this.runtime.agentId)) {
      console.log(
        `[MessageBusConnector] Agent ${this.runtime.agentId} not a participant in room ${message.roomId}`
      );
      return;
    }

    // Skip own messages
    if (message.authorId === this.runtime.agentId) {
      console.log(`[MessageBusConnector] Skipping own message`);
      return;
    }

    console.log(
      `[MessageBusConnector] Processing message for agent ${this.runtime.character.name}`
    );

    // Ensure world exists in agent's database
    await this.runtime.ensureWorldExists({
      id: message.worldId,
      name: 'Default World',
      agentId: this.runtime.agentId,
      serverId: 'default',
    });

    // Ensure room exists in agent's database
    await this.runtime.ensureRoomExists({
      id: message.roomId,
      name: 'Chat Room',
      source: message.metadata?.source || 'messagebus',
      type: ChannelType.DM,
      worldId: message.worldId,
    });

    // Ensure author entity exists
    const authorEntity = await this.runtime.getEntityById(message.authorId);
    if (!authorEntity) {
      await this.runtime.createEntity({
        id: message.authorId,
        names: [
          message.metadata?.senderName?.toString() || `User-${message.authorId.substring(0, 8)}`,
        ],
        agentId: this.runtime.agentId,
        metadata: {
          source: message.metadata?.source || 'messagebus',
        },
      });
    }

    // Convert Message to Memory format
    const memory: Memory = {
      id: message.id,
      entityId: message.authorId,
      agentId: this.runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        text: message.content,
        source: message.metadata?.source,
        attachments: message.metadata?.attachments as any,
        inReplyTo: message.inReplyTo,
      },
      createdAt: message.createdAt,
      metadata: message.metadata,
    };

    // Check if memory already exists
    const existingMemory = await this.runtime.getMemoryById(memory.id as UUID);
    if (existingMemory) {
      return; // Skip duplicates
    }

    // Store in memory system
    await this.runtime.createMemory(memory, 'messages');

    // Emit MESSAGE_RECEIVED event for plugins (bootstrap)
    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      callback: async (responseContent: Content) => {
        await this.sendResponse(message, responseContent);
        return [];
      },
    });
  }

  /**
   * Send response via message bus
   */
  private async sendResponse(originalMessage: Message, content: Content): Promise<void> {
    // Skip if IGNORE action or no text
    if (content.actions?.includes('IGNORE') || !content.text?.trim()) {
      return;
    }

    const responseMessage: Message = {
      id: uuidv4() as UUID,
      roomId: originalMessage.roomId,
      worldId: originalMessage.worldId,
      authorId: this.runtime.agentId,
      content: content.text,
      metadata: {
        type: 'message',
        source: 'agent_response',
        thought: content.thought,
        actions: content.actions,
        attachments: content.attachments as any,
      },
      createdAt: Date.now(),
      inReplyTo: originalMessage.id,
    };

    await this.messageBus.sendMessage(responseMessage);
  }
}
