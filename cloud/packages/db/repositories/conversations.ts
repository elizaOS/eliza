import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import {
  hydrateJsonField,
  hydrateTextField,
  offloadJsonField,
  offloadTextField,
} from "@/lib/storage/object-store";
import { dbRead, dbWrite } from "../helpers";
import {
  type Conversation,
  type ConversationMessage,
  conversationMessages,
  conversations,
  type NewConversation,
  type NewConversationMessage,
} from "../schemas/conversations";

export type { Conversation, ConversationMessage, NewConversation, NewConversationMessage };

/**
 * Conversation with associated messages.
 */
export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

function conversationObjectOwner(
  conversation: Pick<Conversation, "id" | "organization_id">,
): string {
  return conversation.organization_id ?? `conversation-${conversation.id}`;
}

async function hydrateMessage(message: ConversationMessage): Promise<ConversationMessage> {
  const [content, apiRequest, apiResponse] = await Promise.all([
    hydrateTextField({
      storage: message.content_storage,
      key: message.content_key,
      inlineValue: message.content,
    }),
    hydrateJsonField<Record<string, unknown>>({
      storage: message.api_request_storage,
      key: message.api_request_key,
      inlineValue: message.api_request ?? null,
    }),
    hydrateJsonField<Record<string, unknown>>({
      storage: message.api_response_storage,
      key: message.api_response_key,
      inlineValue: message.api_response ?? null,
    }),
  ]);

  return {
    ...message,
    content: content ?? "",
    api_request: apiRequest,
    api_response: apiResponse,
  };
}

async function prepareMessageForInsert(
  data: NewConversationMessage,
  conversation: Pick<Conversation, "id" | "organization_id">,
): Promise<NewConversationMessage> {
  if (
    data.content_storage === "r2" ||
    data.api_request_storage === "r2" ||
    data.api_response_storage === "r2"
  ) {
    return data;
  }

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const organizationId = conversationObjectOwner(conversation);
  const [content, apiRequest, apiResponse] = await Promise.all([
    offloadTextField({
      namespace: ObjectNamespaces.ConversationMessageBodies,
      organizationId,
      objectId: id,
      field: "content",
      createdAt,
      value: data.content,
    }),
    offloadJsonField<Record<string, unknown>>({
      namespace: ObjectNamespaces.ConversationMessageApiPayloads,
      organizationId,
      objectId: id,
      field: "api_request",
      createdAt,
      value: data.api_request,
      inlineValueWhenOffloaded: null,
    }),
    offloadJsonField<Record<string, unknown>>({
      namespace: ObjectNamespaces.ConversationMessageApiPayloads,
      organizationId,
      objectId: id,
      field: "api_response",
      createdAt,
      value: data.api_response,
      inlineValueWhenOffloaded: null,
    }),
  ]);

  return {
    ...data,
    id,
    created_at: createdAt,
    content: content.value ?? "",
    content_storage: content.storage,
    content_key: content.key,
    api_request: apiRequest.value,
    api_request_storage: apiRequest.storage,
    api_request_key: apiRequest.key,
    api_response: apiResponse.value,
    api_response_storage: apiResponse.storage,
    api_response_key: apiResponse.key,
  };
}

