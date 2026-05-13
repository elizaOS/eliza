import {
  BUN_PERMISSIONS,
  type BunPermission,
  CARROT_ISOLATIONS,
  type CarrotIsolation,
  type CarrotManifest,
  type CarrotMode,
  type CarrotPermissionGrant,
  HOST_PERMISSIONS,
  type HostPermission,
  type JsonObject,
  type JsonValue,
} from "./types.js";

export interface CarrotManifestValidationIssue {
  path: string;
  message: string;
}

export type CarrotManifestValidationResult =
  | { ok: true; manifest: CarrotManifest }
  | { ok: false; issues: CarrotManifestValidationIssue[] };

const CARROT_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isValidCarrotId(value: string): boolean {
  return CARROT_ID_PATTERN.test(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isCarrotIsolation(
  value: JsonValue | undefined,
): value is CarrotIsolation {
  return (
    typeof value === "string" &&
    CARROT_ISOLATIONS.some((entry) => entry === value)
  );
}

function objectAt(
  value: JsonValue | undefined,
  path: string,
  issues: CarrotManifestValidationIssue[],
): JsonObject | null {
  if (isJsonObject(value)) {
    return value;
  }
  issues.push({ path, message: "Expected object." });
  return null;
}

function stringAt(
  object: JsonObject,
  key: string,
  path: string,
  issues: CarrotManifestValidationIssue[],
): string | null {
  const value = object[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  issues.push({
    path: `${path}.${key}`,
    message: "Expected non-empty string.",
  });
  return null;
}

function optionalBooleanAt(
  value: JsonValue | undefined,
  path: string,
  issues: CarrotManifestValidationIssue[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  issues.push({ path, message: "Expected boolean." });
  return undefined;
}

function numberAt(
  object: JsonObject,
  key: string,
  path: string,
  issues: CarrotManifestValidationIssue[],
): number | null {
  const value = object[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  issues.push({ path: `${path}.${key}`, message: "Expected finite number." });
  return null;
}

function optionalStringAt(
  object: JsonObject,
  key: string,
  path: string,
  issues: CarrotManifestValidationIssue[],
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  issues.push({ path: `${path}.${key}`, message: "Expected string." });
  return undefined;
}

function validateMode(
  value: JsonValue | undefined,
  issues: CarrotManifestValidationIssue[],
): CarrotMode | null {
  if (value === "window" || value === "background") return value;
  issues.push({ path: "mode", message: "Expected window or background." });
  return null;
}

function validateBooleanRecord<K extends string>(
  value: JsonValue | undefined,
  path: string,
  allowed: readonly K[],
  issues: CarrotManifestValidationIssue[],
): Partial<Record<K, boolean>> | undefined {
  if (value === undefined) return undefined;
  const object = objectAt(value, path, issues);
  if (!object) return undefined;
  const allowedSet = new Set<string>(allowed);
  const output: Partial<Record<K, boolean>> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (!allowedSet.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "Unknown permission." });
      continue;
    }
    if (typeof entry !== "boolean") {
      issues.push({ path: `${path}.${key}`, message: "Expected boolean." });
      continue;
    }
    output[key as K] = entry;
  }
  return output;
}

function validatePermissions(
  value: JsonValue | undefined,
  issues: CarrotManifestValidationIssue[],
): CarrotPermissionGrant | null {
  const object = objectAt(value, "permissions", issues);
  if (!object) return null;
  const host = validateBooleanRecord<HostPermission>(
    object.host,
    "permissions.host",
    HOST_PERMISSIONS,
    issues,
  );
  const bun = validateBooleanRecord<BunPermission>(
    object.bun,
    "permissions.bun",
    BUN_PERMISSIONS,
    issues,
  );
  const grant: CarrotPermissionGrant = {};
  if (host) grant.host = host;
  if (bun) grant.bun = bun;
  const isolation = object.isolation;
  if (isolation === undefined) {
    grant.isolation = "shared-worker";
  } else if (isCarrotIsolation(isolation)) {
    grant.isolation = isolation;
  } else {
    issues.push({
      path: "permissions.isolation",
      message: "Expected shared-worker or isolated-process.",
    });
  }
  return grant;
}

function validateStringMap(
  value: JsonValue | undefined,
  path: string,
  issues: CarrotManifestValidationIssue[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const object = objectAt(value, path, issues);
  if (!object) return undefined;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== "string") {
      issues.push({ path: `${path}.${key}`, message: "Expected string." });
      continue;
    }
    output[key] = entry;
  }
  return output;
}

function validateRemoteUIs(
  value: JsonValue | undefined,
  issues: CarrotManifestValidationIssue[],
): CarrotManifest["remoteUIs"] {
  if (value === undefined) return undefined;
  const object = objectAt(value, "remoteUIs", issues);
  if (!object) return undefined;
  const output: NonNullable<CarrotManifest["remoteUIs"]> = {};
  for (const [key, entry] of Object.entries(object)) {
    const remote = objectAt(entry, `remoteUIs.${key}`, issues);
    if (!remote) continue;
    const name = stringAt(remote, "name", `remoteUIs.${key}`, issues);
    const path = stringAt(remote, "path", `remoteUIs.${key}`, issues);
    if (name && path) {
      output[key] = { name, path };
    }
  }
  return output;
}

function validateView(
  value: JsonValue | undefined,
  issues: CarrotManifestValidationIssue[],
): CarrotManifest["view"] | null {
  const object = objectAt(value, "view", issues);
  if (!object) return null;
  const relativePath = stringAt(object, "relativePath", "view", issues);
  const title = stringAt(object, "title", "view", issues);
  const width = numberAt(object, "width", "view", issues);
  const height = numberAt(object, "height", "view", issues);
  const titleBarStyle = optionalStringAt(
    object,
    "titleBarStyle",
    "view",
    issues,
  );
  if (
    titleBarStyle !== undefined &&
    titleBarStyle !== "hidden" &&
    titleBarStyle !== "hiddenInset" &&
    titleBarStyle !== "default"
  ) {
    issues.push({
      path: "view.titleBarStyle",
      message: "Expected hidden, hiddenInset, or default.",
    });
  }
  const hidden = optionalBooleanAt(object.hidden, "view.hidden", issues);
  const transparent = optionalBooleanAt(
    object.transparent,
    "view.transparent",
    issues,
  );
  if (!relativePath || !title || width === null || height === null) return null;
  return {
    relativePath,
    title,
    width,
    height,
    ...(hidden === undefined ? {} : { hidden }),
    ...(titleBarStyle === undefined ||
    (titleBarStyle !== "hidden" &&
      titleBarStyle !== "hiddenInset" &&
      titleBarStyle !== "default")
      ? {}
      : { titleBarStyle }),
    ...(transparent === undefined ? {} : { transparent }),
  };
}

function validateWorker(
  value: JsonValue | undefined,
  issues: CarrotManifestValidationIssue[],
): CarrotManifest["worker"] | null {
  const object = objectAt(value, "worker", issues);
  if (!object) return null;
  const relativePath = stringAt(object, "relativePath", "worker", issues);
  return relativePath ? { relativePath } : null;
}

export function validateCarrotManifest(
  value: JsonValue,
): CarrotManifestValidationResult {
  const issues: CarrotManifestValidationIssue[] = [];
  const object = objectAt(value, "$", issues);
  if (!object) return { ok: false, issues };

  const id = stringAt(object, "id", "$", issues);
  if (id && !isValidCarrotId(id)) {
    issues.push({
      path: "$.id",
      message:
        "Expected carrot id segments containing only letters, numbers, underscores, hyphens, or dots.",
    });
  }
  const name = stringAt(object, "name", "$", issues);
  const version = stringAt(object, "version", "$", issues);
  const description = stringAt(object, "description", "$", issues);
  const mode = validateMode(object.mode, issues);
  const permissions = validatePermissions(object.permissions, issues);
  const view = validateView(object.view, issues);
  const worker = validateWorker(object.worker, issues);
  const dependencies = validateStringMap(
    object.dependencies,
    "dependencies",
    issues,
  );
  const remoteUIs = validateRemoteUIs(object.remoteUIs, issues);

  if (
    issues.length > 0 ||
    !id ||
    !name ||
    !version ||
    !description ||
    !mode ||
    !permissions ||
    !view ||
    !worker
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      description,
      mode,
      ...(dependencies === undefined ? {} : { dependencies }),
      permissions,
      view,
      worker,
      ...(remoteUIs === undefined ? {} : { remoteUIs }),
    },
  };
}
