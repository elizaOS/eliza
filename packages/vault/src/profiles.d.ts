/**
 * Profile resolution + per-context routing on top of `Vault`.
 *
 * Two layers:
 *
 * 1. Per-key active profile.
 *    A key K can have multiple named profiles (e.g. work, personal,
 *    throwaway). Each profile's value lives at `K.profile.<profileId>`;
 *    the meta blob (`_meta.K`) tracks the profile list and which one
 *    is currently active for bare reads. When no meta is present the
 *    legacy storage path is used (the value lives at K itself).
 *
 * 2. Per-context routing rules.
 *    A user can declare "for OPENROUTER_API_KEY, when agentId=X use the
 *    work profile". Rules are walked in order; the first match wins.
 *    Falls back to the key's `activeProfile`, then to the global
 *    `defaultProfile`, then to the legacy bare-key value.
 *
 * The vault stays dumb: every read goes through `Vault.get/has`. The
 * only routing logic lives here so the vault contract is unchanged.
 */
import type { Vault } from "./vault.js";
export type RoutingScopeKind = "agent" | "app" | "skill";
export interface RoutingScope {
    readonly kind: RoutingScopeKind;
    readonly agentId?: string;
    readonly appName?: string;
    readonly skillId?: string;
}
export interface RoutingRule {
    /** Exact-match against the vault key (e.g. "OPENROUTER_API_KEY"). */
    readonly keyPattern: string;
    readonly scope: RoutingScope;
    readonly profileId: string;
}
export interface RoutingConfig {
    readonly rules: ReadonlyArray<RoutingRule>;
    /**
     * Profile id used when no rule matches and the key's own
     * `activeProfile` is unset. Acts as the global default for keys
     * that have profiles enabled.
     */
    readonly defaultProfile?: string;
}
export interface ResolutionContext {
    readonly agentId?: string;
    readonly appName?: string;
    readonly skillId?: string;
}
/**
 * Resolve `key` against (a) per-context routing rules, (b) the key's
 * `activeProfile`, (c) the global `defaultProfile`, then (d) the bare
 * key value.
 *
 * Throws when none of the above resolves to a stored value — callers
 * decide how to surface the miss (e.g. inventory routes return 404,
 * runtime callers fall back to env var).
 */
export declare function resolveActiveValue(vault: Vault, key: string, ctx?: ResolutionContext): Promise<string>;
/**
 * Read the routing config blob from the vault. Missing or malformed
 * entries return `EMPTY_ROUTING` — routing is best-effort overlay,
 * not a load-bearing contract.
 */
export declare function readRoutingConfig(vault: Vault): Promise<RoutingConfig>;
/** Persist the routing config blob. Caller-validated input. */
export declare function writeRoutingConfig(vault: Vault, config: RoutingConfig): Promise<void>;
//# sourceMappingURL=profiles.d.ts.map