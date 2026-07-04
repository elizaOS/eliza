/**
 * Browser build of `./utils`: filesystem-backed path resolution has no
 * meaning in-browser, so these are fixed-value stubs; `sanitizeJsonObject` is
 * the real, shared implementation (mirrored in `./utils.node.ts`).
 */
export function expandTildePath(filepath: string): string {
  return filepath;
}

export function resolveEnvFile(_startDir?: string): string {
  return ".env";
}

export function resolvePgliteDir(_dir?: string, _fallbackDir?: string): string {
  return "in-memory";
}

export function sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Strips NUL characters: PostgreSQL/PGlite jsonb rejects the `\u0000`
    // escape JSON.stringify emits for them. Nothing else needs rewriting here --
    // the value is serialized with JSON.stringify, which already escapes
    // backslashes and control characters correctly; re-escaping them here
    // would corrupt already-escaped strings (e.g. "C:\Users") on a
    // write/read round-trip.
    return value.replace(new RegExp(String.fromCharCode(0), "g"), "");
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return null;
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonObject(item, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const sanitizedKey =
        typeof key === "string" ? key.replace(new RegExp(String.fromCharCode(0), "g"), "") : key;
      result[sanitizedKey] = sanitizeJsonObject(val, seen);
    }
    return result;
  }

  return value;
}
