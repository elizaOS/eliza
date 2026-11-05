/**
 * A copied 0X prefix is still an EVM or Sui address. The lowercase-only
 * regex rejected it before the market and chain proxies ran.
 */

import { describe, expect, test } from "vitest";
import {
  canonicalPrefixedHex,
  canonicalizeAddressParams,
  isValidAddress,
} from "./address-validation";

const EVM = "fde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const SUI = "ab".repeat(32);
const SOLANA = "So11111111111111111111111111111111111111112";

describe("chain address prefix", () => {
  test("accepts a 0X EVM address and sends one lowercase prefix", () => {
    const raw = `0X${EVM}`;
    expect(isValidAddress("ethereum", raw)).toBe(true);
    expect(isValidAddress("BASE", `0x${EVM}`)).toBe(true);
    expect(canonicalPrefixedHex(raw)).toBe(`0x${EVM}`);
    expect(canonicalizeAddressParams({ address: raw }).address).toBe(`0x${EVM}`);
  });

  test("accepts a 0X Sui address", () => {
    expect(isValidAddress("sui", `0X${SUI}`)).toBe(true);
    expect(canonicalPrefixedHex(`0X${SUI}`)).toBe(`0x${SUI}`);
  });

  test("still rejects a short prefix and leaves a Solana address unchanged", () => {
    expect(isValidAddress("ethereum", "0Xabc")).toBe(false);
    expect(isValidAddress("solana", `0X${EVM}`)).toBe(false);
    expect(isValidAddress("solana", SOLANA)).toBe(true);
    expect(canonicalizeAddressParams({ address: SOLANA }).address).toBe(SOLANA);
  });
});
