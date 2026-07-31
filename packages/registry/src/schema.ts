/**
 * Validation for source registry entries. Dependency-free so it runs in any
 * tooling context (CLI, CI, the typed loader) without pulling in a schema
 * library. The JSON Schema in `schema/registry-entry.schema.json` mirrors these
 * rules for editors and external validators.
 */

import type { RegistryEntry, RegistryEntryKind } from "./types.ts";

const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VALID_KINDS: readonly RegistryEntryKind[] = [
  "plugin",
  "connector",
  "app",
];
const VALID_SESSION_MODES = new Set([
  "viewer",
  "spectate-and-steer",
  "external",
]);
const VALID_SESSION_FEATURES = new Set([
  "commands",
  "telemetry",
  "pause",
  "resume",
  "suggestions",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateKnownKeys(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
  path: string,
): string[] {
  const known = new Set(knownKeys);
  return Object.keys(value)
    .filter((key) => !known.has(key))
    .map((key) => `unknown field: ${path}.${key}`);
}

function validateOptionalString(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string[] {
  return value[field] !== undefined && typeof value[field] !== "string"
    ? [`${path}.${field} must be a string when present`]
    : [];
}

function validateOptionalBoolean(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string[] {
  return value[field] !== undefined && typeof value[field] !== "boolean"
    ? [`${path}.${field} must be a boolean when present`]
    : [];
}

function validateOptionalNullableString(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string[] {
  return value[field] !== undefined &&
    value[field] !== null &&
    typeof value[field] !== "string"
    ? [`${path}.${field} must be a string or null when present`]
    : [];
}

function validateOptionalPlayerCount(
  value: Record<string, unknown>,
  field: string,
): string[] {
  const count = value[field];
  return count !== undefined &&
    count !== null &&
    (typeof count !== "number" || !Number.isInteger(count) || count < 0)
    ? [`app.${field} must be a non-negative integer or null when present`]
    : [];
}

function validateAppViewer(value: unknown): string[] {
  if (!isRecord(value)) return ["app.viewer must be an object when present"];
  const errors = validateKnownKeys(
    value,
    ["url", "embedParams", "postMessageAuth", "sandbox"],
    "app.viewer",
  );
  if (typeof value.url !== "string" || value.url.length === 0) {
    errors.push("app.viewer.url must be a non-empty string");
  }
  if (value.embedParams !== undefined) {
    if (
      !isRecord(value.embedParams) ||
      Object.values(value.embedParams).some(
        (entry) => typeof entry !== "string",
      )
    ) {
      errors.push(
        "app.viewer.embedParams must be an object of string values when present",
      );
    }
  }
  errors.push(
    ...validateOptionalBoolean(value, "postMessageAuth", "app.viewer"),
    ...validateOptionalString(value, "sandbox", "app.viewer"),
  );
  return errors;
}

function validateAppSession(value: unknown): string[] {
  if (!isRecord(value)) return ["app.session must be an object when present"];
  const errors = validateKnownKeys(value, ["mode", "features"], "app.session");
  if (typeof value.mode !== "string" || !VALID_SESSION_MODES.has(value.mode)) {
    errors.push(
      `app.session.mode must be one of: ${Array.from(VALID_SESSION_MODES).join(", ")}`,
    );
  }
  if (
    value.features !== undefined &&
    (!isStringArray(value.features) ||
      value.features.some((feature) => !VALID_SESSION_FEATURES.has(feature)))
  ) {
    errors.push(
      `app.session.features must contain only: ${Array.from(VALID_SESSION_FEATURES).join(", ")}`,
    );
  }
  return errors;
}

function validateAppMetadata(value: unknown): string[] {
  if (!isRecord(value)) return ["app must be an object for app entries"];
  const errors = validateKnownKeys(
    value,
    [
      "displayName",
      "category",
      "launchType",
      "launchUrl",
      "icon",
      "heroImage",
      "capabilities",
      "minPlayers",
      "maxPlayers",
      "runtimePlugin",
      "bridgeExport",
      "uiExtension",
      "viewer",
      "session",
      "developerOnly",
      "visibleInAppStore",
      "mainTab",
      "catalogSection",
      "featured",
      "defaultHidden",
      "scope",
    ],
    "app",
  );

  for (const field of ["displayName", "category", "launchType"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      errors.push(`app.${field} must be a non-empty string`);
    }
  }
  for (const field of ["launchUrl", "icon"]) {
    if (value[field] !== null && typeof value[field] !== "string") {
      errors.push(`app.${field} must be a string or null`);
    }
  }
  if (!isStringArray(value.capabilities)) {
    errors.push("app.capabilities must be an array of strings");
  }
  errors.push(
    ...validateOptionalNullableString(value, "heroImage", "app"),
    ...validateOptionalString(value, "runtimePlugin", "app"),
    ...validateOptionalString(value, "bridgeExport", "app"),
    ...validateOptionalString(value, "catalogSection", "app"),
    ...validateOptionalString(value, "scope", "app"),
    ...validateOptionalPlayerCount(value, "minPlayers"),
    ...validateOptionalPlayerCount(value, "maxPlayers"),
  );

  for (const field of [
    "developerOnly",
    "visibleInAppStore",
    "mainTab",
    "featured",
    "defaultHidden",
  ]) {
    errors.push(...validateOptionalBoolean(value, field, "app"));
  }

  if (value.uiExtension !== undefined) {
    if (!isRecord(value.uiExtension)) {
      errors.push("app.uiExtension must be an object when present");
    } else {
      errors.push(
        ...validateKnownKeys(
          value.uiExtension,
          ["detailPanelId"],
          "app.uiExtension",
        ),
      );
      if (
        typeof value.uiExtension.detailPanelId !== "string" ||
        value.uiExtension.detailPanelId.length === 0
      ) {
        errors.push("app.uiExtension.detailPanelId must be a non-empty string");
      }
    }
  }
  if (value.viewer !== undefined) {
    errors.push(...validateAppViewer(value.viewer));
  }
  if (value.session !== undefined) {
    errors.push(...validateAppSession(value.session));
  }

  const minPlayers = value.minPlayers;
  const maxPlayers = value.maxPlayers;
  if (
    typeof minPlayers === "number" &&
    typeof maxPlayers === "number" &&
    minPlayers > maxPlayers
  ) {
    errors.push("app.minPlayers must not exceed app.maxPlayers");
  }
  return errors;
}

/**
 * Validate a parsed JSON value as a {@link RegistryEntry}. Returns the list of
 * problems; an empty list means the value is a valid entry.
 */
export function validateRegistryEntry(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["entry must be a JSON object"];
  }

  const pkg = value.package;
  if (typeof pkg !== "string" || !PACKAGE_NAME_RE.test(pkg)) {
    errors.push("package must be a valid npm package name");
  } else if (pkg.startsWith("@elizaos/")) {
    errors.push("package must not use the reserved @elizaos/* scope");
  }

  if (
    typeof value.repository !== "string" ||
    !REPOSITORY_RE.test(value.repository)
  ) {
    errors.push('repository must be of the form "github:owner/repo"');
  }

  if (!VALID_KINDS.includes(value.kind as RegistryEntryKind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(", ")}`);
  }

  for (const field of ["description", "homepage", "version", "directory"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      errors.push(`${field} must be a string when present`);
    }
  }

  if (value.tags !== undefined && !isStringArray(value.tags)) {
    errors.push("tags must be an array of strings when present");
  }

  if (value.kind === "app") {
    errors.push(...validateAppMetadata(value.app));
  } else if (value.app !== undefined) {
    errors.push("app metadata is only allowed when kind is app");
  }

  const knownKeys = new Set([
    "package",
    "repository",
    "kind",
    "description",
    "homepage",
    "version",
    "directory",
    "tags",
    "app",
  ]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  return errors;
}

/** Validate and narrow, throwing on the first batch of errors. */
export function assertRegistryEntry(
  value: unknown,
  source: string,
): RegistryEntry {
  const errors = validateRegistryEntry(value);
  if (errors.length > 0) {
    throw new Error(
      `Invalid registry entry (${source}):\n  - ${errors.join("\n  - ")}`,
    );
  }
  return value as RegistryEntry;
}
