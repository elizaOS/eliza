/**
 * Re-export of the permission contract types from `@elizaos/shared`.
 *
 * This file used to contain a local stub while sibling agents landed the
 * shared definitions in parallel. Now that the shared contract is canonical,
 * everything routes through it.
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
