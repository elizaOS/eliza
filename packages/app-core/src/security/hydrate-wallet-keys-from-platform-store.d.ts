/**
 * Fills `process.env` wallet keys from the shared vault (now the source
 * of truth). On first boot after the storage unification, copies any
 * legacy OS-keystore values into the vault and then proceeds normally.
 *
 * Steward env vars stay on the OS-keystore path — the steward backend's
 * lifecycle is independent of the wallet vault.
 *
 * Runs before upstream `startApiServer` merges `config.env`, so persisted
 * config only fills gaps that neither vault nor OS keystore supplies.
 */
export declare function hydrateWalletKeysFromNodePlatformSecureStore(): Promise<void>;
//# sourceMappingURL=hydrate-wallet-keys-from-platform-store.d.ts.map