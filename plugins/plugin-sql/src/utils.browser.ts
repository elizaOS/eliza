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
    const nullChar = String.fromCharCode(0);
    const nullCharRegex = new RegExp(nullChar, "g");
    return value
      .replace(nullCharRegex, "")
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
      .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u");
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
    const nullChar = String.fromCharCode(0);
    const nullCharRegex = new RegExp(nullChar, "g");
    for (const [key, val] of Object.entries(value)) {
      const sanitizedKey =
        typeof key === "string"
          ? key.replace(nullCharRegex, "").replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
          : key;
      result[sanitizedKey] = sanitizeJsonObject(val, seen);
    }
    return result;
  }

  return value;
}
