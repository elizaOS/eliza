/**
 * Wallet-key migration helpers for `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY`.
 *
 * Storage layout (post-unification):
 *   - The shared vault is the source of truth. Keys are written at the
 *     bare `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` slots so the existing
 *     inventory categorizer (`categorizeKey`) surfaces them under
 *     Settings → Vault → Secrets in the "Wallet" group automatically.
 *   - The OS keystore (Keychain / libsecret) remains a one-shot read
 *     source for migrating off the legacy split-storage layout. We never
 *     write back into it from this module.
 *
 * Hydration (see `hydrate-wallet-keys-from-platform-store.ts`) reads the
 * vault first and copies the OS-keystore value across on the next boot
 * when the OS-keystore read path is enabled (default on supported desktops,
 * or explicitly via `ELIZA_WALLET_OS_STORE=1`).
 */
/**
 * Remove main wallet keys from BOTH the vault and the OS keystore.
 * Used by `POST /api/agent/reset` and the equivalent CLI flow.
 */
export declare function deleteWalletSecretsFromOsStore(): Promise<void>;
export type MigrateWalletPrivateKeysToOsStoreResult = {
    migrated: string[];
    failed: string[];
};
/**
 * Copies wallet keys from `process.env` and/or persisted `config.env` into
 * the shared vault, strips them from saved config, and ensures
 * `process.env` holds the values for the running process.
 *
 * Idempotent: if the vault already holds a key, the env value (if any)
 * is left in place but not re-written to the vault.
 */
export declare function migrateWalletPrivateKeysToOsStore(): Promise<MigrateWalletPrivateKeysToOsStoreResult>;
//# sourceMappingURL=wallet-os-store-actions.d.ts.map