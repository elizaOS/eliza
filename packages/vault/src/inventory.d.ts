/**
 * Vault inventory: a meta-layer over `Vault` that surfaces every stored
 * key in a categorized, UI-renderable shape, and lets the user attach
 * metadata (label, providerId, profiles, routing) to a key without
 * changing the vault's underlying storage contract.
 *
 * Storage convention:
 *   - Original keys live exactly where they always have (e.g.
 *     `OPENROUTER_API_KEY`).
 *   - Metadata for a key K lives at `_meta.<K>` as a JSON-encoded
 *     non-sensitive entry.
 *   - When profiles are enabled for K, the per-profile values live at
 *     `<K>.profile.<profileId>`. The "active profile" pointer lives in
 *     the meta blob.
 *   - Routing rules across keys live at `_routing.config` as a single
 *     JSON-encoded non-sensitive entry.
 *
 * The vault layer remains dumb: `vault.get(K)` still returns the value
 * stored under K. Profile resolution is a thin wrapper exposed by the
 * manager (see `manager.getActive`). This file owns the metadata
 * read/write/categorize logic only.
 *
 * Hard rule: `_meta.*` and `_routing.*` are reserved prefixes — every
 * inventory listing filters them out so the user never sees a meta
 * blob masquerading as a normal vault entry.
 */
import type { Vault } from "./vault.js";
export declare const META_PREFIX = "_meta.";
export declare const ROUTING_KEY = "_routing.config";
export declare const PROFILE_SEGMENT = "profile";
/**
 * High-level category of a vault entry — drives grouping in the UI.
 *
 * - `provider`   — model-provider API keys (OPENAI_API_KEY, etc.)
 * - `plugin`     — non-provider plugin tokens (WORKFLOW_API_KEY, GITHUB_TOKEN, …)
 * - `wallet`     — wallet private keys / mnemonics
 * - `credential` — saved-login records (`creds.<domain>.<user>`)
 * - `system`     — internal manager/preferences entries
 * - `session`    — password-manager session tokens (`pm.<vendor>.session`)
 */
export type VaultEntryCategory = "provider" | "plugin" | "wallet" | "credential" | "system" | "session";
export interface VaultEntryProfile {
    readonly id: string;
    readonly label: string;
    /** Epoch ms; missing on legacy entries. */
    readonly createdAt?: number;
}
/**
 * On-disk shape of `_meta.<key>`. Only the fields the user has set
 * are persisted — partial writes via `setEntryMeta` merge.
 */
export interface VaultEntryMetaRecord {
    readonly category?: VaultEntryCategory;
    readonly label?: string;
    readonly providerId?: string;
    readonly lastModified?: number;
    readonly lastUsed?: number;
    readonly profiles?: ReadonlyArray<VaultEntryProfile>;
    readonly activeProfile?: string;
}
/**
 * Inventory row as the UI sees it. `kind` mirrors the underlying vault
 * entry's storage kind (secret = encrypted, value = plaintext config,
 * reference = pointer into a password manager).
 */
export interface VaultEntryMeta {
    readonly key: string;
    readonly category: VaultEntryCategory;
    readonly label: string;
    readonly providerId?: string;
    readonly hasProfiles: boolean;
    readonly activeProfile?: string;
    readonly profiles?: ReadonlyArray<VaultEntryProfile>;
    readonly lastModified?: number;
    readonly lastUsed?: number;
    readonly kind: "secret" | "value" | "reference";
}
/**
 * Heuristic categorization for keys without an explicit `_meta.*` entry.
 * Order matters: more specific patterns run first.
 */
export declare function categorizeKey(key: string): VaultEntryCategory;
/**
 * Provider id derivation when no explicit meta is set. Returns null
 * when the key isn't a recognized provider env var.
 */
export declare function inferProviderId(key: string): string | null;
/** Read the meta record for `key`; malformed JSON is rejected. */
export declare function readEntryMeta(vault: Vault, key: string): Promise<VaultEntryMetaRecord | null>;
/**
 * Partial-update payload accepted by `setEntryMeta`. Fields are
 * optional; passing `null` deletes the underlying field from the
 * stored meta blob (the only way to wipe e.g. activeProfile without
 * round-tripping the entire record).
 */
export interface VaultEntryMetaUpdate {
    readonly category?: VaultEntryCategory | null;
    readonly label?: string | null;
    readonly providerId?: string | null;
    readonly lastUsed?: number | null;
    readonly profiles?: ReadonlyArray<VaultEntryProfile> | null;
    readonly activeProfile?: string | null;
}
export declare function setEntryMeta(vault: Vault, key: string, partial: VaultEntryMetaUpdate): Promise<void>;
/**
 * Drop the meta record for `key`. Callers are responsible for also
 * removing the underlying value(s) and profile entries — this only
 * touches `_meta.<key>`.
 */
export declare function removeEntryMeta(vault: Vault, key: string): Promise<void>;
/**
 * List every meaningful vault entry, grouped by category. Reserved
 * `_meta.*` and `_routing.*` keys are filtered out, as are the
 * `_manager.*` preferences keys.
 *
 * For keys with profile entries (`<K>.profile.<id>`), only the parent
 * `<K>` is surfaced — the profile rows roll up under it.
 */
export declare function listVaultInventory(vault: Vault): Promise<readonly VaultEntryMeta[]>;
/**
 * Vault key for the storage backing one profile of a parent key.
 *
 * Profiles use dot separators so `vault.list("<KEY>")` matches both the
 * parent and every profile via the existing prefix logic.
 */
export declare function profileStorageKey(key: string, profileId: string): string;
//# sourceMappingURL=inventory.d.ts.map