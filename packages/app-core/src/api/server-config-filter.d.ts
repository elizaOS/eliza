/** Config/env filtering — strip sensitive keys from API responses. */
/**
 * Env keys that must never be returned in GET /api/config responses.
 * Covers private keys, auth tokens, and database credentials.
 * Keys are stored and matched case-insensitively (uppercased).
 */
export declare const SENSITIVE_ENV_RESPONSE_KEYS: Set<string>;
/**
 * Strip sensitive env vars from a config object before it is sent in a GET
 * /api/config response. Returns a shallow-cloned config with a filtered env
 * block — the original object is never mutated.
 */
export declare function filterConfigEnvForResponse(
  config: Record<string, unknown>,
): Record<string, unknown>;
//# sourceMappingURL=server-config-filter.d.ts.map
