import type { CreateVaultOptions, Vault } from "./vault-types.js";
export type { CreateVaultOptions, SetOptions, Vault } from "./vault-types.js";
export { VaultMissError } from "./vault-types.js";
/**
 * Create a vault backed by PGlite. On first construction when the table is
 * empty, migrates any entries from the legacy `vault.json` file.
 */
export declare function createVault(opts?: CreateVaultOptions): Vault;
//# sourceMappingURL=vault.d.ts.map