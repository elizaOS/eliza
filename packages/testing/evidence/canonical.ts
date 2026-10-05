/**
 * Canonical JSON serialization for signed evidence files. Certification signs
 * sha256(manifest bytes), so the byte form must be a pure function of the
 * value: object keys sorted by UTF-16 code unit, arrays in caller order, no
 * insignificant whitespace, UTF-8 encoding, and exactly one trailing newline
 * (the newline is part of the signed bytes). Values JSON cannot represent
 * deterministically throw instead of degrading — non-finite numbers, bigint,
 * functions, symbols, AND any object whose prototype is not `Object.prototype`
 * or `null` (Date/Map/Set/class instances would silently serialize as `{}`,
 * and `toJSON` is deliberately not honored: strictness beats convenience on a
 * signing surface; callers pre-serialize to plain data). JCS-style caveat: no
 * general string normalization is performed here — only artifact *paths* are
 * NFC-normalized, at ingress in `bundle.ts` addArtifact, so macOS NFD vs
 * linux NFC filenames cannot yield different manifest bytes.
 */

import { EvidenceError } from "./errors.ts";

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
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
      if (ancestors.has(value)) {
        throw new EvidenceError(
          `canonical JSON cannot represent a cycle at ${path}`,
          {
            code: "CANONICAL_UNSERIALIZABLE",
            context: { path },
          },
        );
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, index);
            if (
              !descriptor ||
              !("value" in descriptor) ||
              descriptor.value === undefined
            ) {
              throw new EvidenceError(
                `canonical JSON requires a defined data element at ${path}[${index}]`,
                { code: "CANONICAL_UNSERIALIZABLE", context: { path, index } },
              );
            }
            items.push(
              canonicalize(descriptor.value, `${path}[${index}]`, ancestors),
            );
          }
          return `[${items.join(",")}]`;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new EvidenceError(
            `canonical JSON cannot represent a non-plain object at ${path}`,
            {
              code: "CANONICAL_UNSERIALIZABLE",
              context: { path, constructor: proto?.constructor?.name },
            },
          );
        }
        const members: string[] = [];
        for (const key of Object.keys(value).sort()) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) {
            throw new EvidenceError(
              `canonical JSON cannot evaluate an accessor at ${path}.${key}`,
              {
                code: "CANONICAL_UNSERIALIZABLE",
                context: { path, key },
              },
            );
          }
          if (descriptor.value !== undefined) {
            members.push(
              `${JSON.stringify(key)}:${canonicalize(descriptor.value, `${path}.${key}`, ancestors)}`,
            );
          }
        }
        return `{${members.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
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
  return canonicalize(value, "$", new Set());
}

/** Canonical UTF-8 bytes of `value`: canonical JSON plus one trailing newline. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
