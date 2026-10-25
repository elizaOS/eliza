/**
 * Ownership metadata for Telegram worlds. Decides which entity, if any, is
 * recorded as `ownership.ownerId` (and granted the world-level OWNER role)
 * when a Telegram chat's world is first created.
 *
 * Only two identities may ever own a Telegram world: the configured canonical
 * owner of the deployment, or — for group chats — the chat's creator (the
 * Telegram-side analogue of Discord's guild owner). The arbitrary message
 * sender must NEVER be the fallback: the previous `canonicalOwnerId ?? userId`
 * default made every DM sender the OWNER of their own DM world in deployments
 * without a configured canonical owner, clearing every `minRole: OWNER` gate
 * (SHELL, SECRETS, …) for any stranger who could DM the bot — the same
 * fail-open that #12087 Item 2 removed from core's `buildDmWorldMetadata`.
 * When neither identity exists, the world carries no ownership metadata and
 * senders resolve through the normal role machinery (GUEST unless granted).
 */
import { Role } from "@elizaos/core";

export type TelegramWorldOwnership = {
  ownership?: { ownerId: string };
  roles: Record<string, Role>;
};

/**
 * Resolve the ownership + role grants for a new Telegram world.
 *
 * @param canonicalOwnerId configured deployment owner (ELIZA_ADMIN_ENTITY_ID),
 *   if any — always wins.
 * @param chatCreatorEntityId runtime entity id of the chat's creator (group /
 *   supergroup / channel "creator" admin), if known — used only when no
 *   canonical owner is configured, mirroring Discord's guild-owner grant.
 */
export function buildTelegramWorldOwnership(
  canonicalOwnerId: string | null | undefined,
  chatCreatorEntityId: string | null | undefined,
): TelegramWorldOwnership {
  const ownerId = canonicalOwnerId ?? chatCreatorEntityId ?? null;
  if (!ownerId) {
    return { roles: {} };
  }
  return {
    ownership: { ownerId },
    roles: { [ownerId]: Role.OWNER },
  };
}
