/**
 * Canonicalizes integrity-bound corpus artifacts with explicit compatibility
 * policies for progressive-content and reviewed-deletion persisted hashes.
 */

import { ElizaError } from "@elizaos/core";

type UndefinedObjectPropertyPolicy = "reject" | "omit";

interface CanonicalJsonPolicy {
  readonly name: string;
  readonly undefinedObjectProperty: UndefinedObjectPropertyPolicy;
}

const PROGRESSIVE_CONTENT_POLICY: CanonicalJsonPolicy = {
  name: "progressive-content-v1",
  undefinedObjectProperty: "reject",
};

const DELETION_ARTIFACT_POLICY: CanonicalJsonPolicy = {
  name: "deletion-artifact-v1",
  undefinedObjectProperty: "omit",
};

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function unsupportedValue(
  policy: CanonicalJsonPolicy,
  path: string,
  value: unknown,
): ElizaError {
  const valueType =
    typeof value === "number" && !Number.isFinite(value)
      ? "non-finite number"
      : typeof value;
  return new ElizaError(
    `${policy.name} canonical JSON does not support ${valueType} at ${path}`,
    {
      code: "CORPUS_CANONICAL_JSON_UNSUPPORTED_VALUE",
      context: { policy: policy.name, path, valueType },
    },
  );
}

function canonicalize(
  value: unknown,
  policy: CanonicalJsonPolicy,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw unsupportedValue(policy, path, value);
      return JSON.stringify(value);
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw unsupportedValue(policy, path, value);
  }

  if (ancestors.has(value)) {
    throw new ElizaError(
      `${policy.name} canonical JSON does not support a cycle at ${path}`,
      {
        code: "CORPUS_CANONICAL_JSON_CYCLE",
        context: { policy: policy.name, path },
      },
    );
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const children: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw unsupportedValue(policy, `${path}[${index}]`, undefined);
        }
        children.push(
          canonicalize(value[index], policy, `${path}[${index}]`, ancestors),
        );
      }
      return `[${children.join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
      const child = record[key];
      if (child === undefined && policy.undefinedObjectProperty === "omit") {
        continue;
      }
      entries.push(
        `${JSON.stringify(key)}:${canonicalize(child, policy, `${path}.${key}`, ancestors)}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown, policy: CanonicalJsonPolicy): string {
  return canonicalize(value, policy, "$", new Set<object>());
}

/** Canonical bytes used by progressive-content manifests and format fixtures. */
export function canonicalProgressiveContentJson(value: unknown): string {
  return canonicalJson(value, PROGRESSIVE_CONTENT_POLICY);
}

/** Canonical bytes used by reviewed-deletion queues, decisions, and reports. */
export function canonicalDeletionArtifactJson(value: unknown): string {
  return canonicalJson(value, DELETION_ARTIFACT_POLICY);
}
