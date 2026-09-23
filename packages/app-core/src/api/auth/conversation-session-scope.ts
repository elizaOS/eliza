/**
 * Resolves conversation data scope from an authenticated persistent actor using
 * existing conversation identities and verified core membership. Pairing alone
 * grants no rooms, and owner administration never replaces room containment.
 * This resolver grants no mutations and does not cover compat chat identities.
 */
import { resolveClientChatAdminEntityId } from "@elizaos/agent/api/client-chat-admin";
import { resolveConversationExternalEntityId } from "@elizaos/agent/api/conversation-routes";
import {
  type AccessContext,
  type AgentRuntime,
  ElizaError,
  getVerifiedRelatedEntityIds,
  type UUID,
} from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/shared";
import type { PersistentSessionActor } from "./persistent-session-admission";

/** Construct only after measured host admission, with the host's fixed runtime. */
export function createConversationSessionScope(input: {
  runtime: AgentRuntime;
  config: ElizaConfig;
}) {
  const runtime = input.runtime;
  const agentName = runtime.character.name;
  if (!agentName) {
    throw new ElizaError("Conversation scope requires a named runtime", {
      code: "CONVERSATION_RUNTIME_IDENTITY_REQUIRED",
    });
  }
  const ownerState = {
    runtime,
    config: structuredClone(input.config),
    agentName,
    adminEntityId: null as UUID | null,
    chatUserId: null as UUID | null,
  };
  return async (
    actor: Readonly<PersistentSessionActor>,
  ): Promise<AccessContext & { authorizedRoomIds: readonly UUID[] }> => {
    const isOwner = actor.identityKind === "owner";
    const requesterEntityId = isOwner
      ? resolveClientChatAdminEntityId(ownerState)
      : resolveConversationExternalEntityId(actor.identityId);
    const authorizedRoomIds = await runtime.adapter.transaction(
      async (transaction) => {
        const identities = await getVerifiedRelatedEntityIds(
          runtime,
          requesterEntityId,
        );
        // Both reads share the same transaction owner; nested SQLite operations
        // must finish before sibling work begins.
        const requesterRooms =
          await transaction.getRoomsForParticipants(identities);
        const agentRooms = await transaction.getRoomsForParticipants([
          runtime.agentId,
        ]);
        const agentMembership = new Set(agentRooms);
        return [...new Set(requesterRooms)].filter((roomId) =>
          agentMembership.has(roomId),
        );
      },
    );
    return {
      requesterEntityId,
      role: isOwner ? "OWNER" : "USER",
      isOwner,
      source: "persistent-conversation-session",
      authorizedRoomIds,
    };
  };
}
