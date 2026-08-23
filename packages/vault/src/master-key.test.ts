/**
 * Unit tests for vault master key resolvers and derivation strategies.
 */

import { describe, expect, it } from "vitest";
import { generateMasterKey, KEY_BYTES } from "./crypto.js";
import {
  attestationMasterKey,
  inMemoryMasterKey,
  MasterKeyUnavailableError,
  passphraseMasterKey,
  passphraseMasterKeyFromEnv,
  type TeeAttestationVerifier,
} from "./master-key.js";

describe("master-key resolvers", () => {
  describe("inMemoryMasterKey", () => {
    it("returns the provided 32-byte key buffer", async () => {
      const keyBuf = generateMasterKey();
      const resolver = inMemoryMasterKey(keyBuf);

      expect(resolver.describe()).toBe("inMemory");
      const loaded = await resolver.load();
      expect(loaded).toBe(keyBuf);
    });

    it("rejects buffers that are not 32 bytes", () => {
      const badBuf = Buffer.alloc(16);
      expect(() => inMemoryMasterKey(badBuf)).toThrowError(
        MasterKeyUnavailableError,
      );
    });
  });

  describe("passphraseMasterKey", () => {
    it("derives deterministic 32-byte master key from passphrase via scrypt", async () => {
      const passphrase = "valid-long-passphrase-12345";
      const resolver1 = passphraseMasterKey({
        passphrase,
        service: "test-service",
        cost: 1024,
      });
      const resolver2 = passphraseMasterKey({
        passphrase,
        service: "test-service",
        cost: 1024,
      });

      expect(resolver1.describe()).toBe("passphrase://test-service");

      const key1 = await resolver1.load();
      const key2 = await resolver2.load();

      expect(key1.length).toBe(KEY_BYTES);
      expect(key1.equals(key2)).toBe(true);
    });

    it("rejects passphrases shorter than 12 characters", () => {
      expect(() =>
        passphraseMasterKey({ passphrase: "too-short" }),
      ).toThrowError(/passphrase must be at least 12 characters/);
    });

    it("loads from environment variable when ELIZA_VAULT_PASSPHRASE is set", async () => {
      const original = process.env.ELIZA_VAULT_PASSPHRASE;
      try {
        process.env.ELIZA_VAULT_PASSPHRASE = "env-passphrase-secure-123";
        const resolver = passphraseMasterKeyFromEnv("my-service");
        expect(resolver).not.toBeNull();
        expect(resolver?.describe()).toBe("passphrase://my-service");

        delete process.env.ELIZA_VAULT_PASSPHRASE;
        expect(passphraseMasterKeyFromEnv()).toBeNull();
      } finally {
        if (original !== undefined) {
          process.env.ELIZA_VAULT_PASSPHRASE = original;
        } else {
          delete process.env.ELIZA_VAULT_PASSPHRASE;
        }
      }
    });
  });

  describe("attestationMasterKey", () => {
    it("loads key from trusted TEE attestation verifier", async () => {
      const validKey = generateMasterKey();
      const verifier: TeeAttestationVerifier = {
        releaseSealedVolumeKey: async () => validKey,
        describe: () => "mock-tdx",
      };

      const resolver = attestationMasterKey(verifier);
      expect(resolver.describe()).toBe("attestation://mock-tdx");

      const loaded = await resolver.load();
      expect(loaded).toBe(validKey);
    });

    it("fails closed when attestation verifier throws", async () => {
      const verifier: TeeAttestationVerifier = {
        releaseSealedVolumeKey: async () => {
          throw new Error("Quote signature verification failed");
        },
        describe: () => "mock-tdx",
      };

      const resolver = attestationMasterKey(verifier);
      await expect(resolver.load()).rejects.toThrowError(
        MasterKeyUnavailableError,
      );
    });

    it("fails closed when attestation verifier returns invalid buffer length", async () => {
      const verifier: TeeAttestationVerifier = {
        releaseSealedVolumeKey: async () => Buffer.alloc(16),
        describe: () => "mock-tdx",
      };

      const resolver = attestationMasterKey(verifier);
      await expect(resolver.load()).rejects.toThrowError(
        /expected a 32-byte Buffer/,
      );
    });
  });
});
