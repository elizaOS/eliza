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
/** Logical values copied into one jsonb bind before the write fails closed. */
export const MAX_SQL_JSON_SANITIZE_NODES = 10_000;
export const SQL_JSON_SANITIZE_UNBOUNDED = "SQL_JSON_SANITIZE_UNBOUNDED";

function failUnbounded(context: Record<string, unknown>, cause?: unknown): never {
  throw new ElizaError("sql json sanitize exceeded its safe structural budget", {
    code: SQL_JSON_SANITIZE_UNBOUNDED,
    context,
    cause,
    severity: "fatal",
  });
}

interface SanitizeContext {
  seen: WeakSet<object>;
  visits: number;
}

/**
 * Prepare a value for `JSON.stringify` + `$1::jsonb`. Circular references
 * become `null`. Depth past {@link MAX_SQL_JSON_SANITIZE_DEPTH} fails closed.
 */
export function sanitizeJsonObject(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  return sanitizeJsonValue(value, { seen, visits: 0 }, 0);
}

function sanitizeJsonValue(value: unknown, context: SanitizeContext, depth: number): unknown {
  if (depth > MAX_SQL_JSON_SANITIZE_DEPTH) {
    failUnbounded({ depth, max: MAX_SQL_JSON_SANITIZE_DEPTH });
  }

  context.visits += 1;
  if (context.visits > MAX_SQL_JSON_SANITIZE_NODES) {
    failUnbounded({
      visits: context.visits,
      max: MAX_SQL_JSON_SANITIZE_NODES,
    });
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

  if (typeof value === "object") {
    if (context.seen.has(value)) {
      return null;
    }
    context.seen.add(value);

    try {
      if (value instanceof Date) {
        const timestamp = Date.prototype.getTime.call(value);
        return Number.isFinite(timestamp) ? Date.prototype.toISOString.call(value) : null;
      }

      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        const length = lengthDescriptor?.value;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_SQL_JSON_SANITIZE_NODES - context.visits
        ) {
          failUnbounded({
            reason: "array-length",
            length: typeof length === "number" ? length : "invalid",
            max: MAX_SQL_JSON_SANITIZE_NODES,
          });
        }
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor && ("get" in descriptor || "set" in descriptor)) {
            failUnbounded({ reason: "array-accessor", index });
          }
          result.push(sanitizeJsonValue(descriptor?.value, context, depth + 1));
        }
        return result;
      }

      const result: Record<string, unknown> = {};
      for (const key in value) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if ("get" in descriptor || "set" in descriptor) {
          failUnbounded({ reason: "object-accessor" });
        }
        const sanitizedKey = key.replace(new RegExp(String.fromCharCode(0), "g"), "");
        const sanitizedValue = sanitizeJsonValue(descriptor.value, context, depth + 1);
        if (sanitizedKey === "toJSON" && typeof sanitizedValue === "function") {
          failUnbounded({ reason: "custom-toJSON" });
        }
        result[sanitizedKey] = sanitizedValue;
      }
      return result;
    } catch (error) {
      if (error instanceof ElizaError && error.code === SQL_JSON_SANITIZE_UNBOUNDED) {
        throw error;
      }
      // error-policy:J2 reflection failures are wrapped without leaking input.
      failUnbounded({ reason: "reflection" }, error);
    }
  }

  return value;
}
