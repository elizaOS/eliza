import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("@elizaos/core", () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (real crypto, mocked logger) ────────────────────────────────────

import type { IAgentRuntime } from "@elizaos/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { getWalletKey } from "../keypairUtils";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockRuntime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const store: Record<string, string | undefined> = { ...settings };

  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: { name: "TestAgent" },
    getSetting: vi.fn((key: string) => store[key] ?? null),
    setSetting: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    getService: vi.fn(),
  } as unknown as IAgentRuntime;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("keypairUtils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Keypair generation ────────────────────────────────────────────────────

  describe("Keypair generation", () => {
    it("should produce a keypair with a 32-byte public key", () => {
      const keypair = Keypair.generate();
      expect(keypair.publicKey.toBytes()).toHaveLength(32);
    });

    it("should produce a keypair with a 64-byte secret key", () => {
      const keypair = Keypair.generate();
      expect(keypair.secretKey).toHaveLength(64);
    });

    it("should produce a base58-encodable public key", () => {
      const keypair = Keypair.generate();
      const base58Pubkey = keypair.publicKey.toBase58();
      expect(typeof base58Pubkey).toBe("string");
      expect(base58Pubkey.length).toBeGreaterThanOrEqual(32);
      expect(base58Pubkey.length).toBeLessThanOrEqual(44);
    });

    it("should produce unique keypairs on each call", () => {
      const kp1 = Keypair.generate();
      const kp2 = Keypair.generate();
      expect(kp1.publicKey.toBase58()).not.toBe(kp2.publicKey.toBase58());
    });
  });

  // ── Base58 encode/decode roundtrip ────────────────────────────────────────

  describe("Base58 encode/decode roundtrip", () => {
    it("should roundtrip a secret key through base58", () => {
      const keypair = Keypair.generate();
      const encoded = bs58.encode(keypair.secretKey);
      const decoded = bs58.decode(encoded);

      expect(decoded).toEqual(keypair.secretKey);
    });

    it("should restore identical keypair from base58-encoded secret key", () => {
      const original = Keypair.generate();
      const encoded = bs58.encode(original.secretKey);
      const restored = Keypair.fromSecretKey(bs58.decode(encoded));

      expect(restored.publicKey.toBase58()).toBe(original.publicKey.toBase58());
    });

    it("should roundtrip a public key through base58", () => {
      const keypair = Keypair.generate();
      const base58Str = keypair.publicKey.toBase58();
      const restored = new PublicKey(base58Str);

      expect(restored.equals(keypair.publicKey)).toBe(true);
    });
  });

  // ── Public key validation ─────────────────────────────────────────────────

  describe("Public key validation", () => {
    it("should accept well-known SOL mint address", () => {
      expect(() => new PublicKey("So11111111111111111111111111111111111111112")).not.toThrow();
    });

    it("should accept well-known USDC mint address", () => {
      expect(() => new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).not.toThrow();
    });

    it("should accept the system program address", () => {
      expect(() => new PublicKey("11111111111111111111111111111111")).not.toThrow();
    });

    it("should reject an empty string", () => {
      expect(() => new PublicKey("")).toThrow();
    });

    it("should reject obviously invalid addresses", () => {
      expect(() => new PublicKey("not_a_valid_address")).toThrow();
    });

    it("should reject addresses with invalid base58 characters (0, O, I, l)", () => {
      // '0' is not valid base58
      expect(() => new PublicKey("0000000000000000000000000000000000000000000")).toThrow();
    });
  });

  // ── Public key detection in text ──────────────────────────────────────────

  describe("Public key detection in text", () => {
    // Uses the same regex pattern as SolanaService.detectPubkeysFromString
    const SOLANA_PUBKEY_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

    function detectPubkeysInText(input: string): string[] {
      const results = new Set<string>();
      let match: RegExpExecArray | null;
      match = SOLANA_PUBKEY_REGEX.exec(input);
      while (match !== null) {
        const s = match[0];
        try {
          const buf = bs58.decode(s);
          if (buf.length === 32) {
            results.add(s);
          }
        } catch {
          // Invalid base58
        }
        match = SOLANA_PUBKEY_REGEX.exec(input);
      }
      return Array.from(results);
    }

    it("should find SOL mint address in a sentence", () => {
      const text = "Please send tokens to So11111111111111111111111111111111111111112 thanks";
      const found = detectPubkeysInText(text);
      expect(found).toContain("So11111111111111111111111111111111111111112");
    });

    it("should find multiple addresses in text", () => {
      const text =
        "Send from So11111111111111111111111111111111111111112 to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const found = detectPubkeysInText(text);
      expect(found).toHaveLength(2);
      expect(found).toContain("So11111111111111111111111111111111111111112");
      expect(found).toContain("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    });

    it("should return empty array for text with no addresses", () => {
      const text = "Hello world, no crypto here.";
      const found = detectPubkeysInText(text);
      expect(found).toHaveLength(0);
    });

    it("should not match short strings that look like base58", () => {
      const text = "The word ABC is not an address.";
      const found = detectPubkeysInText(text);
      expect(found).toHaveLength(0);
    });

    it("should find a freshly generated public key in text", () => {
      const keypair = Keypair.generate();
      const pubkeyStr = keypair.publicKey.toBase58();
      const text = `Transfer to ${pubkeyStr} immediately.`;
      const found = detectPubkeysInText(text);
      expect(found).toContain(pubkeyStr);
    });
  });

  // ── getWalletKey() ────────────────────────────────────────────────────────

  describe("getWalletKey", () => {
    describe("with requirePrivateKey = true", () => {
      it("should return keypair from SOLANA_PRIVATE_KEY (base58)", async () => {
        const testKeypair = Keypair.generate();
        const privateKeyBase58 = bs58.encode(testKeypair.secretKey);

        const runtime = createMockRuntime({ SOLANA_PRIVATE_KEY: privateKeyBase58 });
        const result = await getWalletKey(runtime, true);

        expect(result.keypair).toBeDefined();
        expect(result.keypair!.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
      });

      it("should fall back to WALLET_PRIVATE_KEY if SOLANA_PRIVATE_KEY is absent", async () => {
        const testKeypair = Keypair.generate();
        const privateKeyBase58 = bs58.encode(testKeypair.secretKey);

        const runtime = createMockRuntime({ WALLET_PRIVATE_KEY: privateKeyBase58 });
        const result = await getWalletKey(runtime, true);

        expect(result.keypair).toBeDefined();
        expect(result.keypair!.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
      });

      it("should accept base64-encoded private key", async () => {
        const testKeypair = Keypair.generate();
        const privateKeyBase64 = Buffer.from(testKeypair.secretKey).toString("base64");

        const runtime = createMockRuntime({ SOLANA_PRIVATE_KEY: privateKeyBase64 });
        const result = await getWalletKey(runtime, true);

        expect(result.keypair).toBeDefined();
        expect(result.keypair!.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
      });

      it("should throw for completely invalid private key", async () => {
        const runtime = createMockRuntime({ SOLANA_PRIVATE_KEY: "not-valid-at-all!!!" });

        await expect(getWalletKey(runtime, true)).rejects.toThrow("Invalid private key format");
      });

      it("should auto-generate and store keypair when no key is configured", async () => {
        const runtime = createMockRuntime({});
        const result = await getWalletKey(runtime, true);

        expect(result.keypair).toBeDefined();
        expect(result.keypair!.publicKey.toBytes()).toHaveLength(32);

        // Verify it stored the new keys
        expect(runtime.setSetting).toHaveBeenCalledWith(
          "SOLANA_PRIVATE_KEY",
          expect.any(String),
          true
        );
        expect(runtime.setSetting).toHaveBeenCalledWith(
          "SOLANA_PUBLIC_KEY",
          expect.any(String),
          false
        );
      });

      it("should store a restorable private key when auto-generating", async () => {
        const store: Record<string, string> = {};
        const runtime = createMockRuntime({});
        vi.mocked(runtime.setSetting).mockImplementation(((key: string, value: string) => {
          store[key] = value;
        }) as unknown as typeof runtime.setSetting);

        const result = await getWalletKey(runtime, true);
        const storedPrivKey = store.SOLANA_PRIVATE_KEY;
        expect(storedPrivKey).toBeDefined();

        // Verify the stored key can restore the same keypair
        const restored = Keypair.fromSecretKey(bs58.decode(storedPrivKey));
        expect(restored.publicKey.toBase58()).toBe(result.keypair!.publicKey.toBase58());
      });
    });

    describe("with requirePrivateKey = false", () => {
      it("should return publicKey from SOLANA_PUBLIC_KEY setting", async () => {
        const testKeypair = Keypair.generate();
        const pubkeyStr = testKeypair.publicKey.toBase58();

        const runtime = createMockRuntime({ SOLANA_PUBLIC_KEY: pubkeyStr });
        const result = await getWalletKey(runtime, false);

        expect(result.publicKey).toBeDefined();
        expect(result.publicKey!.toBase58()).toBe(pubkeyStr);
      });

      it("should fall back to WALLET_PUBLIC_KEY", async () => {
        const testKeypair = Keypair.generate();
        const pubkeyStr = testKeypair.publicKey.toBase58();

        const runtime = createMockRuntime({ WALLET_PUBLIC_KEY: pubkeyStr });
        const result = await getWalletKey(runtime, false);

        expect(result.publicKey).toBeDefined();
        expect(result.publicKey!.toBase58()).toBe(pubkeyStr);
      });

      it("should derive publicKey from private key when no public key setting exists", async () => {
        const testKeypair = Keypair.generate();
        const privateKeyBase58 = bs58.encode(testKeypair.secretKey);

        const runtime = createMockRuntime({ SOLANA_PRIVATE_KEY: privateKeyBase58 });
        const result = await getWalletKey(runtime, false);

        expect(result.publicKey).toBeDefined();
        expect(result.publicKey!.toBase58()).toBe(testKeypair.publicKey.toBase58());
      });

      it("should auto-generate when no keys are configured at all", async () => {
        const runtime = createMockRuntime({});
        const result = await getWalletKey(runtime, false);

        expect(result.publicKey).toBeDefined();
        expect(result.publicKey!.toBytes()).toHaveLength(32);
        // Auto-generation stores the new keypair
        expect(runtime.setSetting).toHaveBeenCalled();
      });
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle empty string setting as no key configured (triggers generation)", async () => {
      // getSetting returns null for empty, which triggers auto-generation
      const runtime = createMockRuntime({});
      vi.mocked(runtime.getSetting).mockReturnValue(null);

      const result = await getWalletKey(runtime, true);
      expect(result.keypair).toBeDefined();
    });

    it("should throw for invalid base58 that decodes to wrong-size key", async () => {
      // A short base58 string that decodes but isn't 64 bytes
      const runtime = createMockRuntime({
        SOLANA_PRIVATE_KEY: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNL",
      });

      await expect(getWalletKey(runtime, true)).rejects.toThrow();
    });

    it("bs58.decode should throw on invalid base58 characters", () => {
      expect(() => bs58.decode("0OIl")).toThrow();
    });

    it("bs58 encode/decode should roundtrip arbitrary 32 bytes", () => {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = i;

      const encoded = bs58.encode(bytes);
      const decoded = bs58.decode(encoded);

      expect(decoded).toEqual(bytes);
    });
  });
});
