import { beforeEach, describe, expect, it, vi } from "vitest";

// --- dependency mocks -------------------------------------------------------
// @solana/web3.js: Keypair validates secret key length (64 bytes) like the
// real SDK; PublicKey wraps a base58 string.
vi.mock("@solana/web3.js", () => {
  class PublicKey {
    constructor(value) {
      this.value = value;
    }
    toBase58() {
      return this.value;
    }
  }
  class Keypair {
    constructor(secretKey) {
      if (!secretKey || secretKey.length !== 64) {
        throw new Error("Wrong secret key size");
      }
      this.secretKey = secretKey;
      this.publicKey = new PublicKey(`pk:${secretKey.length}`);
    }
    static generate() {
      return new Keypair(new Uint8Array(64).fill(7));
    }
    static fromSecretKey(secretKey) {
      return new Keypair(secretKey);
    }
  }
  return { Keypair, PublicKey };
});

// bs58: decodes only strings starting with "b58-", otherwise throws like a
// real decoder on invalid input.
const bs58Mock = vi.hoisted(() => ({
  encode: (bytes) => `b58-${bytes.length}`,
  decode: (str) => {
    if (typeof str === "string" && str.startsWith("b58-")) {
      return new Uint8Array(64).fill(Number(str.split("-")[1] || 1));
    }
    throw new Error("invalid base58");
  },
}));
vi.mock("bs58", () => ({ default: bs58Mock, ...bs58Mock }));

import { getExistingSolanaPublicKey, getWalletKey } from "./keypairUtils.ts";

// --- helpers ----------------------------------------------------------------
function makeRuntime(settings = {}) {
  const setSetting = vi.fn();
  const getSetting = vi.fn((key) => {
    if (key in settings) return settings[key];
    return null;
  });
  return {
    agentId: "agent-1",
    getSetting,
    setSetting,
    __setSetting: setSetting,
  };
}

const VALID_B58 = "b58-1"; // decodes to a 64-byte secret
const MALFORMED = "!!!not-a-key!!!";
// base64 of exactly 64 bytes (decodes to a 64-byte secret, unlike 64 'A's)
const VALID_B64 = Buffer.from(new Uint8Array(64).fill(3)).toString("base64");

describe("getWalletKey (requirePrivateKey=true)", () => {
  it("decodes a valid base58 private key", async () => {
    const runtime = makeRuntime({ SOLANA_PRIVATE_KEY: VALID_B58 });
    const result = await getWalletKey(runtime);
    expect(result.keypair).toBeDefined();
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("falls back to base64 when base58 decoding fails", async () => {
    const runtime = makeRuntime({ SOLANA_PRIVATE_KEY: VALID_B64 });
    const result = await getWalletKey(runtime);
    expect(result.keypair).toBeDefined();
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("throws Invalid private key format when the key is neither base58 nor base64", async () => {
    const runtime = makeRuntime({ SOLANA_PRIVATE_KEY: MALFORMED });
    await expect(getWalletKey(runtime)).rejects.toThrow("Invalid private key format");
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("mints and persists a new keypair when no key is configured (documented)", async () => {
    const runtime = makeRuntime();
    const result = await getWalletKey(runtime);
    expect(result.keypair).toBeDefined();
    const secret = runtime.__setSetting.mock.calls.find(([key]) => key === "SOLANA_PRIVATE_KEY");
    expect(secret).toBeDefined();
    expect(secret[2]).toBe(true); // persisted as a secret
    const pub = runtime.__setSetting.mock.calls.find(([key]) => key === "SOLANA_PUBLIC_KEY");
    expect(pub).toBeDefined();
    expect(pub[2]).toBe(false);
  });
});

describe("getWalletKey (requirePrivateKey=false, read-only)", () => {
  it("returns the configured public key without touching the secret", async () => {
    const runtime = makeRuntime({ SOLANA_PUBLIC_KEY: "pubkey-abc" });
    const result = await getWalletKey(runtime, false);
    expect(result.publicKey.toBase58()).toBe("pubkey-abc");
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("derives the public key from a valid private key without persisting", async () => {
    const runtime = makeRuntime({ SOLANA_PRIVATE_KEY: VALID_B58 });
    const result = await getWalletKey(runtime, false);
    expect(result.publicKey).toBeDefined();
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("FAILS LOUDLY on a malformed configured key instead of silently minting a replacement wallet", async () => {
    const runtime = makeRuntime({ SOLANA_PRIVATE_KEY: MALFORMED });
    await expect(getWalletKey(runtime, false)).rejects.toThrow("Invalid private key format");
    // The critical part: a read-only lookup must never mint/persist a secret.
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("mints a wallet only when no key is configured at all", async () => {
    const runtime = makeRuntime();
    const result = await getWalletKey(runtime, false);
    expect(result.publicKey).toBeDefined();
    expect(runtime.__setSetting).toHaveBeenCalled();
  });
});

describe("getExistingSolanaPublicKey", () => {
  it("returns null when no key is configured", () => {
    const runtime = makeRuntime();
    expect(getExistingSolanaPublicKey(runtime)).toBeNull();
  });

  it("returns the configured public key", () => {
    const runtime = makeRuntime({ SOLANA_PUBLIC_KEY: "pubkey-xyz" });
    const pk = getExistingSolanaPublicKey(runtime);
    expect(pk.toBase58()).toBe("pubkey-xyz");
  });

  it("never generates or persists a keypair on lookup", () => {
    const runtime = makeRuntime();
    getExistingSolanaPublicKey(runtime);
    expect(runtime.__setSetting).not.toHaveBeenCalled();
  });

  it("throws when the configured public key setting is not a string", () => {
    const runtime = makeRuntime({ SOLANA_PUBLIC_KEY: 42 });
    expect(() => getExistingSolanaPublicKey(runtime)).toThrow(
      "Setting SOLANA_PUBLIC_KEY must be a string"
    );
  });
});
