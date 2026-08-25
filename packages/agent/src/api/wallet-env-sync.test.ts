/**
 * Coverage for `syncSolanaPublicKeyEnv`, the leaf Solana public-key env-sync
 * helper. Production config (`config/config.ts`) calls this during startup to
 * derive `SOLANA_PUBLIC_KEY` / `WALLET_PUBLIC_KEY` from a configured secret.
 *
 * Deterministic: drives the real export. Keys are generated with node:crypto
 * ed25519 (or fixed byte arrays for the 64-byte "last 32 bytes are the
 * address" path). No network, filesystem, or wallet.ts import — this file
 * must stay a leaf so the circular config ↔ wallet split stays testable.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSolanaPublicKeyEnv } from "./wallet-env-sync.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Independent Bitcoin-base58 encoder (byte-fold, not the hex-BigInt used in src). */
function encodeBase58(data: Uint8Array): string {
  let num = 0n;
  for (const byte of data) {
    num = (num << 8n) + BigInt(byte);
  }
  const chars: string[] = [];
  while (num > 0n) {
    const digit = B58[Number(num % 58n)];
    if (!digit) throw new Error("base58 digit out of range");
    chars.unshift(digit);
    num /= 58n;
  }
  for (const byte of data) {
    if (byte === 0) chars.unshift("1");
    else break;
  }
  return chars.join("") || "1";
}

function jsonSecret(bytes: Uint8Array): string {
  return JSON.stringify(Array.from(bytes));
}

/** Independent ed25519 seed/pubkey pair — SPKI/PKCS8 tail slices, not src offsets. */
function fixtureEd25519(): { seed: Buffer; publicKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    seed: Buffer.from(pkcs8.subarray(-32)),
    publicKey: Buffer.from(spki.subarray(-32)),
  };
}

const ENV_KEYS = [
  "SOLANA_PRIVATE_KEY",
  "SOLANA_PUBLIC_KEY",
  "WALLET_PUBLIC_KEY",
] as const;

const originals: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
  WALLET_PUBLIC_KEY: process.env.WALLET_PUBLIC_KEY,
};

