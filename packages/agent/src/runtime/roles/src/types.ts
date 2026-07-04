/**
 * Re-exports the role type contract (RoleName, RolesConfig, role-check results,
 * grant sources, world metadata, and ROLE_RANK) from `@elizaos/core` through the
 * in-repo roles path so runtime code sources role types from one place.
 */
export type {
  ConnectorAdminWhitelist,
  RoleCheckResult,
  RoleGrantSource,
  RoleName,
  RolesConfig,
  RolesWorldMetadata,
} from "@elizaos/core";
export { ROLE_RANK } from "@elizaos/core";
