/**
 * Local re-export surface for the permission-registry contract types
 * (PermissionId, PermissionState, PermissionStatus, Prober, and friends),
 * sourced from @elizaos/core so probers and the registry import them from a
 * single path.
 */
export {
  type IPermissionsRegistry,
  type PermissionId,
  type PermissionRestrictedReason,
  type PermissionState,
  type PermissionStatus,
  type Platform as PermissionPlatform,
  type Prober,
} from "@elizaos/core/contracts/permissions";
