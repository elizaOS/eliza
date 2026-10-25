/**
 * SECURITY (H4, #12882 / #12230): pin the forwarded per-request database
 * identity to trusted control-plane context.
 *
 * The container-control-plane sidecar accepts an `x-eliza-cloud-database-url`
 * header and, when present, runs the request inside
 * `runWithCloudBindingsAsync({ DATABASE_URL })` -- i.e. it will connect to
 * whatever Postgres URL the caller names and even mirror/write Docker-node rows
 * into it. On its own that is an attacker-controlled tenant/database identity:
 * anyone who can reach the sidecar with the internal token could point it at a
 * database they control (data exfil, forged node rows), pivot to an internal DB
 * it should never touch, OR -- even on the *same* Postgres host:port -- connect
 * as a different user or to a different database/schema (`…:5432/exfil` instead
 * of `…:5432/cloud`).
 *
 * This guard makes that header FAIL CLOSED by pinning the WHOLE database
 * identity, not just the host. The legitimate control-plane forward
 * (`_container-control-plane-forward.ts`) sends the sidecar's OWN
 * `DATABASE_URL` verbatim, so the only value we ever need to honor is one that
 * matches the configured URL (or an explicit operator allowlist of full
 * DATABASE_URLs). A forwarded URL is honored only when its normalized identity
 * -- scheme, credentials, host, port, AND database path -- equals a trusted one.
 *
 * Anything else is rejected. A malformed forwarded URL is rejected. An
 * unparseable configured or allowlist URL does NOT silently widen the trust
 * set -- it is simply not added, so the guard stays closed.
 */

export type ForwardedDatabaseUrlDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface ForwardedDatabaseUrlGuardConfig {
  /** The sidecar's own configured DATABASE_URL (pinned control-plane DB). */
  readonly configuredDatabaseUrl?: string | undefined;
  /**
   * Operator-configured extra trusted full DATABASE_URLs. Comma/space parsing
   * is done by the caller (containers-env); this is the already-split list.
   * Each entry must be a complete database URL (same identity space as
   * {@link databaseIdentityKey}), NOT a bare host -- matching is on the whole
   * identity, so a bare host would never match and is dropped.
   */
  readonly allowlistDatabaseUrls?: readonly string[] | undefined;
}

const DEFAULT_POSTGRES_PORT = "5432";
const NETWORK_SCHEMES_DEFAULTING_TO_PG_PORT = new Set(["postgres:", "postgresql:"]);

/**
 * Normalize a database URL to a canonical identity key that pins the WHOLE
 * connection identity: scheme, username, password, host, port, and database
 * path. Two URLs get the same key iff they connect to the same database as the
 * same principal.
 *
 * Normalization is intentionally minimal and identity-preserving:
 *   - scheme + host are lowercased (case-insensitive per URL/DNS rules),
 *   - a missing port on a Postgres scheme is defaulted to 5432 (so
 *     `example/db` and `example:5432/db` are the same identity),
 *   - query parameters are canonicalized (sorted) and INCLUDED in the key.
 * The database path is compared EXACTLY (no trailing-slash stripping): the
 * Postgres parser treats `/cloud` and `/cloud/` as different database names, so
 * we must not collapse them and let a forwarded URL bind a different DB.
 * Username/password/database are compared exactly (NOT lowercased) -- those are
 * case-sensitive credentials/identifiers and must match precisely.
 *
 * Query params MUST be part of the identity: `pg-connection-string` honors
 * query fields like `host`, `port`, `user`, `password`, and `dbname` as
 * connection OVERRIDES, so a URL with a trusted host/path but
 * `?host=evil.example&user=attacker` would connect somewhere else entirely.
 * Because the legitimate control-plane forward sends the configured
 * `DATABASE_URL` verbatim, its (possibly empty) query set is exactly what the
 * pinned identity should require -- any extra/attacker query field changes the
 * key and fails closed.
 *
 * Returns `null` when the value can't be parsed as a URL, or when a *network*
 * scheme has no host (an unusable, untrustable identity). Host-less LOCAL
 * schemes (the documented file-backed PGlite form `pglite:///path`, plus
 * `sqlite:`/`file:`) are keyed on scheme + path so an identical local DB
 * still matches in dev/test.
 */
const HOSTLESS_LOCAL_SCHEMES = new Set(["pglite:", "sqlite:", "file:"]);

