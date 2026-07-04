/**
 * Re-exports the role-resolution helpers (sender/entity role checks, canonical
 * owner resolution, connector-admin whitelist accessors, role read/write, and
 * live-message metadata lookups) from `@elizaos/core` through the in-repo roles
 * path.
 */
export {
  canModifyRole,
  checkSenderPrivateAccess,
  checkSenderRole,
  getConfiguredOwnerEntityIds,
  getConnectorAdminWhitelist,
  getEntityRole,
  getLiveEntityMetadataFromMessage,
  hasConfiguredCanonicalOwner,
  matchEntityToConnectorAdminWhitelist,
  normalizeRole,
  resolveCanonicalOwnerId,
  resolveCanonicalOwnerIdForMessage,
  resolveEntityRole,
  resolveWorldForMessage,
  setConnectorAdminWhitelist,
  setEntityRole,
} from "@elizaos/core";
