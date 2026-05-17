/**
 * Boot-time secret hydration: walk known plaintext sources, push sensitive
 * values to the shared vault, and rewrite the on-disk plaintext to
 * `vault://<KEY>` sentinels.
 *
 * Sources (in order):
 *   1. eliza.json `env[KEY]` and `env.vars[KEY]`
 *   2. `<stateDir>/config.env`
 *   3. eliza.json `plugins.entries[<id>].config[KEY]`
 *   4. `process.env[KEY]` for keys flagged sensitive in any registered plugin
 *      (does not mutate process.env — only mirrors to the vault).
 *
 * Idempotent by `vault.has(key)` per-key checks — no separate marker
 * file. Re-running the bootstrap after a partial run is safe and cheap;
 * only keys not already in the vault get re-attempted. Per-key
 * failures are isolated; if every write fails the function throws.
 */
import type { Vault } from "@elizaos/vault";
export interface VaultBootstrapResult {
    migrated: number;
    failed: string[];
}
interface VaultBootstrapOptions {
    configPath?: string;
    stateDir?: string;
    /** Test seam — defaults to `sharedVault()`. */
    vault?: Vault;
}
export declare function runVaultBootstrap(opts?: VaultBootstrapOptions): Promise<VaultBootstrapResult>;
export {};
//# sourceMappingURL=vault-bootstrap.d.ts.map