export function databaseIdentityKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // error-policy:J3 untrusted forwarded-header/config value; an unparseable
    // URL yields the explicit invalid signal `null`, which every caller treats
    // as fail-closed (reject the forward / drop from the trusted set) — never a
    // fabricated-valid default.
    return null;
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.trim().toLowerCase();
  // Do NOT normalize the path (e.g. strip a trailing slash): the Postgres
  // connection parser treats `/cloud` and `/cloud/` as different database
  // names, so collapsing them would let a forwarded `.../cloud/` bind a
  // different DB than the pinned `.../cloud`. The path is compared exactly.
  const path = parsed.pathname;

  if (!host) {
    // Host-less local database URL (e.g. pglite file): key on scheme + path.
    // A host-less network URL is not a trustable identity.
    if (!HOSTLESS_LOCAL_SCHEMES.has(scheme)) return null;
    return `${scheme}//${path}`;
  }

  const port =
    parsed.port.trim() ||
    (NETWORK_SCHEMES_DEFAULTING_TO_PG_PORT.has(scheme) ? DEFAULT_POSTGRES_PORT : "");
  // Credentials are part of the identity and case-sensitive; do NOT lowercase.
  const user = parsed.username;
  const pass = parsed.password;
  const auth = user || pass ? `${user}:${pass}@` : "";
  const query = canonicalQuery(parsed);
  // Duplicate query keys are ambiguous (pg-connection-string uses the LAST
  // occurrence for overrides like host/user/sslmode). We refuse to canonicalize
  // them into a stable key -- treat the whole URL as untrusted/unparseable so
  // the guard fails closed rather than authorizing a reordered duplicate.
  if (query === null) return null;
  return `${scheme}//${auth}${host}:${port}${path}${query}`;
}

/**
 * Canonicalize the query string (sorted key=value pairs) so trusted params like
 * `?sslmode=require` still match regardless of order, while any
 * extra/attacker-supplied override param (`?host=evil`, `?user=attacker`, ...)
 * changes the key and fails the guard closed. Returns "" when there is no query.
 *
 * Returns `null` when a query key appears MORE THAN ONCE: pg-connection-string
 * resolves duplicate override keys by last-occurrence, so sorting would make
 * `?host=a&host=b` and `?host=b&host=a` (which connect to DIFFERENT targets)
 * compare equal. Rather than pick a winner, we reject the ambiguity.
 */
function canonicalQuery(parsed: URL): string | null {
  const entries = [...parsed.searchParams.entries()];
  if (entries.length === 0) return "";
  const seen = new Set<string>();
  for (const [k] of entries) {
    if (seen.has(k)) return null;
    seen.add(k);
  }
  entries.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  const canon = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `?${canon}`;
}

/**
 * Build the set of trusted database identity keys from the sidecar's own
 * configured DATABASE_URL plus the operator allowlist of full DATABASE_URLs.
 * Unparseable inputs are dropped (fail closed), never added as a trusted key.
 */
export function buildTrustedDatabaseIdentitySet(
  config: ForwardedDatabaseUrlGuardConfig,
): Set<string> {
  const trusted = new Set<string>();
  if (config.configuredDatabaseUrl) {
    const key = databaseIdentityKey(config.configuredDatabaseUrl);
    if (key) trusted.add(key);
  }
  for (const entry of config.allowlistDatabaseUrls ?? []) {
    const key = databaseIdentityKey(entry);
    if (key) trusted.add(key);
  }
  return trusted;
}

/**
 * Decide whether a forwarded `x-eliza-cloud-database-url` header value may be
 * honored. FAIL CLOSED: unknown/unparseable/off-allowlist identities (including
 * a different user or database on the SAME host:port) are rejected.
 */
export function evaluateForwardedDatabaseUrl(
  forwardedDatabaseUrl: string,
  config: ForwardedDatabaseUrlGuardConfig,
): ForwardedDatabaseUrlDecision {
  const forwardedKey = databaseIdentityKey(forwardedDatabaseUrl);
  if (!forwardedKey) {
    return {
      allowed: false,
      reason: "forwarded database URL is malformed or has no host",
    };
  }

  const trusted = buildTrustedDatabaseIdentitySet(config);
  if (trusted.size === 0) {
    return {
      allowed: false,
      reason: "no trusted database identity is configured; refusing forwarded database URL",
    };
  }

  if (!trusted.has(forwardedKey)) {
    return {
      allowed: false,
      reason:
        "forwarded database identity does not match the pinned control-plane database (or allowlist)",
    };
  }

  return { allowed: true };
}
