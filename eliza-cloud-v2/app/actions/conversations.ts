"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth";
import { conversationsService } from "@/lib/services/conversations";

/**
 * Creates a new conversation for the authenticated user.
 *
 * @param data - Conversation data containing title and model.
 * @returns Success status with the created conversation.
 */
export async function createConversationAction(data: {
  title: string;
  model: string;
}) {
  const user = await requireAuth();

  const conversation = await conversationsService.create({
    title: data.title,
    model: data.model,
    organization_id: user.organization_id,
    user_id: user.id,
    status: "active",
  });

  revalidatePath("/dashboard/chat");
  return { success: true, conversation };
}

/**
 * Updates the title of an existing conversation.
 *
 * @param conversationId - The ID of the conversation to update.
 * @param title - The new title for the conversation.
 * @returns Success status with the updated conversation, or error if not found.
 */
export async function updateConversationTitleAction(
  conversationId: string,
  title: string,
) {
  await requireAuth();

  const conversation = await conversationsService.update(conversationId, {
    title,
  });

  if (!conversation) {
    return { success: false, error: "Conversation not found" };
  }

  revalidatePath("/dashboard/chat");
  return { success: true, conversation };
}

/**
 * Deletes a conversation.
 *
 * @param conversationId - The ID of the conversation to delete.
 * @returns Success status.
 */
export async function deleteConversationAction(conversationId: string) {
  await requireAuth();

  await conversationsService.delete(conversationId);

  revalidatePath("/dashboard/chat");
  return { success: true };
}

/**
 * Lists all conversations for the authenticated user.
 *
 * @returns Success status with array of conversations (limited to 50).
 */
export async function listUserConversationsAction() {
  const user = await requireAuth();

  const conversations = await conversationsService.listByUser(user.id, 50);

  return { success: true, conversations };
}

/**
 * Gets a conversation with its messages.
 *
 * @param conversationId - The ID of the conversation to retrieve.
 * @returns Success status with the conversation and messages, or error if not found.
 */
export async function getConversationAction(conversationId: string) {
  await requireAuth();

  const conversation =
    await conversationsService.getWithMessages(conversationId);

  if (!conversation) {
    return { success: false, error: "Conversation not found" };
  }

  return { success: true, conversation };
}
