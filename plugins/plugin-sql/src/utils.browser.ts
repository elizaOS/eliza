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
    // Strip NUL characters: PostgreSQL/PGlite jsonb rejects the `\u0000`
    // escape JSON.stringify emits for them. Nothing else needs rewriting --
    // the sanitized value is serialized with JSON.stringify, which already
    // escapes backslashes and control characters correctly. (This function
    // used to double every backslash not followed by ["\/bfnrtu] and mangle
    // non-hex `\u` sequences, so a value like "C:\Users" came back as
    // "C:\\Users" after a write/read round-trip -- silent data corruption.)
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
