/**
 * Testing utilities for @elizaos/vault.
 *
 *   import { createTestVault } from "@elizaos/vault";
 *
 *   const test = await createTestVault({ "ui.theme": "dark" });
 *   await test.vault.set("openrouter.apiKey", "k", { sensitive: true });
 *   await test.dispose();
 */
import type { AuditRecord } from "./types.js";
import type { Vault } from "./vault.js";
export interface TestVault {
    readonly vault: Vault;
    readonly dataDir: string;
    readonly auditLogPath: string;
    /** All audit entries written so far. */
    getAuditRecords(): Promise<readonly AuditRecord[]>;
    /** Truncate the audit log between assertion phases. */
    clearAuditLog(): Promise<void>;
    /** Cleanup. Removes the temp directory. */
    dispose(): Promise<void>;
}
export interface CreateTestVaultOptions {
    /** Pre-seed non-sensitive values. */
    readonly values?: Readonly<Record<string, string>>;
    /** Pre-seed sensitive values (encrypted as if production). */
    readonly secrets?: Readonly<Record<string, string>>;
    /** Override the temp dir (default: mkdtemp + auto-cleanup). */
    readonly workDir?: string;
}
export declare function createTestVault(opts?: CreateTestVaultOptions): Promise<TestVault>;
//# sourceMappingURL=testing.d.ts.map