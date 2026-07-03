import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function expandTildePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(process.cwd(), filepath.slice(1));
  }
  return filepath;
}

export function resolveEnvFile(startDir: string = process.cwd()): string {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.join(startDir, ".env");
}

export function resolvePgliteDir(dir?: string, fallbackDir?: string): string {
  const envPath = resolveEnvFile();
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  let monoPath: string | undefined;
  if (existsSync(path.join(process.cwd(), "packages", "core"))) {
    monoPath = process.cwd();
  } else {
    const twoUp = path.resolve(process.cwd(), "../.."); // assuming running from package
    if (existsSync(path.join(twoUp, "packages", "core"))) {
      monoPath = twoUp;
    }
  }

  const base =
    dir ??
    process.env.PGLITE_DATA_DIR ??
    fallbackDir ??
    (monoPath ? path.join(monoPath, ".eliza", ".elizadb") : undefined) ??
    path.join(process.cwd(), ".eliza", ".elizadb");

  return expandTildePath(base);
}

export function sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Strip NUL characters: PostgreSQL/PGlite jsonb rejects the `\u0000`
    // escape JSON.stringify emits for them. Nothing else needs rewriting —
    // the sanitized value is serialized with JSON.stringify, which already
    // escapes backslashes and control characters correctly. (This function
    // used to double every backslash not followed by ["\/bfnrtu] and mangle
    // non-hex `\u` sequences, so a value like "C:\Users" came back as
    // "C:\\Users" after a write/read round-trip — silent data corruption.)
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
