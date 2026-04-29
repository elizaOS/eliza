/**
 * Testing utilities for @milady/vault.
 *
 *   import { createTestVault } from "@milady/vault/testing";
 *
 *   const test = await createTestVault({ "ui.theme": "dark" });
 *   await test.vault.set("openrouter.apiKey", "k", { sensitive: true });
 *   await test.dispose();
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVault, type Vault } from "./vault.js";
import { generateMasterKey } from "./crypto.js";
import { inMemoryMasterKey } from "./master-key.js";
import type { AuditRecord } from "./types.js";

export interface TestVault {
  readonly vault: Vault;
  readonly storePath: string;
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
    opts.workDir ?? (await fs.mkdtemp(join(tmpdir(), "milady-vault-")));
  const storePath = join(workDir, "vault.json");
  const auditLogPath = join(workDir, "audit", "vault.jsonl");
  const vault = createVault({
    workDir,
    masterKey: inMemoryMasterKey(generateMasterKey()),
  });
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
  return {
    vault,
    storePath,
    auditLogPath,
    async getAuditRecords() {
      let raw: string;
      try {
        raw = await fs.readFile(auditLogPath, "utf8");
      } catch (err) {
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
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
    async dispose() {
      if (ownsWorkDir) {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
