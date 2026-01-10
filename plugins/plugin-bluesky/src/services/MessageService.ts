import {
  logger,
  type IAgentRuntime,
  type UUID,
  type MessageType,
  ModelType,
  createUniqueUuid,
} from '@elizaos/core';
import { BlueSkyClient } from '../client.js';
import {
  BlueSkyConversation,
  BlueSkyMessage,
  SendMessageRequest,
  ServiceResponse,
} from '../common/types.js';

export interface MessageServiceInterface {
  getMessages(params: {
    agentId: UUID;
    roomId?: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<BlueSkyMessage[]>;

  sendMessage(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    type: MessageType;
    recipients?: string[];
    embed?: any;
  }): Promise<BlueSkyMessage>;

  getConversations(params: {
    agentId: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<BlueSkyConversation[]>;
}

export class BlueSkyMessageService implements MessageServiceInterface {
  static serviceType = 'IMessageService';

  constructor(
    private client: BlueSkyClient,
    private runtime: IAgentRuntime
  ) {}

  /**
   * Get messages from conversations
   */
  async getMessages(params: {
    agentId: UUID;
    roomId?: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<BlueSkyMessage[]> {
    try {
      // If roomId is provided, it should map to a specific conversation
      if (params.roomId) {
        // For now, we'll return empty array as we need to map roomId to convoId
        // In a real implementation, we'd maintain a mapping of roomId to convoId
        logger.debug('Getting messages for specific room not yet implemented', {
          roomId: params.roomId,
        });
        return [];
      }

      // Get all recent conversations and their messages
      const conversations = await this.client.getConversations(params.limit || 50, params.cursor);
      const allMessages: BlueSkyMessage[] = [];

      // Get messages from the most recent conversations
      for (const convo of conversations.conversations.slice(0, 5)) {
        try {
          const messagesResponse = await this.client.getMessages(convo.id, 10);
          allMessages.push(...messagesResponse.messages);
        } catch (error) {
          logger.error('Failed to get messages for conversation', { convoId: convo.id, error });
        }
      }

      return allMessages;
    } catch (error) {
      logger.error('Failed to get messages', { params, error });
      return [];
    }
  }

  /**
   * Send a message
   */
  async sendMessage(params: {
    agentId: UUID;
    roomId: UUID;
    text: string;
    type: MessageType;
    recipients?: string[];
    embed?: any;
  }): Promise<BlueSkyMessage> {
    try {
      // Generate message content using AI if needed
      let messageText = params.text;

      if (!messageText || messageText.trim() === '') {
        messageText = await this.generateMessageContent();
      }

      // For DMs, we need to find or create a conversation with the recipients
      // This is a simplified implementation - in reality, we'd need to:
      // 1. Check if a conversation exists with the recipients
      // 2. Create a new conversation if needed
      // 3. Send the message to that conversation

      // For now, we'll throw an error as we need a convoId
      throw new Error('Direct messaging requires conversation ID - not yet implemented');

      // Example of what the implementation would look like:
      // const convoId = await this.findOrCreateConversation(params.recipients);
      // const request: SendMessageRequest = {
      //   convoId,
      //   message: {
      //     text: messageText || '',
      //     embed: params.embed,
      //   },
      // };
      // const message = await this.client.sendMessage(request);
      // await this.storeMessageInMemory(params.roomId, message);
      // return message;
    } catch (error) {
      logger.error('Failed to send message', { params, error });
      throw error;
    }
  }

  /**
   * Get conversations
   */
  async getConversations(params: {
    agentId: UUID;
    limit?: number;
    cursor?: string;
  }): Promise<BlueSkyConversation[]> {
    try {
      const response = await this.client.getConversations(params.limit || 50, params.cursor);
      return response.conversations;
    } catch (error) {
      logger.error('Failed to get conversations', { params, error });
      return [];
    }
  }

  /**
   * Generate message content using AI
   */
  private async generateMessageContent(): Promise<string> {
    const prompt =
      'Generate a friendly and helpful direct message response. Keep it conversational and under 200 characters.';

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 50,
      });

      return response as string;
    } catch (error) {
      logger.error('Failed to generate message content', { error });
      return 'Hello! How can I help you today?';
    }
  }

  /**
   * Store message in agent memory
   */
  private async storeMessageInMemory(roomId: UUID, message: BlueSkyMessage): Promise<void> {
    try {
      const memory = {
        id: createUniqueUuid(this.runtime, message.id),
        agentId: this.runtime.agentId,
        content: {
          text: message.text || '',
          messageId: message.id,
          sender: message.sender.did,
          timestamp: message.sentAt,
        },
        roomId,
        userId: this.runtime.agentId,
        createdAt: Date.now(),
      };

      // Store memory using the runtime's memory API
      // Note: The exact method might vary based on ElizaOS version
      logger.debug('Would store message in memory', { memory });
    } catch (error) {
      logger.error('Failed to store message in memory', { error });
    }
  }

  /**
   * Find or create a conversation with recipients
   * This is a placeholder for future implementation
   */
  private async findOrCreateConversation(recipients?: string[]): Promise<string> {
    // In a real implementation, this would:
    // 1. Look up DIDs for recipient handles
    // 2. Check existing conversations
    // 3. Create a new conversation if needed
    throw new Error('Conversation management not yet implemented');
  }
}