function restoreEnv(): void {
  for (const name of ENV_KEYS) {
    const value = originals[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function clearEnv(): void {
  for (const name of ENV_KEYS) delete process.env[name];
}

function expectUnchangedPublicEnv(
  solana = "existing-solana",
  wallet = "existing-wallet",
): void {
  expect(process.env.SOLANA_PUBLIC_KEY).toBe(solana);
  expect(process.env.WALLET_PUBLIC_KEY).toBe(wallet);
}

beforeEach(() => {
  clearEnv();
});

afterEach(() => {
  restoreEnv();
});

describe("syncSolanaPublicKeyEnv", () => {
  describe("returns null without writing env", () => {
    it("returns null for missing, empty, and whitespace-only secrets", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      expect(syncSolanaPublicKeyEnv()).toBeNull();
      expect(syncSolanaPublicKeyEnv("")).toBeNull();
      expect(syncSolanaPublicKeyEnv("   \n\t  ")).toBeNull();

      expectUnchangedPublicEnv();
    });

    it("skips placeholder sentinels, including optional brackets and case", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      for (const value of [
        "REDACTED",
        "redacted",
        "[REDACTED]",
        " PLACEHOLDER ",
        "[ PLACEHOLDER ]",
        "TODO",
        "[TODO]",
        "CHANGEME",
        "empty",
        "[EMPTY]",
      ]) {
        expect(syncSolanaPublicKeyEnv(value)).toBeNull();
      }

      expectUnchangedPublicEnv();
    });

    it("returns null for invalid base58 without mutating env", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      // '0' and 'O' are not in the Bitcoin base58 alphabet.
      expect(syncSolanaPublicKeyEnv("0OIl")).toBeNull();
      expectUnchangedPublicEnv();
    });

    it("returns null for a JSON byte-array that is not all numbers", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      expect(syncSolanaPublicKeyEnv('[1, 2, "nope"]')).toBeNull();
      expect(syncSolanaPublicKeyEnv("[1, true, 3]")).toBeNull();
      expectUnchangedPublicEnv();
    });

    it("returns null for malformed JSON that still looks like a byte-array", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      expect(syncSolanaPublicKeyEnv("[1, 2,")).toBeNull();
      expect(syncSolanaPublicKeyEnv("[1,]")).toBeNull();
      expectUnchangedPublicEnv();
    });

    it("returns null for JSON arrays whose length is not 32 or 64", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      for (const length of [0, 1, 31, 33, 63, 65]) {
        const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
        expect(syncSolanaPublicKeyEnv(jsonSecret(bytes))).toBeNull();
      }

      expectUnchangedPublicEnv();
    });

    it("fails closed on an oversized secret before env mutation", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      expect(syncSolanaPublicKeyEnv("2".repeat(513))).toBeNull();
      expectUnchangedPublicEnv();
    });

    it("fails closed on an oversized base58 payload under the secret budget", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      // 89 chars is under the 512 secret budget but over the 88-char base58 cap.
      expect(syncSolanaPublicKeyEnv("2".repeat(89))).toBeNull();
      expectUnchangedPublicEnv();
    });

    it("does not treat a non-numeric JSON array lookalike as JSON", () => {
      process.env.SOLANA_PUBLIC_KEY = "existing-solana";
      process.env.WALLET_PUBLIC_KEY = "existing-wallet";

      // `/^\[\s*\d/` misses `[true]` / `[]`, so these fall through to base58.
      expect(syncSolanaPublicKeyEnv("[]")).toBeNull();
      expect(syncSolanaPublicKeyEnv("[true]")).toBeNull();
      expectUnchangedPublicEnv();
    });
  });

  describe("derives the public key and writes both env vars", () => {
    it("derives from a 32-byte JSON seed via ed25519", () => {
      const { seed, publicKey } = fixtureEd25519();
      const expected = encodeBase58(publicKey);

      const result = syncSolanaPublicKeyEnv(jsonSecret(seed));

      expect(result).toBe(expected);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(expected);
      expect(process.env.WALLET_PUBLIC_KEY).toBe(expected);
    });

    it("treats a 64-byte JSON secret as seed||pubkey and encodes the last 32 bytes", () => {
      const { seed, publicKey } = fixtureEd25519();
      const secret64 = Buffer.concat([seed, publicKey]);
      const expected = encodeBase58(publicKey);

      const result = syncSolanaPublicKeyEnv(jsonSecret(secret64));

      expect(result).toBe(expected);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(expected);
      expect(process.env.WALLET_PUBLIC_KEY).toBe(expected);
    });

    it("accepts a 32-byte seed encoded as base58", () => {
      const { seed, publicKey } = fixtureEd25519();
      const expected = encodeBase58(publicKey);

      const result = syncSolanaPublicKeyEnv(encodeBase58(seed));

      expect(result).toBe(expected);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(expected);
    });

    it("accepts a 64-byte secret encoded as base58", () => {
      const { seed, publicKey } = fixtureEd25519();
      const expected = encodeBase58(publicKey);
      const secret64 = Buffer.concat([seed, publicKey]);

      const result = syncSolanaPublicKeyEnv(encodeBase58(secret64));

      expect(result).toBe(expected);
      expect(process.env.WALLET_PUBLIC_KEY).toBe(expected);
    });

    it("trims surrounding whitespace before decoding", () => {
      const { seed, publicKey } = fixtureEd25519();
      const expected = encodeBase58(publicKey);

      const result = syncSolanaPublicKeyEnv(`  ${jsonSecret(seed)}  \n`);

      expect(result).toBe(expected);
    });

    it("reads SOLANA_PRIVATE_KEY when the argument is omitted", () => {
      const { seed, publicKey } = fixtureEd25519();
      const expected = encodeBase58(publicKey);
      process.env.SOLANA_PRIVATE_KEY = jsonSecret(seed);

      expect(syncSolanaPublicKeyEnv()).toBe(expected);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(expected);
    });

    it("uses the explicit argument rather than SOLANA_PRIVATE_KEY", () => {
      const a = fixtureEd25519();
      const b = fixtureEd25519();
      process.env.SOLANA_PRIVATE_KEY = jsonSecret(a.seed);

      const result = syncSolanaPublicKeyEnv(jsonSecret(b.seed));

      expect(result).toBe(encodeBase58(b.publicKey));
      expect(result).not.toBe(encodeBase58(a.publicKey));
    });

    it("overwrites existing public-key env on success", () => {
      const { seed, publicKey } = fixtureEd25519();
      const expected = encodeBase58(publicKey);
      process.env.SOLANA_PUBLIC_KEY = "stale-solana";
      process.env.WALLET_PUBLIC_KEY = "stale-wallet";

      expect(syncSolanaPublicKeyEnv(jsonSecret(seed))).toBe(expected);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(expected);
      expect(process.env.WALLET_PUBLIC_KEY).toBe(expected);
    });

    it("preserves leading-zero public-key bytes as base58 '1' prefixes", () => {
      // 64-byte path does not verify ed25519; last 32 bytes are the address.
      const seed = Buffer.alloc(32, 7);
      const publicKey = Buffer.concat([
        Buffer.alloc(3, 0),
        Buffer.alloc(29, 9),
      ]);
      const secret64 = Buffer.concat([seed, publicKey]);
      const expected = encodeBase58(publicKey);

      expect(expected.startsWith("111")).toBe(true);
      expect(syncSolanaPublicKeyEnv(jsonSecret(secret64))).toBe(expected);
    });

    it("accepts a JSON array with leading whitespace after the bracket", () => {
      const { seed, publicKey } = fixtureEd25519();
      const inner = Array.from(seed).join(", ");
      const payload = `[\n ${inner}\n]`;

      expect(syncSolanaPublicKeyEnv(payload)).toBe(encodeBase58(publicKey));
    });
  });
});
