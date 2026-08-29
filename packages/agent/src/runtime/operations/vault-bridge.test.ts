/**
 * Deterministic mocked and real-PGlite tests for boot-time creation, typed
 * recovery, forensic quarantine, concurrency, and restart persistence of the
 * optimized-prompt integrity key.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  generateMasterKey,
  inMemoryMasterKey,
  PgliteVaultImpl,
  VaultDecryptionError,
} from "@elizaos/vault";
import { describe, expect, it, vi } from "vitest";
import { resolveOptimizedPromptIntegrityKey } from "./vault-bridge.ts";

const INTEGRITY_KEY = "system.optimized-prompt.hmac-key";
const UNREADABLE_ENTRY_IDENTITY = "test-unreadable-row-identity";

function integrityKeyDecryptionFailure(): VaultDecryptionError {
  return new VaultDecryptionError(INTEGRITY_KEY, {
    entryIdentity: UNREADABLE_ENTRY_IDENTITY,
  });
}

describe("resolveOptimizedPromptIntegrityKey", () => {
  it("persists one sensitive 256-bit key", async () => {
    const values = new Map<string, string>();
    const vault = {
      has: vi.fn(async (key: string) => values.has(key)),
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        if (!value) throw new Error("missing");
        return value;
      }),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(
        async (key: string, value: string): Promise<boolean> => {
          if (values.has(key)) return false;
          values.set(key, value);
          return true;
        },
      ),
    };

    const first = await resolveOptimizedPromptIntegrityKey(vault);
    const second = await resolveOptimizedPromptIntegrityKey(vault);

    expect(Buffer.from(first, "base64")).toHaveLength(32);
    expect(second).toBe(first);
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).toHaveBeenCalledWith(
      "system.optimized-prompt.hmac-key",
      first,
      { sensitive: true, caller: "runtime-boot" },
    );
  });

  it("uses the winner when another process creates the key first", async () => {
    const winner = Buffer.alloc(32, 7).toString("base64");
    const vault = {
      has: vi.fn(async () => false),
      get: vi.fn(async () => winner),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    expect(await resolveOptimizedPromptIntegrityKey(vault)).toBe(winner);
    expect(vault.get).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", ""],
    ["short", Buffer.alloc(31, 1).toString("base64")],
    ["long", Buffer.alloc(33, 1).toString("base64")],
    ["non-base64", "not-base64"],
    ["non-canonical", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwB="],
  ])("rejects a %s losing-writer key", async (_label, winner) => {
    const vault = {
      has: vi.fn(async () => false),
      get: vi.fn(async () => winner),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toThrow(
      /optimized-prompt integrity key/,
    );
    expect(vault.get).toHaveBeenCalledOnce();
  });

  it("recovers only this typed internal-key decryption failure with protected exact read-back", async () => {
    let stored: string | null = "unreadable-ciphertext";
    let firstRead = true;
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async (key: string) => {
        if (firstRead) {
          firstRead = false;
          throw new VaultDecryptionError(key, {
            entryIdentity: UNREADABLE_ENTRY_IDENTITY,
          });
        }
        if (stored === null) throw new Error("replacement missing");
        return stored;
      }),
      quarantineUnreadable: vi.fn(async () => {
        stored = null;
        return true;
      }),
      setIfAbsent: vi.fn(async (_key: string, value: string) => {
        if (stored !== null) return false;
        stored = value;
        return true;
      }),
    };

    const recovered = await resolveOptimizedPromptIntegrityKey(vault);

    expect(Buffer.from(recovered, "base64")).toHaveLength(32);
    expect(recovered).toBe(stored);
    expect(vault.quarantineUnreadable).toHaveBeenCalledWith(
      INTEGRITY_KEY,
      UNREADABLE_ENTRY_IDENTITY,
      "optimized-prompt integrity key failed authenticated decryption during runtime boot",
      "runtime-boot:optimized-prompt-hmac-decryption-recovery",
    );
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).toHaveBeenCalledWith(INTEGRITY_KEY, recovered, {
      sensitive: true,
      caller: "runtime-boot:optimized-prompt-hmac-decryption-recovery",
    });
    expect(vault.get).toHaveBeenCalledTimes(2);
  });

  it("does not generalize recovery to non-decryption failures", async () => {
    const failure = new Error("storage unavailable");
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw failure;
      }),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      failure,
    );
    expect(vault.quarantineUnreadable).not.toHaveBeenCalled();
  });

  it("does not generalize recovery to a typed failure for another key", async () => {
    const failure = new VaultDecryptionError("provider.openai.api-key", {
      entryIdentity: UNREADABLE_ENTRY_IDENTITY,
    });
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw failure;
      }),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      failure,
    );
    expect(vault.quarantineUnreadable).not.toHaveBeenCalled();
    expect(vault.setIfAbsent).not.toHaveBeenCalled();
  });

  it("fails closed when a decryption failure has no exact row identity", async () => {
    const failure = new VaultDecryptionError(INTEGRITY_KEY);
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw failure;
      }),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      failure,
    );
    expect(vault.quarantineUnreadable).not.toHaveBeenCalled();
    expect(vault.setIfAbsent).not.toHaveBeenCalled();
  });

  it("fails closed when forensic quarantine fails", async () => {
    const quarantineFailure = new Error("quarantine unavailable");
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw integrityKeyDecryptionFailure();
      }),
      quarantineUnreadable: vi.fn(async () => {
        throw quarantineFailure;
      }),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      quarantineFailure,
    );
    expect(vault.get).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).not.toHaveBeenCalled();
  });

  it("fails closed when replacement creation fails after quarantine", async () => {
    const creationFailure = new Error("protected create unavailable");
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw integrityKeyDecryptionFailure();
      }),
      quarantineUnreadable: vi.fn(async () => true),
      setIfAbsent: vi.fn(async () => {
        throw creationFailure;
      }),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      creationFailure,
    );
    expect(vault.quarantineUnreadable).toHaveBeenCalledOnce();
    expect(vault.get).toHaveBeenCalledOnce();
  });

  it("fails closed when exact read-back does not verify the replacement", async () => {
    let readCount = 0;
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          throw integrityKeyDecryptionFailure();
        }
        return Buffer.alloc(32, 0x44).toString("base64");
      }),
      quarantineUnreadable: vi.fn(async () => true),
      setIfAbsent: vi.fn(async () => true),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toThrow(
      /failed exact read-back verification/,
    );
    expect(vault.quarantineUnreadable).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
  });

  it("rejects an invalid read-back when another recovery writer wins", async () => {
    let readCount = 0;
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) throw integrityKeyDecryptionFailure();
        return Buffer.alloc(31, 0x55).toString("base64");
      }),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toThrow(
      /exactly 32 bytes/,
    );
    expect(vault.quarantineUnreadable).toHaveBeenCalledWith(
      INTEGRITY_KEY,
      UNREADABLE_ENTRY_IDENTITY,
      "optimized-prompt integrity key failed authenticated decryption during runtime boot",
      "runtime-boot:optimized-prompt-hmac-decryption-recovery",
    );
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
  });

  it("single-flights concurrent recovery so every caller receives one verified winner", async () => {
    let stored: string | null = null;
    let releaseFirstRead: (() => void) | undefined;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let readCount = 0;
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          await firstReadGate;
          throw integrityKeyDecryptionFailure();
        }
        if (stored === null) throw new Error("replacement missing");
        return stored;
      }),
      quarantineUnreadable: vi.fn(async () => true),
      setIfAbsent: vi.fn(async (_key: string, value: string) => {
        stored = value;
        return true;
      }),
    };

    const first = resolveOptimizedPromptIntegrityKey(vault);
    const second = resolveOptimizedPromptIntegrityKey(vault);
    releaseFirstRead?.();
    const [firstValue, secondValue] = await Promise.all([first, second]);

    expect(firstValue).toBe(secondValue);
    expect(firstValue).toBe(stored);
    expect(vault.quarantineUnreadable).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
    expect(vault.get).toHaveBeenCalledTimes(2);
  });

  it("uses one first-writer winner when distinct resolvers race recovery", async () => {
    let stored: string | null = "unreadable";
    let storedIdentity: string | null = UNREADABLE_ENTRY_IDENTITY;
    let initialFailuresRemaining = 2;
    let quarantineAttempts = 0;
    let quarantines = 0;
    let insertions = 0;
    const makeVault = () => ({
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        if (initialFailuresRemaining > 0) {
          initialFailuresRemaining -= 1;
          throw integrityKeyDecryptionFailure();
        }
        if (stored === null) throw new Error("replacement missing");
        return stored;
      }),
      quarantineUnreadable: vi.fn(
        async (_key: string, expectedIdentity: string) => {
          quarantineAttempts += 1;
          if (stored !== "unreadable" || storedIdentity !== expectedIdentity) {
            return false;
          }
          stored = null;
          storedIdentity = null;
          quarantines += 1;
          return true;
        },
      ),
      setIfAbsent: vi.fn(async (_key: string, value: string) => {
        if (stored !== null) return false;
        stored = value;
        storedIdentity = "healthy-winner-identity";
        insertions += 1;
        return true;
      }),
    });

    const [first, second] = await Promise.all([
      resolveOptimizedPromptIntegrityKey(makeVault()),
      resolveOptimizedPromptIntegrityKey(makeVault()),
    ]);

    expect(first).toBe(second);
    expect(first).toBe(stored);
    expect(quarantineAttempts).toBe(2);
    expect(quarantines).toBe(1);
    expect(insertions).toBe(1);
  });

  it("recovers a persisted key after master-key provenance changes and survives restart", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "vault-hmac-recovery-"));
    const dataDir = join(workDir, "vault");
    const auditPath = join(workDir, "audit", "vault.jsonl");
    const replacementMasterKey = generateMasterKey();
    let activeVault: PgliteVaultImpl | undefined;

    try {
      activeVault = new PgliteVaultImpl({
        dataDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
        auditPath,
      });
      await activeVault.set(INTEGRITY_KEY, "superseded-internal-key", {
        sensitive: true,
        caller: "test:old-install",
      });
      await activeVault.close();

      activeVault = new PgliteVaultImpl({
        dataDir,
        masterKey: inMemoryMasterKey(Buffer.from(replacementMasterKey)),
        auditPath,
      });
      const recovered = await resolveOptimizedPromptIntegrityKey(activeVault);
      expect(Buffer.from(recovered, "base64")).toHaveLength(32);
      expect(recovered).not.toBe("superseded-internal-key");
      await activeVault.close();

      activeVault = new PgliteVaultImpl({
        dataDir,
        masterKey: inMemoryMasterKey(Buffer.from(replacementMasterKey)),
        auditPath,
      });
      await expect(
        resolveOptimizedPromptIntegrityKey(activeVault),
      ).resolves.toBe(recovered);

      await activeVault.close();
      activeVault = undefined;

      const db = await PGlite.create(dataDir);
      const preserved = await db.query<{
        original_key: string;
        ciphertext: string;
      }>(
        `SELECT original_key, ciphertext
           FROM vault_quarantined_entries WHERE original_key = $1`,
        [INTEGRITY_KEY],
      );
      expect(preserved.rows).toHaveLength(1);
      expect(preserved.rows[0]?.original_key).toBe(INTEGRITY_KEY);
      expect(preserved.rows[0]?.ciphertext).not.toContain(
        "superseded-internal-key",
      );
      await db.close();

      const audit = await readFile(auditPath, "utf8");
      expect(audit).toContain(
        "runtime-boot:optimized-prompt-hmac-decryption-recovery",
      );
      expect(audit).not.toContain(recovered);
    } finally {
      await activeVault?.close();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
