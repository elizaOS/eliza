import {
  BUN_PERMISSIONS,
  type BunPermission,
  REMOTE_PLUGIN_ISOLATIONS,
  type RemotePluginIsolation,
  type RemotePluginPermissionGrant,
  type RemotePluginPermissionTag,
  HOST_PERMISSIONS,
  type HostPermission,
  type LegacyRemotePluginPermission,
} from "./types.js";

export type RemotePluginBunWorkerPermissions = Record<BunPermission, boolean>;

export function isHostPermission(value: string): value is HostPermission {
  return HOST_PERMISSIONS.includes(value as HostPermission);
}

export function isBunPermission(value: string): value is BunPermission {
  return BUN_PERMISSIONS.includes(value as BunPermission);
}

export function isCarrotIsolation(value: string): value is RemotePluginIsolation {
  return REMOTE_PLUGIN_ISOLATIONS.includes(value as RemotePluginIsolation);
}

export function normalizeCarrotPermissions(
  input?: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null,
): RemotePluginPermissionGrant {
  const host: Partial<Record<HostPermission, boolean>> = {};
  const bun: Partial<Record<BunPermission, boolean>> = {};
  let isolation: RemotePluginIsolation = "shared-worker";

  if (Array.isArray(input)) {
    for (const permission of input) {
      if (permission === "bun:fs") {
        bun.read = true;
        bun.write = true;
      } else if (permission === "bun:env") {
        bun.env = true;
      } else if (permission === "bun:child_process") {
        bun.run = true;
      } else if (permission === "bun:ffi") {
        bun.ffi = true;
      } else if (permission === "bun:addons") {
        bun.addons = true;
      } else if (isHostPermission(permission)) {
        host[permission] = true;
      }
    }
    return { host, bun, isolation };
  }

  if (input?.host) {
    Object.assign(host, input.host);
  }
  if (input?.bun) {
    Object.assign(bun, input.bun);
  }
  if (input?.isolation) {
    isolation = input.isolation;
  }
  return { host, bun, isolation };
}

export function flattenCarrotPermissions(
  input?: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null,
): RemotePluginPermissionTag[] {
  const permissions = normalizeCarrotPermissions(input);
  const tags: RemotePluginPermissionTag[] = [];

  for (const key of HOST_PERMISSIONS) {
    if (permissions.host?.[key] === true) {
      tags.push(`host:${key}`);
    }
  }
  for (const key of BUN_PERMISSIONS) {
    if (permissions.bun?.[key] === true) {
      tags.push(`bun:${key}`);
    }
  }
  tags.push(`isolation:${permissions.isolation ?? "shared-worker"}`);
  return tags;
}

export function mergeCarrotPermissions(
  defaults?: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null,
  overrides?: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null,
): RemotePluginPermissionGrant {
  const base = normalizeCarrotPermissions(defaults);
  const extra = normalizeCarrotPermissions(overrides);
  return {
    host: {
      ...base.host,
      ...extra.host,
    },
    bun: {
      ...base.bun,
      ...extra.bun,
    },
    isolation: extra.isolation ?? base.isolation ?? "shared-worker",
  };
}

export function hasHostPermission(
  input: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null | undefined,
  permission: HostPermission,
): boolean {
  return normalizeCarrotPermissions(input).host?.[permission] === true;
}

export function hasBunPermission(
  input: RemotePluginPermissionGrant | LegacyRemotePluginPermission[] | null | undefined,
  permission: BunPermission,
): boolean {
  return normalizeCarrotPermissions(input).bun?.[permission] === true;
}

export function toBunWorkerPermissions(
  permissions: RemotePluginPermissionGrant,
): RemotePluginBunWorkerPermissions {
  const normalized = normalizeCarrotPermissions(permissions);
  return Object.fromEntries(
    BUN_PERMISSIONS.map((permission) => [
      permission,
      normalized.bun?.[permission] === true,
    ]),
  ) as RemotePluginBunWorkerPermissions;
}

export function parseCarrotPermissionTag(
  tag: string,
): RemotePluginPermissionTag | null {
  const parts = tag.split(":");
  if (parts.length !== 2) return null;
  const [scope, value] = parts;
  if (scope === "host" && value && isHostPermission(value)) {
    return `host:${value}`;
  }
  if (scope === "bun" && value && isBunPermission(value)) {
    return `bun:${value}`;
  }
  if (scope === "isolation" && value && isCarrotIsolation(value)) {
    return `isolation:${value}`;
  }
  return null;
}

export function isCarrotPermissionTag(tag: string): tag is RemotePluginPermissionTag {
  return parseCarrotPermissionTag(tag) !== null;
}
