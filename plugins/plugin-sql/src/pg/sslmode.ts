/** Resolves a Postgres connection string's sslmode alias to today's explicit TLS behavior, ahead of node-postgres parsing it. */
const PG_SSLMODE_CURRENT_TLS_ALIASES = new Set(["prefer", "require", "verify-ca"]);

/**
 * pg-connection-string currently treats these sslmode values like verify-full,
 * but warns that its next major version will switch them to libpq semantics.
 * Make the current strict TLS behavior explicit before node-postgres parses it.
 */
export function normalizePgSslMode(connectionString: string): string {
  if (!connectionString || /(?:[?&]|\s)uselibpqcompat=true(?:[&#]|\s|$)/i.test(connectionString)) {
    return connectionString;
  }

  return connectionString
    .replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=(&|#|$))/gi, (match, prefix, value) =>
      PG_SSLMODE_CURRENT_TLS_ALIASES.has(String(value).toLowerCase())
        ? `${prefix}verify-full`
        : match
    )
    .replace(
      /(^|\s)(sslmode=)(prefer|require|verify-ca)(?=\s|$)/gi,
      (match, boundary, prefix, value) =>
        PG_SSLMODE_CURRENT_TLS_ALIASES.has(String(value).toLowerCase())
          ? `${boundary}${prefix}verify-full`
          : match
    );
}
