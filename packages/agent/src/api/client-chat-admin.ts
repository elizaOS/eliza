import {
  type IAgentRuntime,
  logger,
  resolveCanonicalOwnerId,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

import { isUuidLike } from "./server-helpers.ts";

type ClientChatAdminState = {
  runtime?: IAgentRuntime | { getSetting?: (key: string) => unknown } | null;
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
  const nextAdminEntityId =
    configured && isUuidLike(configured)
      ? (configured as UUID)
      : (stringToUuid(`${state.agentName}-admin-entity`) as UUID);
  if (configured && !isUuidLike(configured)) {
    logger.warn(
      `[eliza-api] Invalid agents.defaults.adminEntityId "${configured}", using deterministic fallback`,
    );
  }

  state.adminEntityId = nextAdminEntityId;
  state.chatUserId = nextAdminEntityId;
  return nextAdminEntityId;
}
