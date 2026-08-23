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

const PERSONAL_SHARED_DISCORD_GUILD_NAMESPACE = "b9ea4ce5-636d-4ec4-bc75-6308188f883f";

import {
  type PersonalSharedAccountIdentity,
  personalSharedAgentId,
} from "./personal-shared-identity";

export {
  isCanonicalPersonalSharedAgent,
  isPersonalSharedAgentId,
  type PersonalSharedAccountIdentity,
  personalSharedAgentId,
} from "./personal-shared-identity";

/**
 * A public Discord guild room must never reuse the owner's private cross-channel
 * room. This stable UUID retains channel continuity without importing DM,
 * phone, SMS, or Telegram history into a room other members can observe.
 */
export function personalSharedDiscordGuildRoomId(input: {
  agentId: string;
  discordUserId: string;
  guildId: string;
  channelId: string;
}): string {
  return uuidv5(
    [input.agentId, input.discordUserId, input.guildId, input.channelId].join(":"),
    PERSONAL_SHARED_DISCORD_GUILD_NAMESPACE,
  );
}

/** Compatibility name retained for existing guild-voice callers. */
export const personalSharedGuildVoiceRoomId = personalSharedDiscordGuildRoomId;

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

function localRestApiBase(value: string | null | undefined): string | null {
  const healthBase = localBridgeApiBase(value ?? null);
  if (!healthBase) return null;
  const url = new URL(healthBase);
  return url.origin;
}

/** Resolve the same Dedicated agent base for cutover and future account login. */
export function personalDedicatedAgentApiBase(
  target: Pick<AgentSandbox, "id" | "headscale_ip" | "bridge_url"> & {
    health_url?: string | null;
  },
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
  return baseDomain === undefined
    ? null
    : (localRestApiBase(target.health_url) ?? localBridgeApiBase(target.bridge_url));
}

/** Resolve the browser-facing base; local Docker stays behind the Cloud proxy. */
export function personalDedicatedClientApiBase(
  target: Pick<AgentSandbox, "id" | "headscale_ip" | "bridge_url"> & {
    health_url?: string | null;
  },
  baseDomain: string | undefined,
  cloudApiOrigin: string,
): string | null {
  const runtimeBase = personalDedicatedAgentApiBase(target, baseDomain);
  if (!runtimeBase) return null;
  if (baseDomain !== "https://") return runtimeBase;
  const origin = new URL(cloudApiOrigin).origin;
  // ElizaClient appends `/api/...` to its configured base. Point it at the
  // agent-scoped proxy root, not the proxy's `/api` child, or requests become
  // `/api/api/...` and never reach the runtime.
  return `${origin}/api/v1/eliza/agents/${encodeURIComponent(target.id)}`;
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
