import { type SQL, sql } from "drizzle-orm";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // If we ever receive an unserializable value (e.g. circular structure),
    // fall back to an empty object rather than exploding a non-critical write.
    return "{}";
  }
}

/**
 * Bind a JS value as a JSONB parameter explicitly.
 *
 * This avoids driver differences (notably Neon serverless) when binding raw
 * objects directly as query parameters.
 */
export function jsonbParam(value: unknown): SQL {
  // Postgres expects valid JSON here; default undefined/null to empty object.
  const json = safeJsonStringify(value ?? {});
  return sql`${json}::jsonb`;
}
