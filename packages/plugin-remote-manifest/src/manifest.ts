import {
  flattenCarrotPermissions,
  normalizeCarrotPermissions,
} from "./permissions.js";
import {
  BUN_PERMISSIONS,
  type BunPermission,
  type RemotePluginInstallSource,
  type RemotePluginManifest,
  type RemotePluginPermissionConsentRequest,
  type RemotePluginPermissionGrant,
  type RemotePluginPermissionTag,
  HOST_PERMISSIONS,
  type HostPermission,
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

function enabledHostPermissions(
  permissions: RemotePluginPermissionGrant,
): HostPermission[] {
  return HOST_PERMISSIONS.filter(
    (permission) => permissions.host?.[permission] === true,
  );
}

function enabledBunPermissions(
  permissions: RemotePluginPermissionGrant,
): BunPermission[] {
  return BUN_PERMISSIONS.filter(
    (permission) => permissions.bun?.[permission] === true,
  );
}

export function diffCarrotPermissions(
  requested: RemotePluginPermissionGrant,
  previous?: RemotePluginPermissionGrant | null,
): RemotePluginPermissionDiff {
  const normalized = normalizeCarrotPermissions(requested);
  const requestedPermissions = flattenCarrotPermissions(normalized);
  const previousPermissions = new Set(flattenCarrotPermissions(previous));
  const changedPermissions = requestedPermissions.filter(
    (permission) => !previousPermissions.has(permission),
  );

  return {
    requestedPermissions,
    changedPermissions,
    hostPermissions: enabledHostPermissions(normalized),
    bunPermissions: enabledBunPermissions(normalized),
    isolation: normalized.isolation ?? "shared-worker",
  };
}

export function getCarrotManifestPermissionTags(
  manifest: RemotePluginManifest,
): RemotePluginPermissionTag[] {
  return flattenCarrotPermissions(manifest.permissions);
}

export function buildCarrotPermissionConsentRequest(
  input: RemotePluginConsentRequestInput,
): RemotePluginPermissionConsentRequest {
  const diff = diffCarrotPermissions(
    input.manifest.permissions,
    input.previousGrant,
  );
  return {
    requestId: input.requestId,
    remotePluginId: input.manifest.id,
    remotePluginName: input.manifest.name,
    version: input.manifest.version,
    sourceKind: input.source.kind,
    sourceLabel: input.sourceLabel,
    message: input.message,
    confirmLabel: input.confirmLabel,
    requestedPermissions: diff.requestedPermissions,
    changedPermissions: diff.changedPermissions,
    hostPermissions: diff.hostPermissions,
    bunPermissions: diff.bunPermissions,
    isolation: diff.isolation,
  };
}