/**
 * Repository for conversation database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class ConversationsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a conversation by ID.
   */
  async findById(id: string): Promise<Conversation | undefined> {
    return await dbRead.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });
  }

  /**
   * Finds a conversation with all associated messages.
   */
  async findWithMessages(id: string): Promise<ConversationWithMessages | undefined> {
    const conversation = await dbRead.query.conversations.findFirst({
      where: eq(conversations.id, id),
      with: {
        messages: {
          orderBy: desc(conversationMessages.sequence_number),
        },
      },
    });

    if (!conversation) return undefined;
    const messages = await Promise.all(
      conversation.messages.map((message: ConversationMessage) => hydrateMessage(message)),
    );
    return { ...conversation, messages } as ConversationWithMessages;
  }

  /**
   * Lists conversations for a user.
   */
  async listByUser(userId: string, limit?: number): Promise<Conversation[]> {
    return await dbRead.query.conversations.findMany({
      where: eq(conversations.user_id, userId),
      orderBy: desc(conversations.updated_at),
      limit,
    });
  }

  /**
   * Lists conversations for an organization.
   */
  async listByOrganization(organizationId: string, limit?: number): Promise<Conversation[]> {
    return await dbRead.query.conversations.findMany({
      where: eq(conversations.organization_id, organizationId),
      orderBy: desc(conversations.updated_at),
      limit,
    });
  }

  /**
   * Gets all messages for a conversation, ordered by sequence number.
   */
  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const messages = await dbRead.query.conversationMessages.findMany({
      where: eq(conversationMessages.conversation_id, conversationId),
      orderBy: desc(conversationMessages.sequence_number),
    });
    return await Promise.all(messages.map(hydrateMessage));
  }

  /**
   * Gets the next sequence number for a conversation.
   */
  async getNextSequenceNumber(conversationId: string): Promise<number> {
    const lastMessage = await dbRead.query.conversationMessages.findFirst({
      where: eq(conversationMessages.conversation_id, conversationId),
      orderBy: desc(conversationMessages.sequence_number),
    });

    return lastMessage ? lastMessage.sequence_number + 1 : 1;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new conversation.
   */
  async create(data: NewConversation): Promise<Conversation> {
    const [conversation] = await dbWrite.insert(conversations).values(data).returning();
    return conversation;
  }

  /**
   * Updates an existing conversation.
   */
  async update(id: string, data: Partial<NewConversation>): Promise<Conversation | undefined> {
    const [updated] = await dbWrite
      .update(conversations)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(conversations.id, id))
      .returning();
    return updated;
  }

  /**
   * Deletes a conversation by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(conversations).where(eq(conversations.id, id));
  }

  /**
   * Adds a message to a conversation.
   */
  async addMessage(data: NewConversationMessage): Promise<ConversationMessage> {
    const conversation = await dbWrite.query.conversations.findFirst({
      where: eq(conversations.id, data.conversation_id),
    });
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const insertData = await prepareMessageForInsert(data, conversation);
    const [message] = await dbWrite.insert(conversationMessages).values(insertData).returning();
    return await hydrateMessage(message);
  }

  /**
   * Adds a message with automatic sequence number and updates conversation stats.
   *
   * Performs all operations atomically in a transaction.
   */
  async addMessageWithSequence(
    conversationId: string,
    data: Omit<NewConversationMessage, "sequence_number" | "conversation_id">,
  ): Promise<ConversationMessage> {
    const conversationForStorage = await dbWrite.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    if (!conversationForStorage) {
      throw new Error("Conversation not found");
    }

    const insertData = await prepareMessageForInsert(
      {
        ...data,
        conversation_id: conversationId,
        sequence_number: 0,
      },
      conversationForStorage,
    );

    return await dbWrite.transaction(async (tx) => {
      const lastMessage = await tx.query.conversationMessages.findFirst({
        where: eq(conversationMessages.conversation_id, conversationId),
        orderBy: desc(conversationMessages.sequence_number),
      });

      const nextSequence = lastMessage ? lastMessage.sequence_number + 1 : 1;

      const [message] = await tx
        .insert(conversationMessages)
        .values({
          ...insertData,
          sequence_number: nextSequence,
        })
        .returning();

      const conversation = await tx.query.conversations.findFirst({
        where: eq(conversations.id, conversationId),
      });

      if (conversation) {
        await tx
          .update(conversations)
          .set({
            message_count: conversation.message_count + 1,
            last_message_at: new Date(),
            total_cost: String(Number(conversation.total_cost) + Number(data.cost || 0)),
            updated_at: new Date(),
          })
          .where(eq(conversations.id, conversationId));
      }

      return await hydrateMessage(message);
    });
  }
}

/**
 * Singleton instance of ConversationsRepository.
 */
export const conversationsRepository = new ConversationsRepository();
