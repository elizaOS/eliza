/**
 * Local re-export surface for the permission-registry contract types
 * (PermissionId, PermissionState, PermissionStatus, Prober, and friends),
 * sourced from @elizaos/shared so probers and the registry import them from a
 * single path.
 */
export type {
  IPermissionsRegistry,
  PermissionId,
  PermissionRestrictedReason,
  PermissionState,
  PermissionStatus,
  Platform as PermissionPlatform,
  Prober,
} from "@elizaos/shared";
