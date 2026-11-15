/**
 * Resolves the admin/owner entity id for the local client-chat surface. Prefers
 * the runtime's canonical owner id, then a previously resolved id, then the
 * configured `agents.defaults.adminEntityId`, falling back to core's
 * `deterministicOwnerEntityId` (agent-ID seed) — the same fallback LifeOps
 * reads, the scheduler, and the PA routes use — so chat-written owner
 * rows stay visible to every reader. The agent NAME seed survives only for the
 * degenerate no-runtime case. The resolved id is written back onto state as
 * both `adminEntityId` and `chatUserId`.
 */
import {
  deterministicOwnerEntityId,
  ElizaError,
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
      ? resolveCanonicalOwnerId(
          state.runtime as Pick<IAgentRuntime, "getSetting">,
        )
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
  // The deterministic fallback is core's agent-ID seed, shared with LifeOps
  // reads and the scheduler. Seeding by agent NAME here forked the owner
  // `subject_id` between the chat write path and every read path; the name
  // seed remains only for the degenerate no-runtime case.
  const runtimeAgentId =
    state.runtime && typeof state.runtime.agentId === "string"
      ? state.runtime.agentId
      : null;
  const nextAdminEntityId =
    configured && isUuidLike(configured)
      ? (configured as UUID)
      : runtimeAgentId
        ? deterministicOwnerEntityId(runtimeAgentId)
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

export type OwnerChatCallerRole = "OWNER" | "USER";

/**
 * The role an owner-authenticated chat turn (owner session or owner API token)
 * runs as, from the host setting `ELIZA_CONVERSATION_CALLER_ROLE`.
 *
 * `OWNER` (the default) is the operator chatting with their own agent. `USER`
 * is for a host whose owner credential only carries an end user's chat (a
 * consumer app's gateway): the turn then speaks as
 * {@link productUserChatEntityId} with a session-sourced USER grant, so
 * OWNER- and ADMIN-gated actions are refused in those turns. Any other value
 * throws, so a misspelled setting can never fall back to OWNER.
 *
 * This covers chat turns only (conversation messages and compat chat). Plugin
 * routes, the context inspector and the other admin APIs still treat the owner
 * credential as OWNER, so the host must keep that credential off every
 * non-chat route.
 */
export function resolveOwnerChatCallerRole(
  env: NodeJS.ProcessEnv = process.env,
): OwnerChatCallerRole {
  const value = env.ELIZA_CONVERSATION_CALLER_ROLE;
  if (value === undefined || value === "OWNER") return "OWNER";
  if (value === "USER") return "USER";
  throw new ElizaError("ELIZA_CONVERSATION_CALLER_ROLE must be OWNER or USER", {
    code: "INVALID_CONVERSATION_CALLER_ROLE",
    context: { value },
  });
}

/**
 * The entity an owner-authenticated chat turn speaks as under
 * `ELIZA_CONVERSATION_CALLER_ROLE=USER`. It is never the admin entity, so the
 * admin entity's stored OWNER world grant is not reused for these turns. Its
 * seed has no `conversation-external:` prefix, so no external principal id can
 * derive the same entity and inherit its USER grant.
 */
export function productUserChatEntityId(): UUID {
  return stringToUuid("owner-chat-product-user:v1") as UUID;
}
