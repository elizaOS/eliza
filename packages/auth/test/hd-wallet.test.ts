/** Pins HD-wallet derivation to the canonical BIP-39/44/84/86 vectors. */
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  deriveBitcoinKey,
  deriveEvmKey,
  deriveSolanaKey,
} from "../src/server/wallet/hd-wallet.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("hd-wallet derivation", () => {
  it("derives the reference EVM account at m/44'/60'/0'/0/0", async () => {
    const key = await deriveEvmKey(MNEMONIC, {});
    expect(key.path).toBe("m/44'/60'/0'/0/0");
    // Uncompressed SEC1 point (0x04 || X || Y) — the shape viem and other
    // EVM tooling hash to get the address.
    expect(key.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(privateKeyToAccount(key.privateKey).address.toLowerCase()).toBe(
      "0x9858effd232b4033e47d90003d41ec34ecaeda94",
    );
  });

  it("derives the BIP-84 native SegWit first receive address", async () => {
    const key = await deriveBitcoinKey(MNEMONIC, { addressType: "p2wpkh" });
    expect(key.path).toBe("m/84'/0'/0'/0/0");
    expect(key.address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("derives the BIP-86 taproot first receive address", async () => {
    const key = await deriveBitcoinKey(MNEMONIC, { addressType: "p2tr" });
    expect(key.path).toBe("m/86'/0'/0'/0/0");
    expect(key.address).toBe(
      "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    );
  });

  it("derives the Phantom-path Solana keypair", async () => {
    const key = await deriveSolanaKey(MNEMONIC, {});
    expect(key.path).toBe("m/44'/501'/0'/0'");
    expect(bs58.encode(key.publicKey)).toBe(
      "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
    );
  });
});
