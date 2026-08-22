import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { PgliteVaultImpl } from "../src/pglite-vault.js";
import type { Vault } from "../src/vault-types.js";
import {
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
