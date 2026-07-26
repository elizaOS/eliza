/**
 * Adapts a PostgreSQL URI for libpq clients without changing its connection
 * identity or security options. Provider-specific client hints are removed
 * only when libpq rejects them before establishing a connection.
 */

const LIBPQ_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export function toLibpqConnectionUrl(value: string): string {
  if (!value) {
    throw new Error("database URL is required");
  }

  const url = new URL(value);
  if (!LIBPQ_PROTOCOLS.has(url.protocol)) {
    throw new Error("database URL must use PostgreSQL");
  }

  const compatibilityHints = [...url.searchParams].filter(
    ([key]) => key.toLowerCase() === "uselibpqcompat",
  );
  if (
    compatibilityHints.length > 1 ||
    compatibilityHints.some(
      ([key, hint]) => key !== "uselibpqcompat" || hint !== "true",
    )
  ) {
    throw new Error("database URL has an invalid libpq compatibility hint");
  }
  if (compatibilityHints.length === 1) {
    url.searchParams.delete("uselibpqcompat");
  }
  return url.toString();
}

if (import.meta.main) {
  process.stdout.write(toLibpqConnectionUrl(process.env.DATABASE_URL ?? ""));
}
