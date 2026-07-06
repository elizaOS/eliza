/**
 * Canonical JSON serialization for signed evidence files. Certification signs
 * sha256(manifest bytes), so the byte form must be a pure function of the
 * value: object keys sorted by UTF-16 code unit, arrays in caller order, no
 * insignificant whitespace, UTF-8 encoding, and exactly one trailing newline
 * (the newline is part of the signed bytes). Values JSON cannot represent
 * deterministically (non-finite numbers, bigint, functions, symbols) throw
 * instead of degrading to `null` — a fabricated `null` in a signed manifest
 * would be silent data loss.
 */

import { EvidenceError } from "./errors.ts";

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new EvidenceError(
          `canonical JSON cannot represent non-finite number at ${path}`,
          { code: "CANONICAL_UNSERIALIZABLE", context: { path } },
        );
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item, index) => {
          if (item === undefined) {
            throw new EvidenceError(
              `canonical JSON cannot represent undefined array element at ${path}[${index}]`,
              { code: "CANONICAL_UNSERIALIZABLE", context: { path, index } },
            );
          }
          return canonicalize(item, `${path}[${index}]`);
        });
        return `[${items.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      const members = keys.map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`,
      );
      return `{${members.join(",")}}`;
    }
    default:
      throw new EvidenceError(
        `canonical JSON cannot represent ${typeof value} at ${path}`,
        {
          code: "CANONICAL_UNSERIALIZABLE",
          context: { path, kind: typeof value },
        },
      );
  }
}

/** Serialize `value` to its canonical JSON text (no trailing newline). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new EvidenceError("canonical JSON cannot represent undefined", {
      code: "CANONICAL_UNSERIALIZABLE",
    });
  }
  return canonicalize(value, "$");
}

/** Canonical UTF-8 bytes of `value`: canonical JSON plus one trailing newline. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
