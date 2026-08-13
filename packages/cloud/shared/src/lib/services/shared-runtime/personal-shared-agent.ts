/**
 * Derives the account-native personal Eliza identity used by Shared chat.
 *
 * The identity is deterministic from the authenticated account and exists
 * without an agent_sandboxes row. Every transport that resolves the same
 * account therefore addresses the same Durable Object conversation history.
 */

import { v5 as uuidv5 } from "uuid";
import { getDefaultElizaCharacterData } from "../../utils/default-eliza-character";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

const PERSONAL_SHARED_AGENT_NAMESPACE = "af8f7624-42f8-4da8-bdf1-593b1a0d7f20";

export interface PersonalSharedAccountIdentity {
  userId: string;
  organizationId: string;
}

/** Stable UUID used for Durable Object routing and mirrored conversation rows. */
export function personalSharedAgentId(identity: PersonalSharedAccountIdentity): string {
  return uuidv5(
    `${identity.organizationId.trim()}:${identity.userId.trim()}`,
    PERSONAL_SHARED_AGENT_NAMESPACE,
  );
}

/** Build the rowless runtime projection for the authenticated account. */
export function personalSharedAgent(identity: PersonalSharedAccountIdentity): SharedRuntimeAgent {
  const character = getDefaultElizaCharacterData();
  return {
    id: personalSharedAgentId(identity),
    organization_id: identity.organizationId,
    user_id: identity.userId,
    character_id: null,
    agent_name: character.name,
    agent_config: { character },
    execution_tier: "shared",
  };
}
