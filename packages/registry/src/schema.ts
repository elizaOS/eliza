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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

  const knownKeys = new Set([
    "package",
    "repository",
    "kind",
    "description",
    "homepage",
    "version",
    "directory",
    "tags",
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
