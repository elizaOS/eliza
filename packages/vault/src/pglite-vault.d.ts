import type { MasterKeyResolver } from "./master-key.js";
import type { PasswordManagerReference, VaultDescriptor, VaultLogger, VaultStats } from "./types.js";
import type { SetOptions, Vault } from "./vault-types.js";
export interface PgliteVaultOptions {
    /** Data directory for the vault PGlite. Default: `<stateDir>/.vault-pglite/`. */
    readonly dataDir?: string;
    /** Path to the legacy vault.json file for one-shot migration. */
    readonly legacyStorePath?: string;
    /** Master key resolver. Crypto path is identical to VaultImpl. */
    readonly masterKey: MasterKeyResolver;
    /** Audit log path. Default: `<stateDir>/audit/vault.jsonl`. */
    readonly auditPath: string;
    /** Optional logger for non-fatal warnings. */
    readonly logger?: VaultLogger;
}
export declare class PgliteVaultImpl implements Vault {
    private readonly opts;
    private cachedKey;
    private dbPromise;
    private readonly audit;
    constructor(opts: PgliteVaultOptions);
    set(key: string, value: string, opts?: SetOptions): Promise<void>;
    setReference(key: string, ref: PasswordManagerReference): Promise<void>;
    get(key: string): Promise<string>;
    reveal(key: string, caller?: string): Promise<string>;
    has(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
    list(prefix?: string): Promise<readonly string[]>;
    describe(key: string): Promise<VaultDescriptor | null>;
    stats(): Promise<VaultStats>;
    /** Close the underlying PGlite connection. Tests + graceful shutdown only. */
    close(): Promise<void>;
    private readValue;
    private loadMasterKey;
    private db;
    private openDb;
    /**
     * One-shot migration from `vault.json` → vault_entries. Runs on first
     * PgliteVaultImpl boot when the table is empty AND the legacy file
     * exists. Copies entries verbatim — ciphertext stays opaque, master
     * key unchanged. Writes a sentinel row so we never re-run.
     *
     * The legacy file is left in place for one release as a safety net. A
     * follow-up release deletes both the file and this migration code.
     */
    private maybeMigrateFromFile;
}
export declare function defaultPgliteVaultDataDir(): string;
//# sourceMappingURL=pglite-vault.d.ts.map