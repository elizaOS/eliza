/**
 * Agent Adapter for MessageBusCore
 * Routes messages to agent runtime for processing and sends responses back
 * Simplified version: relies on existing agent infrastructure
 */

import type { MessageBusAdapter, Message } from '../types';
import type { IAgentRuntime, Memory, Content, UUID, Media } from '../../types';
import { EventType } from '../../types';
import { createUniqueUuid } from '../../entities';

/**
 * Agent adapter that processes messages through the agent runtime
 * Sends responses back through the message bus
 */
export class AgentAdapter implements MessageBusAdapter {
  name = 'agent';

  constructor(
    private runtime: IAgentRuntime,
    private messageBus: any // MessageBusCore - will be injected
  ) {}

  /**
   * Process incoming message through agent
   */
  async onMessage(message: Message): Promise<void> {
    try {
      console.log(
        `[AgentAdapter] Processing message ${message.id} from ${message.authorName} in channel ${message.channelId}`
      );

      // Skip if this message is from this agent (avoid loops)
      if (message.authorId === this.runtime.agentId) {
        console.log(
          `[AgentAdapter] Skipping message from self (agent ${this.runtime.character.name})`
        );
        return;
      }

      // Transform message to agent Memory format
      const memory = this.transformToMemory(message);
      console.log(`[AgentAdapter] Transformed to memory, emitting MESSAGE_RECEIVED event`);

      // Create callback for agent response
      const callback = async (responseContent: Content): Promise<Memory[]> => {
        console.log(
          `[AgentAdapter] Agent ${this.runtime.character.name} generated response, sending back through bus`
        );

        // Send agent's response back through the bus
        await this.messageBus.send({
          channelId: message.channelId,
          serverId: message.serverId,
          authorId: this.runtime.agentId,
          authorName: this.runtime.character.name,
          content: responseContent.text || '',
          source: 'agent',
          metadata: {
            thought: responseContent.thought,
            actions: responseContent.actions,
            ...(responseContent.metadata || {}),
          },
          inReplyTo: message.id,
          attachments: responseContent.attachments,
        });

        console.log(`[AgentAdapter] Agent response sent through bus successfully`);
        return [];
      };

      // Emit MESSAGE_RECEIVED event to runtime
      // This will trigger plugin-bootstrap's messageReceivedHandler
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
      });

      console.log(
        `[AgentAdapter] MESSAGE_RECEIVED event emitted for agent ${this.runtime.character.name}`
      );
    } catch (error) {
      console.error('[AgentAdapter] Error processing message:', error);
    }
  }

  /**
   * Transform MessageBus Message to agent Memory format
   * Uses UUID-swizzled IDs for agent-specific storage
   */
  private transformToMemory(message: Message): Memory {
    // Create agent-specific swizzled UUIDs
    const roomId = createUniqueUuid(this.runtime, message.channelId);
    const worldId = createUniqueUuid(this.runtime, message.serverId);
    const entityId = createUniqueUuid(this.runtime, message.authorId);
    const messageId = createUniqueUuid(this.runtime, message.id);

    const memory: Memory = {
      id: messageId,
      entityId: entityId,
      agentId: this.runtime.agentId,
      roomId: roomId,
      worldId: worldId,
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
    };

    return memory;
  }
}
