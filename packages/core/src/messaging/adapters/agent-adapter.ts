/**
 * Agent Adapter for MessageBusCore
 * Routes messages to agent runtime for processing and sends responses back
 * Simplified version: relies on existing agent infrastructure
 */

import type { MessageBusAdapter, Message } from '../types';
import type { IAgentRuntime, Memory, Content, UUID, Media } from '../../types';
import { EventType } from '../../types';

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
      // Skip if this message is from this agent (avoid loops)
      if (message.authorId === this.runtime.agentId) {
        return;
      }

      // Transform message to agent Memory format
      const memory = this.transformToMemory(message);

      // Create callback for agent response
      const callback = async (responseContent: Content): Promise<Memory[]> => {
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

        return [];
      };

      // Emit MESSAGE_RECEIVED event to runtime
      // This will trigger plugin-bootstrap's messageReceivedHandler
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
      });
    } catch (error) {
      console.error('[AgentAdapter] Error processing message:', error);
    }
  }

  /**
   * Transform MessageBus Message to agent Memory format
   * Simplified: use message IDs directly, runtime will handle UUID swizzling
   */
  private transformToMemory(message: Message): Memory {
    // Create Memory object with direct IDs
    // Runtime/bootstrap will handle any necessary transformations
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

    return memory;
  }
}
