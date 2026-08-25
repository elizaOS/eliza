/**
 * Unit tests for domain error classes in packages/vault/src/vault-types.ts.
 */

import { describe, expect, it } from "vitest";
import { VaultDecryptionError, VaultMissError } from "../src/vault-types.js";

describe("VaultMissError", () => {
  it("constructs with standard properties and name", () => {
    const err = new VaultMissError("api.key");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VaultMissError);
    expect(err.name).toBe("VaultMissError");
    expect(err.key).toBe("api.key");
    expect(err.message).toBe('vault: no entry for "api.key"');
  });

  it("handles keys with special characters, quotes, and unicode", () => {
    const quoteErr = new VaultMissError('key"with"quotes');
    expect(quoteErr.key).toBe('key"with"quotes');
    expect(quoteErr.message).toBe('vault: no entry for "key\\"with\\"quotes"');

    const unicodeErr = new VaultMissError("🔑.secret.值");
    expect(unicodeErr.key).toBe("🔑.secret.值");
    expect(unicodeErr.message).toBe('vault: no entry for "🔑.secret.值"');

    const emptyErr = new VaultMissError("");
    expect(emptyErr.key).toBe("");
    expect(emptyErr.message).toBe('vault: no entry for ""');
  });

  it("can be caught and distinguished in try-catch blocks", () => {
    function throwMiss(): never {
      throw new VaultMissError("missing.key");
    }

    expect(() => throwMiss()).toThrow(VaultMissError);
    try {
      throwMiss();
    } catch (caught) {
      if (caught instanceof VaultMissError) {
        expect(caught.key).toBe("missing.key");
      } else {
        expect.unreachable("should have caught VaultMissError");
      }
    }
  });
});

describe("VaultDecryptionError", () => {
  it("constructs with standard properties and formatted message", () => {
    const err = new VaultDecryptionError("secure.token");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VaultDecryptionError);
    expect(err.name).toBe("VaultDecryptionError");
    expect(err.key).toBe("secure.token");
    expect(err.message).toBe(
      'vault: failed to decrypt "secure.token" (wrong master key or corrupt ciphertext)',
    );
    expect(err.cause).toBeUndefined();
  });

  it("preserves cause when error options are passed", () => {
    const underlying = new Error("bad tag / authentication failed");
    const err = new VaultDecryptionError("wallet.eth.privateKey", {
      cause: underlying,
    });
    expect(err.key).toBe("wallet.eth.privateKey");
    expect(err.cause).toBe(underlying);
    expect(err.message).toContain('"wallet.eth.privateKey"');
  });

  it("handles quoted and nested keys safely", () => {
    const err = new VaultDecryptionError('connector."agent-1".apiKey');
    expect(err.key).toBe('connector."agent-1".apiKey');
    expect(err.message).toBe(
      'vault: failed to decrypt "connector.\\"agent-1\\".apiKey" (wrong master key or corrupt ciphertext)',
    );
  });

  it("allows type discrimination between Miss and Decryption errors", () => {
    const errors: Error[] = [
      new VaultMissError("k1"),
      new VaultDecryptionError("k2"),
      new Error("generic"),
    ];

    const missKeys: string[] = [];
    const decryptKeys: string[] = [];
    const genericCount: number[] = [];

    for (const e of errors) {
      if (e instanceof VaultMissError) {
        missKeys.push(e.key);
      } else if (e instanceof VaultDecryptionError) {
        decryptKeys.push(e.key);
      } else {
        genericCount.push(1);
      }
    }

    expect(missKeys).toEqual(["k1"]);
    expect(decryptKeys).toEqual(["k2"]);
    expect(genericCount).toEqual([1]);
  });
});
