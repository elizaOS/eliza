import { describe, expect, it } from "vitest";
import {
  getConnection,
  getWalletPrivateKey,
  getWalletPublicKey,
  loadWallet,
} from "./solanaClient";

function makeRuntime(settings: Record<string, string | number | undefined>) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as { getSetting(key: string): string | null };
}

// A valid 64-byte secret key (all bytes = 0x01), base64-encoded (88 chars with padding).
const VALID_B64 =
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==";
// A 64-byte secret with non-symmetric trailing bits, base64-encoded — used to
// prove truncated base64 (which drops trailing bits) is rejected, not silently
// re-derived into a different keypair.
const ASYMMETRIC_B64 = Buffer.from(
  Array.from({ length: 64 }, (_, i) => i + 1),
).toString("base64");
// The same 64 bytes, base58-encoded (handled by the bs58 mock table).
const VALID_B58 = "7b58validkey1111111111111111111111111111111111111111111";

describe("getConnection", () => {
  it("falls back to mainnet-beta when no RPC url is set", () => {
    const conn = getConnection(makeRuntime({}));
    expect(conn.url).toBe("https://api.mainnet-beta.solana.com");
    expect(conn.commitment).toBe("confirmed");
  });

  it("uses the configured RPC url and commitment", () => {
    const conn = getConnection(
      makeRuntime({
        SOLANA_RPC_URL: "https://custom.example.com",
        SOLANA_COMMITMENT: "finalized",
      }),
    );
    expect(conn.url).toBe("https://custom.example.com");
    expect(conn.commitment).toBe("finalized");
  });

  it("ignores a non-string commitment value", () => {
    const conn = getConnection(makeRuntime({ SOLANA_COMMITMENT: 42 }));
    expect(conn.commitment).toBe("confirmed");
  });
});

describe("getWalletPrivateKey / getWalletPublicKey", () => {
  it("returns null for non-string values", () => {
    expect(
      getWalletPrivateKey(makeRuntime({ SOLANA_PRIVATE_KEY: 123 })),
    ).toBeNull();
    expect(
      getWalletPublicKey(makeRuntime({ SOLANA_PUBLIC_KEY: true })),
    ).toBeNull();
  });

  it("returns the string value when present", () => {
    expect(
      getWalletPrivateKey(makeRuntime({ SOLANA_PRIVATE_KEY: "abc" })),
    ).toBe("abc");
  });
});

describe("loadWallet", () => {
  it("loads a signer from a base58 private key", async () => {
    const wallet = await loadWallet(
      makeRuntime({ SOLANA_PRIVATE_KEY: VALID_B58 }),
    );
    expect(wallet.signer).toBeDefined();
    expect(wallet.address).toBeDefined();
  });

  it("loads a signer from a base64 private key", async () => {
    const wallet = await loadWallet(
      makeRuntime({ SOLANA_PRIVATE_KEY: VALID_B64 }),
    );
    expect(wallet.signer).toBeDefined();
  });

  it("rejects a private key that is neither valid base58 nor valid base64", async () => {
    await expect(
      loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: "!!not-a-real-key!!" })),
    ).rejects.toThrow(/Invalid private key format/);
  });

  it("rejects a truncated base64 private key instead of deriving a wrong keypair", async () => {
    // 85 chars: drops 3 chars of real payload (not just padding), so the
    // decoded bytes differ from the original key. The loader must reject
    // instead of silently deriving a wrong keypair.
    const truncated = ASYMMETRIC_B64.slice(0, 85);
    expect(truncated.length).toBe(85);
    await expect(
      loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: truncated })),
    ).rejects.toThrow(/Invalid private key format/);
  });

  it("rejects base64 with a corrupted character instead of skipping it silently", async () => {
    // Replace one payload char with a character outside the base64 alphabet.
    // Buffer.from(x, "base64") skips it, decoding a *different* 64-byte key —
    // the loader must fail loudly, not sign with the wrong keypair.
    const corrupted = `${ASYMMETRIC_B64.slice(0, 40)}!${ASYMMETRIC_B64.slice(41)}`;
    await expect(
      loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: corrupted })),
    ).rejects.toThrow(/Invalid private key format/);
  });

  it("rejects base64url variants (-/_) instead of mis-decoding them", async () => {
    // URL-safe base64 uses - and _ in place of + and /; Node's base64 decoder
    // accepts them as aliases, but re-encoding normalizes back to + and /, so
    // the round-trip check must reject the non-canonical form.
    const base64url = ASYMMETRIC_B64.replace(/\+/g, "-").replace(/\//g, "_");
    await expect(
      loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: base64url })),
    ).rejects.toThrow(/Invalid private key format/);
  });

  it("accepts a valid base64 private key with surrounding whitespace", async () => {
    const padded = `  ${VALID_B64}  `;
    const wallet = await loadWallet(
      makeRuntime({ SOLANA_PRIVATE_KEY: padded }),
    );
    expect(wallet.signer).toBeDefined();
  });

  it("accepts a valid base64 private key with internal newlines", async () => {
    const wrapped = `${VALID_B64.slice(0, 44)}\n${VALID_B64.slice(44)}`;
    const wallet = await loadWallet(
      makeRuntime({ SOLANA_PRIVATE_KEY: wrapped }),
    );
    expect(wallet.signer).toBeDefined();
  });

  it("accepts padding-less valid base64 (86 chars) as a canonical form", async () => {
    // 64 bytes encode to 86 payload chars + "=="; dropping the padding is a
    // legal base64 variant and must decode to the same keypair.
    const noPad = ASYMMETRIC_B64.replace(/=+$/, "");
    expect(noPad.length).toBe(86);
    const wallet = await loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: noPad }));
    expect(wallet.signer).toBeDefined();
  });

  it("throws when requirePrivateKey is false and no key is configured", async () => {
    await expect(loadWallet(makeRuntime({}), false)).rejects.toThrow(
      /SOLANA_PUBLIC_KEY or SOLANA_PRIVATE_KEY not found/,
    );
  });
});
