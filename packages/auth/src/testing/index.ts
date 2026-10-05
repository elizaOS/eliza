/**
 * Testing utilities for @elizaos/auth/vault.
 *
 *   import { createTestVault } from "@elizaos/auth/testing";
 *
 *   const test = await createTestVault({ values: { "ui.theme": "dark" } });
 *   await test.vault.set("openrouter.apiKey", "k", { sensitive: true });
 *   await test.dispose();
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey } from "../vault/crypto.js";
import { inMemoryMasterKey } from "../vault/master-key.js";
import { PgliteVaultImpl } from "../vault/pglite-vault.js";
import type { AuditRecord } from "../vault/types.js";
import type { Vault } from "../vault/vault.js";

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

export async function createTestVault(
  opts: CreateTestVaultOptions = {},
): Promise<TestVault> {
  const ownsWorkDir = !opts.workDir;
  const workDir =
    opts.workDir ?? (await fs.mkdtemp(join(tmpdir(), "eliza-vault-")));
  const dataDir = join(workDir, ".vault-pglite");
  const auditLogPath = join(workDir, "audit", "vault.jsonl");
  const vault = new PgliteVaultImpl({
    dataDir,
    masterKey: inMemoryMasterKey(generateMasterKey()),
    auditPath: auditLogPath,
  });
  async function dispose(): Promise<void> {
    const outcomes = await Promise.allSettled([vault.close()]);
    if (ownsWorkDir)
      outcomes.push(
        ...(await Promise.allSettled([
          fs.rm(workDir, { recursive: true, force: true }),
        ])),
      );
    const failures = outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Unable to dispose test vault");
  }
  try {
    if (opts.values) {
      for (const [key, value] of Object.entries(opts.values)) {
        await vault.set(key, value);
      }
    }
    if (opts.secrets) {
      for (const [key, value] of Object.entries(opts.secrets)) {
        await vault.set(key, value, { sensitive: true });
      }
    }
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Test vault initialization and cleanup failed",
      );
    }
    throw error;
  }
  return {
    vault,
    dataDir,
    auditLogPath,
    async getAuditRecords() {
      let raw: string;
      try {
        raw = await fs.readFile(auditLogPath, "utf8");
      } catch (err) {
        // error-policy:J3 untrusted-input sanitizing (test harness) — no audit
        // file yet is the explicit empty state; any other read error rethrows.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AuditRecord);
    },
    async clearAuditLog() {
      try {
        await fs.writeFile(auditLogPath, "", { mode: 0o600 });
      } catch (err) {
        // error-policy:J6 best-effort teardown (test harness) — truncating the
        // audit log between assertion phases; a missing file is already the
        // desired state, anything else rethrows.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
    dispose,
  };
}
