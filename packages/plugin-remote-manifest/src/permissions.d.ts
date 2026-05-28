import {
  type BunPermission,
  type HostPermission,
  type LegacyRemotePluginPermission,
  type RemotePluginIsolation,
  type RemotePluginPermissionGrant,
  type RemotePluginPermissionTag,
} from "./types.js";
export type RemotePluginBunWorkerPermissions = Record<BunPermission, boolean>;
export declare function isHostPermission(
  value: string,
): value is HostPermission;
export declare function isBunPermission(value: string): value is BunPermission;
export declare function isRemotePluginIsolation(
  value: string,
): value is RemotePluginIsolation;
export declare function normalizeRemotePluginPermissions(
  input?: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null,
): RemotePluginPermissionGrant;
export declare function flattenRemotePluginPermissions(
  input?: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null,
): RemotePluginPermissionTag[];
export declare function mergeRemotePluginPermissions(
  defaults?:
    | RemotePluginPermissionGrant
    | LegacyRemotePluginPermission[]
    | null,
  overrides?:
    | RemotePluginPermissionGrant
    | LegacyRemotePluginPermission[]
    | null,
): RemotePluginPermissionGrant;
export declare function hasHostPermission(
  input:
    | RemotePluginPermissionGrant
    | LegacyRemotePluginPermission[]
    | null
    | undefined,
  permission: HostPermission,
): boolean;
export declare function hasBunPermission(
  input:
    | RemotePluginPermissionGrant
    | LegacyRemotePluginPermission[]
    | null
    | undefined,
  permission: BunPermission,
): boolean;
export declare function toBunWorkerPermissions(
  permissions: RemotePluginPermissionGrant,
): RemotePluginBunWorkerPermissions;
export declare function parseRemotePluginPermissionTag(
  tag: string,
): RemotePluginPermissionTag | null;
export declare function isRemotePluginPermissionTag(
  tag: string,
): tag is RemotePluginPermissionTag;
//# sourceMappingURL=permissions.d.ts.map
