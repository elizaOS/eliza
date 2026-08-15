/**
 * Derives the account-native personal Eliza identity used by Shared chat.
 *
 * The identity is deterministic from the authenticated account and exists
 * without an agent_sandboxes row. Every transport that resolves the same
 * account therefore addresses the same Durable Object conversation history.
 */

import { v5 as uuidv5 } from "uuid";
import type { AgentSandbox } from "../../../db/schemas/agent-sandboxes";
import { getElizaAgentPublicWebUiUrl } from "../../eliza-agent-web-ui";
import { getDefaultElizaCharacterData } from "../../utils/default-eliza-character";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

const PERSONAL_SHARED_AGENT_NAMESPACE = "af8f7624-42f8-4da8-bdf1-593b1a0d7f20";
const PERSONAL_SHARED_GUILD_VOICE_NAMESPACE = "b9ea4ce5-636d-4ec4-bc75-6308188f883f";
const PERSONAL_SHARED_AGENT_PREFIX = "personal:";

export interface PersonalSharedAccountIdentity {
  userId: string;
  organizationId: string;
}

/** Stable namespaced id used for Durable Object routing and mirrored history. */
export function personalSharedAgentId(identity: PersonalSharedAccountIdentity): string {
  return `${PERSONAL_SHARED_AGENT_PREFIX}${uuidv5(
    `${identity.organizationId.trim()}:${identity.userId.trim()}`,
    PERSONAL_SHARED_AGENT_NAMESPACE,
  )}`;
}

/** True only for the namespace reserved for rowless account-native identities. */
export function isPersonalSharedAgentId(value: string): boolean {
  return /^personal:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * A public guild voice room must never reuse the owner's private cross-channel
 * room. This stable UUID retains guild-voice continuity without importing DM,
 * phone, SMS, or Telegram history into a room where other people can listen.
 */
export function personalSharedGuildVoiceRoomId(input: {
  agentId: string;
  discordUserId: string;
  guildId: string;
  channelId: string;
}): string {
  return uuidv5(
    [input.agentId, input.discordUserId, input.guildId, input.channelId].join(":"),
    PERSONAL_SHARED_GUILD_VOICE_NAMESPACE,
  );
}

function localBridgeApiBase(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      !loopback ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    // error-policy:J3 a malformed stored endpoint is explicitly unavailable.
    return null;
  }
}

/** Resolve the same Dedicated agent base for cutover and future account login. */
export function personalDedicatedAgentApiBase(
  target: Pick<AgentSandbox, "id" | "headscale_ip" | "bridge_url">,
  baseDomain?: string,
): string | null {
  const publicBase = getElizaAgentPublicWebUiUrl(target, {
    baseDomain: baseDomain ?? undefined,
  });
  if (publicBase) return publicBase;

  // The local cloud harness deliberately passes the non-domain sentinel
  // `https://` so no fake public agent hostname is synthesized. Only that
  // explicit mode may fall back to the server-owned loopback bridge; accepting
  // arbitrary stored hosts here would turn an account bearer into an SSRF
  // credential leak. Production's configured domain always wins above.
  return baseDomain === undefined ? null : localBridgeApiBase(target.bridge_url);
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
