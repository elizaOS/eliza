/**
 * Environment variable normalization helpers.
 *
 * Consolidates the `normalizeSecret` / `normalizeEnvValue` pattern that was
 * independently implemented in cloud connection, steward bridge, and wallet
 * trade helpers.
 */
/**
 * Normalize an env value: trim whitespace, return `undefined` for empty/missing.
 * Accepts `unknown` so callers don't need to narrow first (useful for config objects).
 */
export declare function normalizeEnvValue(value: unknown): string | undefined;
/**
 * Same as `normalizeEnvValue` but returns `null` instead of `undefined`.
 * Convenient when building option objects where `null` means "absent".
 */
export declare function normalizeEnvValueOrNull(value: unknown): string | null;
/**
 * Returns `true` if a boolean-ish env var is falsy (`"0"`, `"false"`, `"off"`, `"no"`).
 * Missing or empty values return `false` (i.e. the feature is enabled by default).
 */
export declare function isEnvDisabled(value: string | undefined): boolean;
/**
 * Sync app brand env vars → elizaOS equivalents.
 */
export { syncBrandEnvToEliza, syncElizaEnvToBrand, } from "../config/boot-config.js";
export declare function syncAppEnvToEliza(): void;
export declare function syncElizaEnvAliases(): void;
//# sourceMappingURL=env.d.ts.map