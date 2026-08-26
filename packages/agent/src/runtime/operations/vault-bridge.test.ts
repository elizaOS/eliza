/** Tests boot-time creation and reuse of the optimized-prompt integrity key. */

import { VaultDecryptionError } from "@elizaos/vault";
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

  it("quarantines only this unreadable internal key and returns the protected replacement", async () => {
    let stored: string | null = "unreadable-ciphertext";
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
      "optimized-prompt integrity key failed authenticated decryption during runtime boot",
      "runtime-boot:optimized-prompt-hmac-decryption-recovery",
    );
    expect(vault.setIfAbsent).toHaveBeenCalledWith(INTEGRITY_KEY, recovered, {
      sensitive: true,
      caller: "runtime-boot:optimized-prompt-hmac-decryption-recovery",
    });
    expect(vault.get).toHaveBeenCalledTimes(2);
  });

  it("leaves every other Vault failure fail-closed", async () => {
    const wrongKeyFailure = new VaultDecryptionError(
      "providers.cerebras.api-key",
    );
    const vault = {
      has: vi.fn(async () => true),
      get: vi.fn(async () => {
        throw wrongKeyFailure;
      }),
      quarantineUnreadable: vi.fn(async () => false),
      setIfAbsent: vi.fn(async () => false),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toBe(
      wrongKeyFailure,
    );
    expect(vault.quarantineUnreadable).not.toHaveBeenCalled();
    expect(vault.setIfAbsent).not.toHaveBeenCalled();
  });

  it("fails closed when exact replacement read-back does not match", async () => {
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
      quarantineUnreadable: vi.fn(async () => true),
      setIfAbsent: vi.fn(async () => true),
    };

    await expect(resolveOptimizedPromptIntegrityKey(vault)).rejects.toThrow(
      /failed exact read-back verification/,
    );
  });

  it("single-flights concurrent recovery for one Vault instance", async () => {
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
  });
});
