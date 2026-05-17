/**
 * Disk-backed JWKS cache for the Eliza Cloud bootstrap-token verifier.
 *
 * The cloud control plane publishes its public keys at
 * `${ELIZA_CLOUD_ISSUER}/.well-known/jwks.json`. We fetch on first use and
 * cache to disk under the eliza state dir so a container restart does not
 * require an online round-trip just to read its own boot token.
 *
 * State dir resolution honours `ELIZA_STATE_DIR` > `~/.eliza`.
 * The default cache TTL is 6h per the plan.
 */
import type { RuntimeEnvRecord } from "@elizaos/shared";
export declare const DEFAULT_JWKS_TTL_MS: number;
export interface JwksKey {
    kty: string;
    kid?: string;
    use?: string;
    alg?: string;
    n?: string;
    e?: string;
    x?: string;
    y?: string;
    crv?: string;
    k?: string;
    [otherProperty: string]: string | undefined;
}
export interface JwksDocument {
    keys: JwksKey[];
}
/**
 * Resolve the eliza state directory.
 *
 * Order: `ELIZA_STATE_DIR` → `~/.eliza`.
 */
export declare function resolveElizaStateDir(env?: RuntimeEnvRecord): string;
/**
 * Resolve the on-disk path for the JWKS cache.
 *
 * Layout: `<state>/auth/cloud-jwks.json`.
 */
export declare function resolveJwksCachePath(env?: RuntimeEnvRecord): string;
/**
 * Read the cached JWKS for `issuer`.
 *
 * Returns `null` if the cache file is missing, malformed, written for a
 * different issuer, or older than `ttlMs`. Callers must treat `null` as
 * "must refresh from network" — never as "no keys, allow through".
 */
export declare function readCachedJwks(issuer: string, options?: {
    env?: RuntimeEnvRecord;
    now?: number;
    ttlMs?: number;
}): Promise<JwksDocument | null>;
/**
 * Write the JWKS document to disk. The parent directory is created with mode
 * 0700 to keep cached keys out of unrelated reads.
 */
export declare function writeCachedJwks(issuer: string, jwks: JwksDocument, options?: {
    env?: RuntimeEnvRecord;
    now?: number;
}): Promise<void>;
//# sourceMappingURL=cloud-jwks-store.d.ts.map