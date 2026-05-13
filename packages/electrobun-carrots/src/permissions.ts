import {
  BUN_PERMISSIONS,
  type BunPermission,
  CARROT_ISOLATIONS,
  type CarrotIsolation,
  type CarrotPermissionGrant,
  type CarrotPermissionTag,
  HOST_PERMISSIONS,
  type HostPermission,
  type LegacyCarrotPermission,
} from "./types.js";

export type CarrotBunWorkerPermissions = Record<BunPermission, boolean>;

function isHostPermission(value: string): value is HostPermission {
  return HOST_PERMISSIONS.includes(value as HostPermission);
}

function isBunPermission(value: string): value is BunPermission {
  return BUN_PERMISSIONS.includes(value as BunPermission);
}

function isCarrotIsolation(value: string): value is CarrotIsolation {
  return CARROT_ISOLATIONS.includes(value as CarrotIsolation);
}

export function normalizeCarrotPermissions(
  input?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
): CarrotPermissionGrant {
  const host: Partial<Record<HostPermission, boolean>> = {};
  const bun: Partial<Record<BunPermission, boolean>> = {};
  let isolation: CarrotIsolation = "shared-worker";

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
  input?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
): CarrotPermissionTag[] {
  const permissions = normalizeCarrotPermissions(input);
  const tags: CarrotPermissionTag[] = [];

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
  defaults?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
  overrides?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
): CarrotPermissionGrant {
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
  input: CarrotPermissionGrant | LegacyCarrotPermission[] | null | undefined,
  permission: HostPermission,
): boolean {
  return normalizeCarrotPermissions(input).host?.[permission] === true;
}

export function hasBunPermission(
  input: CarrotPermissionGrant | LegacyCarrotPermission[] | null | undefined,
  permission: BunPermission,
): boolean {
  return normalizeCarrotPermissions(input).bun?.[permission] === true;
}

export function toBunWorkerPermissions(
  permissions: CarrotPermissionGrant,
): CarrotBunWorkerPermissions {
  return {
    read: hasBunPermission(permissions, "read"),
    write: hasBunPermission(permissions, "write"),
    env: hasBunPermission(permissions, "env"),
    run: hasBunPermission(permissions, "run"),
    ffi: hasBunPermission(permissions, "ffi"),
    addons: hasBunPermission(permissions, "addons"),
    worker: hasBunPermission(permissions, "worker"),
  };
}

export function parseCarrotPermissionTag(
  tag: string,
): CarrotPermissionTag | null {
  const [scope, value] = tag.split(":");
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

export function isCarrotPermissionTag(tag: string): tag is CarrotPermissionTag {
  return parseCarrotPermissionTag(tag) !== null;
}
