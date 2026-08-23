/**
 * Unit tests for vault-types: validates custom vault error instances,
 * error messages, keys, and cause encapsulation.
 */
import { describe, expect, it } from "vitest";
import { VaultDecryptionError, VaultMissError } from "./vault-types.ts";

describe("vault-types", () => {
  describe("VaultMissError", () => {
    it("formats error message with key and sets name", () => {
      const err = new VaultMissError("OPENAI_API_KEY");
      expect(err.name).toBe("VaultMissError");
      expect(err.key).toBe("OPENAI_API_KEY");
      expect(err.message).toBe('vault: no entry for "OPENAI_API_KEY"');
      expect(err instanceof Error).toBe(true);
    });
  });

  describe("VaultDecryptionError", () => {
    it("formats decryption failure message and preserves cause", () => {
      const cause = new Error("auth tag mismatch");
      const err = new VaultDecryptionError("SECRET_TOKEN", { cause });
      expect(err.name).toBe("VaultDecryptionError");
      expect(err.key).toBe("SECRET_TOKEN");
      expect(err.message).toContain("failed to decrypt");
      expect(err.cause).toBe(cause);
    });
  });
});
