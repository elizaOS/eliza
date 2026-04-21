/**
 * @elizaos/core/roles runtime shim.
 *
 * The published `@elizaos/core@alpha` package's `dist/index.node.d.ts`
 * declares `export * from "./roles";` but the runtime bundle
 * (`dist/index.node.js`) is missing those symbols AND the
 * `package.json` `exports` field does not expose a `./roles` subpath.
 * Every static import of `@elizaos/core/roles` — including the
 * `export * from "@elizaos/core/roles"` in
 * `packages/agent/src/runtime/roles/src/utils.ts` — therefore blows
 * up with `ERR_MODULE_NOT_FOUND` whenever Node resolves modules
 * against the published package (i.e. every CI job that runs
 * `bun install --ignore-scripts`).
 *
 * This file is a committed, pre-bundled ESM shim generated with:
 *
 *   bun build <stubs>/roles.ts --target=node --format=esm \
 *     --external='@elizaos/core' --outfile=scripts/lib/elizaos-core-roles-shim.js
 *
 * where the stubs are one-line re-exports from `@elizaos/core` for
 * `./entities` (createUniqueUuid) and `./logger` (logger). The source
 * `roles.ts` is copied verbatim from
 * `eliza/packages/typescript/src/roles.ts`. The bundle inlines the
 * role logic and leaves `createUniqueUuid` and `logger` as top-level
 * runtime imports from `@elizaos/core`, which ARE present in the
 * published main bundle.
 *
 * `scripts/lib/patch-bun-exports.mjs::patchElizaCoreRolesSubpath`
 * copies this file into every installed `@elizaos/core/dist/roles.js`
 * location and patches the corresponding `package.json` `exports`
 * field to declare `./roles`. When upstream ships the missing subpath
 * for real, this shim and its patch function can be deleted and the
 * imports will resolve to the published file directly.
 */

import { createUniqueUuid } from "@elizaos/core";
import { logger } from "@elizaos/core";

