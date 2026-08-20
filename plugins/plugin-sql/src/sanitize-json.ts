/**
 * Shared jsonb sanitizer for SQL writes. Strips NULs (PostgreSQL rejects
 * JSON.stringify's `\u0000` escape), breaks cycles, and fails closed on
 * hostile nesting so a log/memory body cannot RangeError the adapter.
 *
 * `utils.ts`, `utils.node.ts`, and `utils.browser.ts` re-export this so the
 * three platform builds cannot drift.
 */
import { ElizaError } from "@elizaos/core";

/** Nesting ceiling. Honest log/memory bodies are a handful of objects deep. */
export const MAX_SQL_JSON_SANITIZE_DEPTH = 64;
export const SQL_JSON_SANITIZE_UNBOUNDED = "SQL_JSON_SANITIZE_UNBOUNDED";

function failUnbounded(context: Record<string, unknown>): never {
  throw new ElizaError(`sql json sanitize exceeds ${MAX_SQL_JSON_SANITIZE_DEPTH} nesting depth`, {
    code: SQL_JSON_SANITIZE_UNBOUNDED,
    context,
    severity: "fatal",
  });
}

/**
 * Prepare a value for `JSON.stringify` + `$1::jsonb`. Circular references
 * become `null`. Depth past {@link MAX_SQL_JSON_SANITIZE_DEPTH} fails closed.
 */
export function sanitizeJsonObject(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown {
  if (depth > MAX_SQL_JSON_SANITIZE_DEPTH) {
    failUnbounded({ depth, max: MAX_SQL_JSON_SANITIZE_DEPTH });
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Strips NUL characters: PostgreSQL/PGlite jsonb rejects the `\u0000`
    // escape JSON.stringify emits for them. Nothing else needs rewriting here —
    // the value is serialized with JSON.stringify, which already escapes
    // backslashes and control characters correctly; re-escaping them here
    // would corrupt already-escaped strings (e.g. "C:\Users") on a
    // write/read round-trip.
    return value.replace(new RegExp(String.fromCharCode(0), "g"), "");
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return null;
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonObject(item, seen, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const sanitizedKey =
        typeof key === "string" ? key.replace(new RegExp(String.fromCharCode(0), "g"), "") : key;
      result[sanitizedKey] = sanitizeJsonObject(val, seen, depth + 1);
    }
    return result;
  }

  return value;
}
