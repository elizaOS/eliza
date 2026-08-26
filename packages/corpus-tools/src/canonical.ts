/**
 * Canonical JSON serialization and hashing primitives for @elizaos/corpus-tools.
 * Centralizes deterministic serialization for progressive manifests and deletion artifacts.
 */
import { createHash } from "node:crypto";

/**
 * Serializes values using progressive-content canonical JSON ordering.
 * Arrays preserve order; objects are sorted by Unicode code-point key order.
 * Non-object primitives are serialized with JSON.stringify.
 */
export function canonicalJsonProgressive(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonProgressive).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonProgressive(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Serializes values using deletion-artifact canonical JSON ordering.
 * Omits keys with undefined values and sorts object keys with localeCompare.
 */
export function canonicalJsonDeletion(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonDeletion).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalJsonDeletion(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Computes a SHA-256 hex digest of a string or buffer.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
