/** Exercises the shared crypto transaction identity boundary with deterministic strings. */

import { describe, expect, test } from "bun:test";
import {
  canonicalizeCryptoTransactionHash,
  cryptoTransactionHashesEqual,
} from "./crypto-payment-transaction-hash";

describe("crypto payment transaction hash identity", () => {
  test("canonicalizes EVM hexadecimal casing", () => {
    expect(canonicalizeCryptoTransactionHash(" 0xAbCd1234 ", "bsc")).toBe("0xabcd1234");
    expect(cryptoTransactionHashesEqual("0xABCD1234", "0xabcd1234", "base")).toBe(true);
  });

  test("preserves case-sensitive Solana transaction identifiers", () => {
    expect(canonicalizeCryptoTransactionHash("5AbCdEfGh", "solana")).toBe("5AbCdEfGh");
    expect(cryptoTransactionHashesEqual("5AbCdEfGh", "5abcdefGh", "solana")).toBe(false);
  });

  test("rejects empty transaction identities", () => {
    expect(() => canonicalizeCryptoTransactionHash("  ", "bsc")).toThrow("must not be empty");
  });
});
