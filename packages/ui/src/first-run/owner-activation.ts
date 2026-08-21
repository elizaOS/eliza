/**
 * Resolve the selected agent's canonical private conversation and invoke the
 * server-owned, idempotent owner-activation boundary before onboarding hands
 * control to live chat.
 */

import type { Conversation } from "../api";

export interface OwnerActivationClient {
  listConversations(): Promise<{ conversations: Conversation[] }>;
  createConversation(title?: string): Promise<{
    conversation: Conversation;
  }>;
  activateOwnerFirstRun(roomId: string): Promise<OwnerActivationResponse>;
}

export interface OwnerActivationResponse {
  outcome: "activated" | "already_complete" | "exempt";
  entry: {
    status: "complete" | "exempt";
    roomId?: string;
    exemptReason?: string;
  };
}

/**
 * The conversation list comes from the currently bound client, so selecting a
 * cloud agent and then calling this function cannot activate a stale agent.
 */
export async function activateOwnerAfterFirstRun(
  activationClient: OwnerActivationClient,
  preferredConversationId?: string | null,
): Promise<{
  conversation: Conversation;
  activation: OwnerActivationResponse;
}> {
  const { conversations } = await activationClient.listConversations();
  const conversation =
    conversations.find((item) => item.id === preferredConversationId) ??
    conversations[0] ??
    (await activationClient.createConversation("New Chat")).conversation;
  const activation = await activationClient.activateOwnerFirstRun(
    conversation.roomId,
  );
  return { conversation, activation };
}
