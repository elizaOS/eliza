/** Tests boot-time creation and reuse of the optimized-prompt integrity key. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMasterKey,
  inMemoryMasterKey,
  PgliteVaultImpl,
  VaultDecryptionError,
} from "@elizaos/vault";
import { describe, expect, it, vi } from "vitest";
import { resolveOptimizedPromptIntegrityKey } from "./vault-bridge.ts";

const INTEGRITY_KEY = "system.optimized-prompt.hmac-key";

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
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
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
      set: vi.fn(async () => undefined),
      setIfAbsent: vi.fn(async () => false),
    };

    expect(await resolveOptimizedPromptIntegrityKey(vault)).toBe(winner);
    expect(vault.get).toHaveBeenCalledOnce();
  });

  it("recovers only this typed internal-key decryption failure with protected exact read-back", async () => {
    let stored: string | null = null;
    let firstRead = true;
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async (key: string) => {
        if (firstRead) {
          firstRead = false;
          throw new VaultDecryptionError(key);
        }
        if (stored === null) throw new Error("replacement missing");
        return stored;
      }),
      set: vi.fn(async (_key: string, value: string) => {
        stored = value;
      }),
      setIfAbsent: vi.fn(async () => false),
    };

    const recovered = await resolveOptimizedPromptIntegrityKey(vault);

    expect(Buffer.from(recovered, "base64")).toHaveLength(32);
    expect(recovered).toBe(stored);
    expect(vault.set).toHaveBeenCalledOnce();
    expect(vault.set).toHaveBeenCalledWith(INTEGRITY_KEY, recovered, {
      sensitive: true,
      caller: "runtime-boot:optimized-prompt-hmac-decryption-recovery",
    });
    expect(vault.get).toHaveBeenCalledTimes(2);
    expect(vault.setIfAbsent).not.toHaveBeenCalled();
  });

  it("does not generalize recovery to non-decryption failures", async () => {
    const failure = new Error("storage unavailable");
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw failure;
      }),
      set: vi.fn(async () => undefined),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      failure,
    );
    expect(vault.set).not.toHaveBeenCalled();
  });

  it("fails closed when the protected overwrite fails", async () => {
    const overwriteFailure = new Error("protected write unavailable");
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw new VaultDecryptionError(INTEGRITY_KEY);
      }),
      set: vi.fn(async () => {
        throw overwriteFailure;
      }),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      overwriteFailure,
    );
    expect(vault.get).toHaveBeenCalledOnce();
  });

  it("fails closed when exact read-back does not verify the replacement", async () => {
    let readCount = 0;
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          throw new VaultDecryptionError(INTEGRITY_KEY);
        }
        return Buffer.alloc(32, 0x44).toString("base64");
      }),
      set: vi.fn(async () => undefined),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toThrow(
      /failed exact read-back verification/,
    );
    expect(vault.set).toHaveBeenCalledOnce();
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
          throw new VaultDecryptionError(INTEGRITY_KEY);
        }
        if (stored === null) throw new Error("replacement missing");
        return stored;
      }),
      set: vi.fn(async (_key: string, value: string) => {
        stored = value;
      }),
      setIfAbsent: vi.fn(async () => false),
    };

    const first = resolveOptimizedPromptIntegrityKey(vault);
    const second = resolveOptimizedPromptIntegrityKey(vault);
    releaseFirstRead?.();
    const [firstValue, secondValue] = await Promise.all([first, second]);

    expect(firstValue).toBe(secondValue);
    expect(firstValue).toBe(stored);
    expect(vault.set).toHaveBeenCalledOnce();
    expect(vault.get).toHaveBeenCalledTimes(2);
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
