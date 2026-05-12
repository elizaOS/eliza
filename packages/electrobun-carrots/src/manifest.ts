import {
  flattenCarrotPermissions,
  normalizeCarrotPermissions,
} from "./permissions.js";
import {
  BUN_PERMISSIONS,
  type BunPermission,
  type CarrotInstallSource,
  type CarrotManifest,
  type CarrotPermissionConsentRequest,
  type CarrotPermissionGrant,
  type CarrotPermissionTag,
  HOST_PERMISSIONS,
  type HostPermission,
} from "./types.js";

export interface CarrotPermissionDiff {
  requestedPermissions: CarrotPermissionTag[];
  changedPermissions: CarrotPermissionTag[];
  hostPermissions: HostPermission[];
  bunPermissions: BunPermission[];
  isolation: NonNullable<CarrotPermissionGrant["isolation"]>;
}

export interface CarrotConsentRequestInput {
  requestId: string;
  manifest: CarrotManifest;
  source: CarrotInstallSource;
  sourceLabel: string;
  message: string;
  confirmLabel: string;
  previousGrant?: CarrotPermissionGrant | null;
}

function sourceKind(
  source: CarrotInstallSource,
): CarrotPermissionConsentRequest["sourceKind"] {
  return source.kind;
}

function enabledHostPermissions(
  permissions: CarrotPermissionGrant,
): HostPermission[] {
  return HOST_PERMISSIONS.filter(
    (permission) => permissions.host?.[permission] === true,
  );
}

function enabledBunPermissions(
  permissions: CarrotPermissionGrant,
): BunPermission[] {
  return BUN_PERMISSIONS.filter(
    (permission) => permissions.bun?.[permission] === true,
  );
}

export function diffCarrotPermissions(
  requested: CarrotPermissionGrant,
  previous?: CarrotPermissionGrant | null,
): CarrotPermissionDiff {
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
  manifest: CarrotManifest,
): CarrotPermissionTag[] {
  return flattenCarrotPermissions(manifest.permissions);
}

export function buildCarrotPermissionConsentRequest(
  input: CarrotConsentRequestInput,
): CarrotPermissionConsentRequest {
  const diff = diffCarrotPermissions(
    input.manifest.permissions,
    input.previousGrant,
  );
  return {
    requestId: input.requestId,
    carrotId: input.manifest.id,
    carrotName: input.manifest.name,
    version: input.manifest.version,
    sourceKind: sourceKind(input.source),
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
