// Exercises address validation behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import { isValidAddress, isValidSolanaAddress } from "./address-validation";

/**
 * Crypto address validation (#8801 — money-safety, shipped untested). Sending
 * funds to an address that passes validation but is malformed loses them, so a
 * regression that accepts a bad address — or rejects a real one — is critical.
 * Real on-chain addresses are used as the positive fixtures.
 */
const WRAPPED_SOL = "So11111111111111111111111111111111111111112"; // real SOL mint
const SYSTEM_PROGRAM = "11111111111111111111111111111111"; // real 32-byte pubkey
const EVM_ZERO = "0x0000000000000000000000000000000000000000";

describe("isValidSolanaAddress", () => {
  it("accepts real base58 32-byte addresses", () => {
    expect(isValidSolanaAddress(WRAPPED_SOL)).toBe(true);
    expect(isValidSolanaAddress(SYSTEM_PROGRAM)).toBe(true);
  });

  it("rejects empty / non-string / wrong-length input", () => {
    expect(isValidSolanaAddress("")).toBe(false);
    expect(isValidSolanaAddress(undefined as unknown as string)).toBe(false);
    expect(isValidSolanaAddress("tooshort")).toBe(false);
    expect(isValidSolanaAddress("1".repeat(50))).toBe(false); // > 44 chars
  });

  it("rejects base58-forbidden characters (0, O, I, l)", () => {
    // 43-char string in the valid length range but containing '0' (not base58)
    expect(isValidSolanaAddress(`0${WRAPPED_SOL.slice(1)}`)).toBe(false);
  });
});

describe("isValidAddress (multi-chain dispatch)", () => {
  it("routes solana addresses (case-insensitive chain)", () => {
    expect(isValidAddress("solana", WRAPPED_SOL)).toBe(true);
    expect(isValidAddress("SOLANA", WRAPPED_SOL)).toBe(true);
    expect(isValidAddress("solana", "not-an-address")).toBe(false);
  });

  it("rejects an unknown chain outright", () => {
    expect(isValidAddress("dogecoin", WRAPPED_SOL)).toBe(false);
    expect(isValidAddress("", EVM_ZERO)).toBe(false);
  });
});
