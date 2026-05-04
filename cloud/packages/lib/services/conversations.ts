/**
 * Service for managing conversations and conversation messages.
 */

import {
  type Conversation,
  type ConversationMessage,
  type ConversationWithMessages,
  conversationsRepository,
  type NewConversation,
  type NewConversationMessage,
} from "@/db/repositories";

/**
 * Service for conversation CRUD operations and message management.
 */
export class ConversationsService {
  async getById(id: string): Promise<Conversation | undefined> {
    return await conversationsRepository.findById(id);
  }

  async getWithMessages(id: string): Promise<ConversationWithMessages | undefined> {
    return await conversationsRepository.findWithMessages(id);
  }

  async listByUser(userId: string, limit?: number): Promise<Conversation[]> {
    return await conversationsRepository.listByUser(userId, limit);
  }

  async listByOrganization(organizationId: string, limit?: number): Promise<Conversation[]> {
    return await conversationsRepository.listByOrganization(organizationId, limit);
  }

  async create(data: NewConversation): Promise<Conversation> {
    return await conversationsRepository.create(data);
  }

  async update(id: string, data: Partial<NewConversation>): Promise<Conversation | undefined> {
    return await conversationsRepository.update(id, data);
  }

  async delete(id: string): Promise<void> {
    await conversationsRepository.delete(id);
  }

  // Message operations
  async addMessage(
    conversationId: string,
    role: string,
    content: string,
    sequenceNumber: number,
    additionalData?: Partial<NewConversationMessage>,
  ): Promise<ConversationMessage> {
    const message = await conversationsRepository.addMessage({
      conversation_id: conversationId,
      role,
      content,
      sequence_number: sequenceNumber,
      ...additionalData,
    });

    // Update conversation metadata
    await conversationsRepository.update(conversationId, {
      message_count: sequenceNumber + 1,
      last_message_at: new Date(),
    });

    return message;
  }

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    return await conversationsRepository.getMessages(conversationId);
  }

  async getNextSequenceNumber(conversationId: string): Promise<number> {
    return await conversationsRepository.getNextSequenceNumber(conversationId);
  }

  async addMessageWithSequence(
    conversationId: string,
    data: Omit<NewConversationMessage, "sequence_number" | "conversation_id">,
  ): Promise<ConversationMessage> {
    return await conversationsRepository.addMessageWithSequence(conversationId, data);
  }
}

// Export singleton instance
export const conversationsService = new ConversationsService();
