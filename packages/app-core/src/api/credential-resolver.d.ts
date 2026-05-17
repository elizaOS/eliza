export interface ResolvedCredential {
    providerId: string;
    envVar: string;
    apiKey: string;
    authType: "api-key" | "subscription";
}
/**
 * Resolve the real credential for a specific provider.
 */
export declare function resolveProviderCredential(providerId: string): ResolvedCredential | null;
/**
 * Multi-account credential resolution. When the install has any
 * `LinkedAccountConfig` records for the requested provider, the pool
 * picks one (priority by default, with health-aware skipping) and we
 * return its access token via `getAccessToken` from `@elizaos/agent`. When
 * no accounts are configured, falls back to the env-based single-source resolver.
 *
 * `sessionKey` (optional) keeps repeated calls in the same logical
 * session glued to the same account so token refreshes and rate-limit
 * tracking stay coherent.
 */
export declare function resolveProviderCredentialMulti(providerId: string, opts?: {
    sessionKey?: string;
    exclude?: string[];
}): Promise<ResolvedCredential | null>;
/**
 * Scan all credential sources. Returns every provider that has a
 * resolvable credential on this machine.
 */
export declare function scanAllCredentials(): ResolvedCredential[];
//# sourceMappingURL=credential-resolver.d.ts.map