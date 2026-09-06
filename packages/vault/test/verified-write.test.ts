/** Verifies serialized protected writes with exact read-back against mocked and real PGlite vaults. */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { PgliteVaultImpl } from "../src/pglite-vault.js";
import type { Vault } from "../src/vault-types.js";
import {
  mirrorSensitiveValueIfAbsent,
  VaultWriteVerificationError,
  writeSensitiveValueIfAbsentVerified,
  writeSensitiveValueVerified,
} from "../src/verified-write.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("verified sensitive writes", () => {
  it("serializes same-key writes through each exact read-back", async () => {
    let value = "";
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const vault = {
      set: async (_key: string, next: string) => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        value = next;
      },
      reveal: async () => {
        const readBack = value;
        activeWrites -= 1;
        return readBack;
      },
    } as unknown as Vault;

    await Promise.all([
      writeSensitiveValueVerified(vault, "providers.test.api-key", "first"),
      writeSensitiveValueVerified(vault, "providers.test.api-key", "second"),
    ]);

    expect(maxActiveWrites).toBe(1);
    expect(value).toBe("second");
  });

  it("fails closed on a read-back mismatch without exposing either value", async () => {
    const vault = {
      set: async () => {},
      reveal: async () => "different",
    } as unknown as Vault;

    const error = await writeSensitiveValueVerified(
      vault,
      "providers.test.api-key",
      "expected-secret",
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VaultWriteVerificationError);
    expect(String(error)).not.toMatch(/expected-secret|different/);
  });

  it("preserves an existing unreadable row when using the migration helper", async () => {
    let setCalls = 0;
    const unreadable = new Error("unreadable ciphertext");
    const vault = {
      setIfAbsent: async () => {
        setCalls += 1;
        return false;
      },
      reveal: async () => {
        throw unreadable;
      },
    } as unknown as Vault;

    await expect(
      writeSensitiveValueIfAbsentVerified(
        vault,
        "CEREBRAS_API_KEY",
        "recovery-source",
      ),
    ).rejects.toMatchObject({
      name: "VaultWriteVerificationError",
      cause: unreadable,
    });
    expect(setCalls).toBe(1);
  });

  it("survives a real PGlite close and restart with the same master key", async () => {
    const workDir = await fs.mkdtemp(join(tmpdir(), "vault-verified-restart-"));
    cleanup.push(workDir);
    const dataDir = join(workDir, ".vault-pglite");
    const auditPath = join(workDir, "audit", "vault.jsonl");
    const masterKey = generateMasterKey();
    const first = new PgliteVaultImpl({
      dataDir,
      auditPath,
      masterKey: inMemoryMasterKey(Buffer.from(masterKey)),
    });

    await writeSensitiveValueIfAbsentVerified(
      first,
      "providers.cerebras.api-key",
      "disposable-fixture",
      { caller: "test:repair" },
    );
    await first.close();

    const restarted = new PgliteVaultImpl({
      dataDir,
      auditPath,
      masterKey: inMemoryMasterKey(Buffer.from(masterKey)),
    });
    expect(await restarted.get("providers.cerebras.api-key")).toBe(
      "disposable-fixture",
    );
    await restarted.close();
  });
});

describe("mirrorSensitiveValueIfAbsent", () => {
  function mockVault(existing: string | undefined, readBack?: string) {
    let stored = existing;
    const calls = { setIfAbsent: 0, reveal: 0 };
    const vault = {
      setIfAbsent: async (_key: string, next: string) => {
        calls.setIfAbsent += 1;
        if (stored !== undefined) return false;
        stored = next;
        return true;
      },
      reveal: async () => {
        calls.reveal += 1;
        return readBack ?? (stored as string);
      },
    } as unknown as Vault;
    return { vault, calls };
  }

  it("inserts an absent key and proves the read-back", async () => {
    const { vault, calls } = mockVault(undefined);
    await expect(
      mirrorSensitiveValueIfAbsent(vault, "ELIZA_API_TOKEN", "fresh-token"),
    ).resolves.toBe("inserted");
    expect(calls).toEqual({ setIfAbsent: 1, reveal: 1 });
  });

  it("reports an equal existing entry without rewriting it", async () => {
    const { vault, calls } = mockVault("same-token");
    await expect(
      mirrorSensitiveValueIfAbsent(vault, "ELIZA_API_TOKEN", "same-token"),
    ).resolves.toBe("present-equal");
    expect(calls.setIfAbsent).toBe(1);
  });

  it("reports a differing existing entry instead of failing", async () => {
    const { vault } = mockVault("older-token");
    await expect(
      mirrorSensitiveValueIfAbsent(vault, "ELIZA_API_TOKEN", "rotated-token"),
    ).resolves.toBe("present-differs");
  });

  it("still fails closed when an inserted value does not read back", async () => {
    const { vault } = mockVault(undefined, "corrupted");
    await expect(
      mirrorSensitiveValueIfAbsent(vault, "ELIZA_API_TOKEN", "fresh-token"),
    ).rejects.toBeInstanceOf(VaultWriteVerificationError);
  });
});