// ../../../private/tmp/rolesbundle/src/roles.ts
var DEFAULT_SERVER_ROLE = "NONE";
var ROLE_RANK = {
  GUEST: 0,
  USER: 1,
  ADMIN: 2,
  OWNER: 3
};
var CONNECTOR_ADMINS_SETTING_KEY = "ELIZA_ROLES_CONNECTOR_ADMINS_JSON";
var CANONICAL_OWNER_SETTING_KEY = "ELIZA_ADMIN_ENTITY_ID";
var OWNER_CONTACTS_SETTING_KEY = "ELIZA_OWNER_CONTACTS_JSON";
var CONNECTOR_ID_FIELDS = ["userId", "id", "username", "userName"];
var CONNECTOR_STABLE_ID_FIELDS = ["userId", "id"];
function asStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}
function normalizeConnectorAdminWhitelist(whitelist) {
  if (!whitelist || typeof whitelist !== "object")
    return {};
  return Object.fromEntries(Object.entries(whitelist).map(([connector, values]) => [connector, asStringArray(values)]).filter(([, values]) => values.length > 0));
}
function normalizeRoleGrantSource(raw) {
  if (raw === "owner" || raw === "manual" || raw === "connector_admin") {
    return raw;
  }
  return null;
}
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  return value;
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
function getRuntimeSettingString(runtime, key) {
  if (typeof runtime.getSetting !== "function") {
    return;
  }
  const value = runtime.getSetting(key);
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
function parseOwnerContactEntityIds(raw) {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return Object.values(parsed).map((entry) => entry && typeof entry.entityId === "string" ? entry.entityId.trim() : "").filter((entityId) => entityId.length > 0);
  } catch (error) {
    logger.warn(`[roles] Failed to parse owner contacts from runtime settings: ${formatError(error)}`);
    return [];
  }
}
function getMemoryMetadata(message) {
  return asRecord(message.metadata);
}
function getMessageSource(message) {
  return typeof message.content?.source === "string" ? message.content.source : undefined;
}
function getConnectorMetadataFromMemory(message) {
  const memoryMetadata = getMemoryMetadata(message);
  const source = getMessageSource(message);
  if (!source) {
    return;
  }
  const sourceMetadata = asRecord(memoryMetadata?.[source]);
  if (sourceMetadata) {
    return { [source]: sourceMetadata };
  }
  if (source === "discord") {
    const fromId = memoryMetadata?.fromId;
    if (typeof fromId !== "string" || fromId.trim().length === 0) {
      return;
    }
    const entityName = typeof memoryMetadata?.entityName === "string" ? memoryMetadata.entityName : undefined;
    return {
      discord: {
        userId: fromId,
        id: fromId,
        ...entityName ? { name: entityName, username: entityName } : {}
      }
    };
  }
  return;
}
async function getEntityMetadata(runtime, entityId) {
  if (typeof runtime.getEntityById !== "function") {
    return;
  }
  try {
    const entity = await runtime.getEntityById(entityId);
    return asRecord(entity?.metadata);
  } catch (error) {
    logger.warn(`[roles] Failed to look up entity ${entityId}: ${formatError(error)}`);
    return;
  }
}
async function getUserServerRole(runtime, entityId, serverId) {
  const worldId = createUniqueUuid(runtime, serverId);
  const world = await runtime.getWorld(worldId);
  const worldMetadata = world?.metadata;
  const roles = worldMetadata?.roles;
  if (!roles) {
    return DEFAULT_SERVER_ROLE;
  }
  const role = roles[entityId];
  if (role) {
    return role;
  }
  return DEFAULT_SERVER_ROLE;
}
async function findWorldsForOwner(runtime, entityId) {
  if (!entityId) {
    logger.error({ src: "core:roles", agentId: runtime.agentId }, "User ID is required to find server");
    return null;
  }
  const worlds = await runtime.getAllWorlds();
  if (!worlds || worlds.length === 0) {
    logger.debug({ src: "core:roles", agentId: runtime.agentId }, "No worlds found for agent");
    return null;
  }
  const ownerWorlds = [];
  for (const world of worlds) {
    const worldMetadata = world.metadata;
    const worldMetadataOwnership = worldMetadata?.ownership;
    if (worldMetadataOwnership && worldMetadataOwnership.ownerId === entityId) {
      ownerWorlds.push(world);
    }
  }
  return ownerWorlds.length ? ownerWorlds : null;
}
function getConfiguredOwnerEntityIds(runtime) {
  const configuredAdminEntityId = getRuntimeSettingString(runtime, CANONICAL_OWNER_SETTING_KEY);
  const ownerContactsRaw = getRuntimeSettingString(runtime, OWNER_CONTACTS_SETTING_KEY);
  const ownerContactEntityIds = parseOwnerContactEntityIds(ownerContactsRaw);
  const deduped = new Set;
  if (configuredAdminEntityId) {
    deduped.add(configuredAdminEntityId);
  }
  for (const entityId of ownerContactEntityIds) {
    deduped.add(entityId);
  }
  return [...deduped];
}
function hasConfiguredCanonicalOwner(runtime) {
  return getConfiguredOwnerEntityIds(runtime).length > 0;
}
function resolveCanonicalOwnerId(runtime, metadata) {
  const configuredOwnerIds = getConfiguredOwnerEntityIds(runtime);
  if (configuredOwnerIds.length > 0) {
    return configuredOwnerIds[0] ?? null;
  }
  const worldOwnerId = metadata?.ownership?.ownerId;
  return typeof worldOwnerId === "string" && worldOwnerId.length > 0 ? worldOwnerId : null;
}
function resolveOwnershipCandidateIds(runtime, metadata) {
  const configuredOwnerIds = getConfiguredOwnerEntityIds(runtime);
  if (configuredOwnerIds.length > 0) {
    return configuredOwnerIds;
  }
  const ownerId = resolveCanonicalOwnerId(runtime, metadata);
  return ownerId ? [ownerId] : [];
}
function connectorIdentityMatches(left, right) {
  if (!left || !right)
    return false;
  for (const [connector, leftRaw] of Object.entries(left)) {
    const leftConnector = asRecord(leftRaw);
    const rightConnector = asRecord(right[connector]);
    if (!leftConnector || !rightConnector) {
      continue;
    }
    for (const field of CONNECTOR_STABLE_ID_FIELDS) {
      const leftValue = leftConnector[field];
      const rightValue = rightConnector[field];
      if (typeof leftValue === "string" && leftValue.length > 0 && leftValue === rightValue) {
        return true;
      }
    }
  }
  return false;
}
async function hasConfirmedIdentityLink(runtime, entityId, ownerId) {
  const linkedIds = await getConfirmedLinkedEntityIds(runtime, entityId);
  return linkedIds.includes(ownerId);
}
async function getConfirmedLinkedEntityIds(runtime, entityId) {
  if (typeof runtime.getRelationships !== "function") {
    return [];
  }
  try {
    const relationships = await runtime.getRelationships({
      entityIds: [entityId],
      tags: ["identity_link"]
    });
    const linkedIds = new Set;
    for (const relationship of relationships) {
      const metadata = asRecord(relationship.metadata);
      if (metadata?.status !== "confirmed") {
        continue;
      }
      if (relationship.sourceEntityId === entityId && typeof relationship.targetEntityId === "string") {
        linkedIds.add(relationship.targetEntityId);
      }
      if (relationship.targetEntityId === entityId && typeof relationship.sourceEntityId === "string") {
        linkedIds.add(relationship.sourceEntityId);
      }
    }
    return [...linkedIds];
  } catch (error) {
    logger.warn(`[roles] Failed to load identity links for ${entityId}: ${formatError(error)}`);
    return [];
  }
}
async function resolveOwnershipRole(runtime, metadata, entityId, options) {
  const ownerIds = resolveOwnershipCandidateIds(runtime, metadata);
  if (ownerIds.length === 0) {
    return null;
  }
  const senderMetadata = options?.liveEntityMetadata ?? await getEntityMetadata(runtime, entityId);
  for (const ownerId of ownerIds) {
    if (ownerId === entityId) {
      return "OWNER";
    }
    if (await hasConfirmedIdentityLink(runtime, entityId, ownerId)) {
      return "OWNER";
    }
    const ownerMetadata = await getEntityMetadata(runtime, ownerId);
    if (!ownerMetadata) {
      continue;
    }
    if (connectorIdentityMatches(senderMetadata, ownerMetadata)) {
      return "OWNER";
    }
  }
  return null;
}
function resolveWorldIdFromMessageMetadata(runtime, message) {
  const source = getMessageSource(message);
  const metadata = getMemoryMetadata(message);
  if (source === "discord") {
    const serverId = typeof metadata?.discordServerId === "string" ? metadata.discordServerId : typeof metadata?.discordChannelId === "string" ? metadata.discordChannelId : null;
    if (!serverId) {
      return null;
    }
    return createUniqueUuid(runtime, serverId);
  }
  return null;
}
function setConnectorAdminWhitelist(runtime, whitelist) {
  if (typeof runtime.setSetting !== "function") {
    return;
  }
  const normalized = normalizeConnectorAdminWhitelist(whitelist);
  if (Object.keys(normalized).length === 0) {
    runtime.setSetting(CONNECTOR_ADMINS_SETTING_KEY, null);
    return;
  }
  runtime.setSetting(CONNECTOR_ADMINS_SETTING_KEY, JSON.stringify(normalized));
}
function getConnectorAdminWhitelist(runtime) {
  const raw = getRuntimeSettingString(runtime, CONNECTOR_ADMINS_SETTING_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return normalizeConnectorAdminWhitelist(parsed);
  } catch (error) {
    logger.warn(`[roles] Failed to parse ${CONNECTOR_ADMINS_SETTING_KEY}: ${formatError(error)}`);
    return {};
  }
}
function matchEntityToConnectorAdminWhitelist(entityMetadata, whitelist) {
  if (!entityMetadata || typeof entityMetadata !== "object")
    return null;
  const normalizedWhitelist = normalizeConnectorAdminWhitelist(whitelist);
  for (const [connector, platformIds] of Object.entries(normalizedWhitelist)) {
    const connectorMeta = asRecord(entityMetadata[connector]);
    if (!connectorMeta) {
      continue;
    }
    for (const field of CONNECTOR_ID_FIELDS) {
      const value = connectorMeta[field];
      if (typeof value === "string" && platformIds.includes(value)) {
        return { connector, matchedValue: value, matchedField: field };
      }
    }
  }
  return null;
}
function normalizeRole(raw) {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "OWNER" || upper === "ADMIN" || upper === "USER")
    return upper;
  return "GUEST";
}
function getEntityRole(metadata, entityId) {
  if (!metadata?.roles)
    return "GUEST";
  return normalizeRole(metadata.roles[entityId]);
}
function getStoredRoleSource(metadata, entityId) {
  return normalizeRoleGrantSource(metadata?.roleSources?.[entityId]);
}
async function resolveStoredRoleSource(runtime, metadata, entityId, options) {
  const storedSource = getStoredRoleSource(metadata, entityId);
  if (storedSource) {
    return storedSource;
  }
  const storedRole = getEntityRole(metadata, entityId);
  if (storedRole === "GUEST") {
    return null;
  }
  if (storedRole === "OWNER") {
    return "owner";
  }
  const entityMetadata = options?.liveEntityId === entityId ? options.liveEntityMetadata ?? undefined : undefined;
  const matchedWhitelist = matchEntityToConnectorAdminWhitelist(entityMetadata ?? await getEntityMetadata(runtime, entityId), getConnectorAdminWhitelist(runtime));
  if (storedRole === "ADMIN" && matchedWhitelist) {
    return "connector_admin";
  }
  return "manual";
}
async function resolveExplicitGrantedRole(runtime, metadata, entityId, options) {
  const directRole = getEntityRole(metadata, entityId);
  const directSource = await resolveStoredRoleSource(runtime, metadata, entityId, options);
  if (directRole !== "GUEST" && directSource === "manual") {
    return { role: directRole, source: "manual" };
  }
  const linkedIds = await getConfirmedLinkedEntityIds(runtime, entityId);
  let bestRole = null;
  for (const linkedEntityId of linkedIds) {
    const linkedRole = getEntityRole(metadata, linkedEntityId);
    if (linkedRole === "GUEST") {
      continue;
    }
    const linkedSource = await resolveStoredRoleSource(runtime, metadata, linkedEntityId);
    if (linkedSource !== "manual") {
      continue;
    }
    if (!bestRole || ROLE_RANK[linkedRole] > ROLE_RANK[bestRole]) {
      bestRole = linkedRole;
    }
  }
  return bestRole ? { role: bestRole, source: "linked_manual" } : null;
}
function getLiveEntityMetadataFromMessage(message) {
  return getConnectorMetadataFromMemory(message);
}
async function resolveEntityRole(runtime, _world, metadata, entityId, options) {
  const explicitRole = getEntityRole(metadata, entityId);
  const explicitSource = await resolveStoredRoleSource(runtime, metadata, entityId, options);
  const ownershipRole = await resolveOwnershipRole(runtime, metadata, entityId, options);
  if (ownershipRole === "OWNER") {
    return "OWNER";
  }
  const whitelist = getConnectorAdminWhitelist(runtime);
  const liveMatched = matchEntityToConnectorAdminWhitelist(options?.liveEntityMetadata ?? undefined, whitelist);
  if (explicitRole !== "GUEST") {
    if (explicitRole === "OWNER") {
      return hasConfiguredCanonicalOwner(runtime) ? "GUEST" : "OWNER";
    }
    if (explicitSource === "connector_admin") {
      if (Object.keys(whitelist).length === 0) {
        return "GUEST";
      }
      if (liveMatched) {
        return "ADMIN";
      }
      const entityMetadata2 = await getEntityMetadata(runtime, entityId);
      const matched2 = matchEntityToConnectorAdminWhitelist(entityMetadata2, whitelist);
      if (matched2) {
        return "ADMIN";
      }
      return "GUEST";
    }
    return explicitRole;
  }
  if (Object.keys(whitelist).length === 0) {
    return explicitRole;
  }
  if (liveMatched) {
    return "ADMIN";
  }
  const entityMetadata = await getEntityMetadata(runtime, entityId);
  const matched = matchEntityToConnectorAdminWhitelist(entityMetadata, whitelist);
  if (!matched) {
    return explicitRole;
  }
  return "ADMIN";
}
async function checkSenderPrivateAccess(runtime, message) {
  const resolved = await resolveWorldForMessage(runtime, message);
  if (!resolved)
    return null;
  const { world, metadata } = resolved;
  const entityId = message.entityId;
  const options = {
    liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
    liveEntityId: entityId
  };
  const role = await resolveEntityRole(runtime, world, metadata, entityId, options);
  const ownershipRole = await resolveOwnershipRole(runtime, metadata, entityId, options);
  if (ownershipRole === "OWNER") {
    return {
      entityId,
      role,
      isOwner: true,
      isAdmin: true,
      canManageRoles: true,
      hasPrivateAccess: true,
      accessRole: "OWNER",
      accessSource: "owner"
    };
  }
  const explicitAccess = await resolveExplicitGrantedRole(runtime, metadata, entityId, options);
  return {
    entityId,
    role,
    isOwner: false,
    isAdmin: role === "OWNER" || role === "ADMIN",
    canManageRoles: role === "OWNER" || role === "ADMIN",
    hasPrivateAccess: explicitAccess !== null,
    accessRole: explicitAccess?.role ?? null,
    accessSource: explicitAccess?.source ?? null
  };
}
function canModifyRole(actorRole, targetCurrentRole, newRole) {
  if (targetCurrentRole === newRole)
    return false;
  const actorRank = ROLE_RANK[actorRole];
  const targetRank = ROLE_RANK[targetCurrentRole];
  if (actorRole === "OWNER")
    return true;
  if (actorRole === "ADMIN") {
    if (targetRank >= actorRank)
      return false;
    if (newRole === "OWNER")
      return false;
    return true;
  }
  return false;
}
async function resolveWorldForMessage(runtime, message) {
  const room = await runtime.getRoom(message.roomId);
  const worldId = room?.worldId ?? resolveWorldIdFromMessageMetadata(runtime, message);
  if (!worldId)
    return null;
  const world = await runtime.getWorld(worldId);
  if (!world)
    return null;
  const metadata = world.metadata ?? {};
  return { world, metadata };
}
async function resolveCanonicalOwnerIdForMessage(runtime, message) {
  const configuredOwnerId = resolveCanonicalOwnerId(runtime);
  if (configuredOwnerId) {
    return configuredOwnerId;
  }
  const resolved = await resolveWorldForMessage(runtime, message);
  return resolveCanonicalOwnerId(runtime, resolved?.metadata);
}
async function checkSenderRole(runtime, message) {
  const resolved = await resolveWorldForMessage(runtime, message);
  if (!resolved)
    return null;
  const { world, metadata } = resolved;
  const entityId = message.entityId;
  const role = await resolveEntityRole(runtime, world, metadata, entityId, {
    liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
    liveEntityId: entityId
  });
  return {
    entityId,
    role,
    isOwner: role === "OWNER",
    isAdmin: role === "OWNER" || role === "ADMIN",
    canManageRoles: role === "OWNER" || role === "ADMIN"
  };
}
async function setEntityRole(runtime, message, targetEntityId, newRole, source = "manual") {
  const resolved = await resolveWorldForMessage(runtime, message);
  if (!resolved)
    throw new Error("Cannot resolve world for role assignment");
  const { world, metadata } = resolved;
  if (!metadata.roles)
    metadata.roles = {};
  metadata.roleSources ??= {};
  metadata.roles[targetEntityId] = newRole;
  if (newRole === "GUEST") {
    delete metadata.roleSources[targetEntityId];
  } else {
    metadata.roleSources[targetEntityId] = source;
  }
  world.metadata = metadata;
  await runtime.updateWorld(world);
  return { ...metadata.roles };
}
export {
  setEntityRole,
  setConnectorAdminWhitelist,
  resolveWorldForMessage,
  resolveEntityRole,
  resolveCanonicalOwnerIdForMessage,
  resolveCanonicalOwnerId,
  normalizeRole,
  matchEntityToConnectorAdminWhitelist,
  hasConfiguredCanonicalOwner,
  getUserServerRole,
  getLiveEntityMetadataFromMessage,
  getEntityRole,
  getConnectorAdminWhitelist,
  getConfiguredOwnerEntityIds,
  findWorldsForOwner,
  checkSenderRole,
  checkSenderPrivateAccess,
  canModifyRole,
  ROLE_RANK
};
