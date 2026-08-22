/**
 * Resolves the admin/owner entity id for the local client-chat surface. Prefers
 * the runtime's canonical owner id, then a previously resolved id, then the
 * configured `agents.defaults.adminEntityId`, falling back to the same
 * deterministic agent-ID-seeded UUID that `defaultOwnerEntityId` in
 * `@elizaos/shared` produces (agent name only when no runtime is present); the
 * resolved id is written back onto state
 * as both `adminEntityId` and `chatUserId`.
 */
import {
  type IAgentRuntime,
  logger,
  resolveCanonicalOwnerId,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

import { isUuidLike } from "./server-helpers.ts";

type ClientChatAdminState = {
  runtime?:
    | IAgentRuntime
    | { agentId?: UUID; getSetting?: (key: string) => unknown }
    | null;
  adminEntityId?: UUID | null;
  chatUserId?: UUID | null;
  config?: {
    agents?: {
      defaults?: {
        adminEntityId?: string;
      };
    };
  } | null;
  agentName: string;
};

export function resolveClientChatAdminEntityId<
  TState extends ClientChatAdminState,
>(state: TState): UUID {
  const canonicalOwnerId =
    state.runtime && typeof state.runtime.getSetting === "function"
      ? resolveCanonicalOwnerId(state.runtime as IAgentRuntime)
      : null;
  if (canonicalOwnerId && isUuidLike(canonicalOwnerId)) {
    state.adminEntityId = canonicalOwnerId as UUID;
    state.chatUserId = state.adminEntityId;
    return state.adminEntityId;
  }

  if (state.adminEntityId) {
    state.chatUserId = state.adminEntityId;
    return state.adminEntityId;
  }

  const configuredValue = state.config?.agents?.defaults?.adminEntityId;
  const configured =
    typeof configuredValue === "string" ? configuredValue.trim() : undefined;
  // The deterministic fallback must match `defaultOwnerEntityId` in
  // `@elizaos/shared` (agent-ID seed), which scopes LifeOps reads and the
  // scheduler. Seeding by agent NAME here forked the owner `subject_id`
  // between the chat write path and every read path; the name seed remains
  // only for the degenerate no-runtime case.
  const runtimeAgentId =
    state.runtime && typeof state.runtime.agentId === "string"
      ? state.runtime.agentId
      : null;
  const nextAdminEntityId =
    configured && isUuidLike(configured)
      ? (configured as UUID)
      : (stringToUuid(
          `${runtimeAgentId ?? state.agentName}-admin-entity`,
        ) as UUID);
  if (configured && !isUuidLike(configured)) {
    logger.warn(
      `[eliza-api] Invalid agents.defaults.adminEntityId "${configured}", using deterministic fallback`,
    );
  }

  state.adminEntityId = nextAdminEntityId;
  state.chatUserId = nextAdminEntityId;
  return nextAdminEntityId;
}
