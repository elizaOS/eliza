import { type ExecFn } from "./external-credentials.js";
import { type ResolutionContext } from "./profiles.js";
import { type Vault } from "./vault.js";
/**
 * SecretsManager — the high-level routing layer over Vault.
 *
 * Lets a user pick which backends to enable for sensitive secrets:
 *
 *   - "in-house"   → Eliza's local store (OS keychain master + AES-GCM file)
 *   - "1password"  → 1Password CLI (`op`); references stored locally
 *   - "protonpass" → Proton Pass (scaffolded; vendor CLI not stable yet)
 *   - "bitwarden"  → Bitwarden CLI (`bw`); references stored locally
 *
 * Three modes the user can run in:
 *
 *   - **None enabled** → only "in-house" is used. Default.
 *   - **One enabled**  → user picked (e.g.) "1password"; sensitive values
 *     route there only when the caller stores an explicit reference.
 *   - **All enabled**  → user can pick per-key in Settings; unsupported
 *     direct external writes fail loudly instead of hiding the problem.
 *
 * The Vault remains the store for non-sensitive config and for the
 * references that point at external password managers.
 */
export type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";
export interface BackendStatus {
    readonly id: BackendId;
    readonly label: string;
    /** True if the backend is available on this machine. */
    readonly available: boolean;
    /**
     * True if the user is currently authenticated to this backend.
     * Undefined when not applicable (e.g., in-house) or detection
     * isn't supported yet.
     */
    readonly signedIn?: boolean;
    /** Human-readable detail for display when not fully ready. */
    readonly detail?: string;
    /**
     * Authentication path the backend is using. `desktop-app` means the
     * vendor's desktop app brokers auth (e.g. 1Password 8 native app
     * integration with the `op` CLI), so no session token is required.
     * `session-token` means we authenticated via stored session token.
     * `null` when the backend is unavailable or not signed in.
     *
     * Undefined for backends that don't have multiple auth modes
     * (e.g. in-house, protonpass).
     */
    readonly authMode?: "desktop-app" | "session-token" | null;
}
export interface ManagerPreferences {
    /**
     * Backends the user has enabled, ordered by priority.
     * "in-house" is always available for non-sensitive values, but sensitive
     * values follow this order exactly and fail if the selected backend cannot
     * accept the write.
     */
    readonly enabled: readonly BackendId[];
    /**
     * Per-key routing overrides. Useful when a user wants e.g. work
     * keys in 1Password and personal keys in Bitwarden.
     */
    readonly routing?: Readonly<Record<string, BackendId>>;
}
export declare const DEFAULT_PREFERENCES: ManagerPreferences;
export interface ManagerSetOptions {
    readonly sensitive?: boolean;
    /** Force routing to a specific backend, overriding preferences. */
    readonly store?: BackendId;
    readonly caller?: string;
}
export interface SecretsManager {
    /** The underlying vault. Use directly for advanced cases. */
    readonly vault: Vault;
    /** Set a value, routing per the user's preferences. */
    set(key: string, value: string, opts?: ManagerSetOptions): Promise<void>;
    /** Get a value, resolving through whatever backend it's stored in. */
    get(key: string): Promise<string>;
    /**
     * Resolve a value through the profile + per-context routing layer.
     *
     * Resolution order:
     *   1. Per-context routing rule that matches `ctx`
     *   2. The key's `_meta.<key>.activeProfile`
     *   3. The global `_routing.config.defaultProfile`
     *   4. The bare key value (legacy path)
     *
     * For keys without any meta entry, this is identical to `get()`.
     */
    getActive(key: string, ctx?: ResolutionContext): Promise<string>;
    /** Existence check. */
    has(key: string): Promise<boolean>;
    /** Remove (clears the local entry; doesn't delete from external password manager). */
    remove(key: string): Promise<void>;
    /** List keys. */
    list(prefix?: string): Promise<readonly string[]>;
    /** Probe each known backend; returns availability + sign-in status. */
    detectBackends(): Promise<readonly BackendStatus[]>;
    /** Read the user's saved preferences. */
    getPreferences(): Promise<ManagerPreferences>;
    /** Save the user's preferences. Persisted to the vault. */
    setPreferences(prefs: ManagerPreferences): Promise<void>;
    /**
     * List saved logins from every available source: in-house vault always,
     * plus 1Password and Bitwarden when they're signed in.
     *
     * Per-backend errors are collected into `failures` rather than thrown —
     * a flaky external CLI must not block the in-house list.
     */
    listAllSavedLogins(opts?: ListAllSavedLoginsOptions): Promise<LoginListResult>;
    /** Reveal a single login (full credentials) from the indicated source. */
    revealSavedLogin(source: "in-house" | "1password" | "bitwarden", identifier: string): Promise<LoginReveal>;
}
export interface CreateManagerOptions {
    /** Provide your own Vault. Default: `createVault()`. */
    readonly vault?: Vault;
    /**
     * Subprocess executor for password-manager CLIs. Tests inject a stub.
     * Defaults to a real `child_process.execFile`-based runner.
     */
    readonly exec?: ExecFn;
}
/**
 * Source-tagged saved-login summary spanning every backend.
 *
 * `identifier`:
 *   - `in-house`  → `<domain>:<username>` (matches the route shape used
 *                   to delete + reveal a single in-house credential)
 *   - `1password` → the 1Password item id (op_uuid)
 *   - `bitwarden` → the Bitwarden item id (uuid)
 */
export interface LoginListEntry {
    readonly source: "in-house" | "1password" | "bitwarden";
    readonly identifier: string;
    readonly domain: string | null;
    readonly username: string;
    /** Display name. For in-house this == username; external == op/bw title. */
    readonly title: string;
    readonly updatedAt: number;
}
export interface LoginReveal {
    readonly source: "in-house" | "1password" | "bitwarden";
    readonly identifier: string;
    readonly username: string;
    readonly password: string;
    readonly totp?: string;
    readonly domain: string | null;
}
export interface LoginListResult {
    readonly logins: readonly LoginListEntry[];
    /** Per-backend errors. The list still returns whatever succeeded. */
    readonly failures: ReadonlyArray<{
        readonly source: "1password" | "bitwarden";
        readonly message: string;
    }>;
}
export interface ListAllSavedLoginsOptions {
    readonly domain?: string;
}
export declare function createManager(opts?: CreateManagerOptions): SecretsManager;
//# sourceMappingURL=manager.d.ts.map