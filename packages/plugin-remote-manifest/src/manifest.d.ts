import {
  type BunPermission,
  type HostPermission,
  type RemotePluginInstallSource,
  type RemotePluginManifest,
  type RemotePluginPermissionConsentRequest,
  type RemotePluginPermissionGrant,
  type RemotePluginPermissionTag,
} from "./types.js";
export interface RemotePluginPermissionDiff {
  requestedPermissions: RemotePluginPermissionTag[];
  changedPermissions: RemotePluginPermissionTag[];
  hostPermissions: HostPermission[];
  bunPermissions: BunPermission[];
  isolation: NonNullable<RemotePluginPermissionGrant["isolation"]>;
}
export interface RemotePluginConsentRequestInput {
  requestId: string;
  manifest: RemotePluginManifest;
  source: RemotePluginInstallSource;
  sourceLabel: string;
  message: string;
  confirmLabel: string;
  previousGrant?: RemotePluginPermissionGrant | null;
}
export declare function diffRemotePluginPermissions(
  requested: RemotePluginPermissionGrant,
  previous?: RemotePluginPermissionGrant | null,
): RemotePluginPermissionDiff;
export declare function getRemotePluginManifestPermissionTags(
  manifest: RemotePluginManifest,
): RemotePluginPermissionTag[];
export declare function buildRemotePluginPermissionConsentRequest(
  input: RemotePluginConsentRequestInput,
): RemotePluginPermissionConsentRequest;
//# sourceMappingURL=manifest.d.ts.map
