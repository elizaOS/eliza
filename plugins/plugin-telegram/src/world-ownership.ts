/**
 * Ownership metadata for Telegram worlds. Decides which entity, if any, is
 * recorded as `ownership.ownerId` (and granted the world-level OWNER role)
 * when a Telegram chat's world is first created.
 *
 * Only the configured canonical owner of the deployment may own a Telegram
 * world. Anyone can create a group and add the bot, so the chat's creator is
 * connector provenance, not app ownership: like Discord's guild owner, it is
 * recorded as a `connector_admin` ADMIN grant, which the connector-admin
 * whitelist decides at read time. The arbitrary message sender must NEVER be
 * a fallback: the previous `canonicalOwnerId ?? userId` default made every DM
 * sender the OWNER of their own DM world in deployments without a configured
 * canonical owner (the fail-open #12087 Item 2 removed from core's
 * `buildDmWorldMetadata`). Without a canonical owner the world carries no
 * ownership metadata and senders resolve through the normal role machinery.
 */
import {
  type Role,
  type RolesWorldMetadata,
  recordOwnerGrant,
  recordRoleGrant,
} from "@elizaos/core";

export type TelegramWorldOwnership = {
  ownership?: { ownerId: string };
  roles: Record<string, Role>;
  roleSources?: RolesWorldMetadata["roleSources"];
};

/**
 * Resolve the ownership + role grants for a new Telegram world.
 *
 * @param canonicalOwnerId configured deployment owner (ELIZA_ADMIN_ENTITY_ID),
 *   if any — the only identity that may own the world.
 * @param chatCreatorEntityId runtime entity id of the chat's creator (group /
 *   supergroup / channel "creator" admin), if known — recorded as a
 *   connector-admin grant, mirroring Discord's guild-owner grant.
 */
export function buildTelegramWorldOwnership(
  canonicalOwnerId: string | null | undefined,
  chatCreatorEntityId: string | null | undefined,
): TelegramWorldOwnership {
  const metadata: TelegramWorldOwnership = { roles: {} };
  // Both grants write only OWNER/ADMIN, which are World roles.
  const grants = metadata as RolesWorldMetadata;
  if (canonicalOwnerId) {
    metadata.ownership = { ownerId: canonicalOwnerId };
    recordOwnerGrant(grants, canonicalOwnerId);
  }
  if (chatCreatorEntityId && chatCreatorEntityId !== canonicalOwnerId) {
    recordRoleGrant(grants, chatCreatorEntityId, "ADMIN", "connector_admin");
  }
  return metadata;
}
