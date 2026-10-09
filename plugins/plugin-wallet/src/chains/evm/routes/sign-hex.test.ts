/**
 * The browser EVM signer must accept the same hex a dApp sends.
 * `0X4869` is the bytes for "Hi". A lowercase-only `0x` check signs that
 * text instead, and viem rejects calldata whose prefix is `0X`.
 */
import { describe, expect, it } from "vitest";
import {
  evmPersonalSignInput,
  normalizeEvmCalldata,
  parseEvmChainId,
  prefixEvmHex,
} from "./evm-hex.js";

describe("browser EVM hex prefix", () => {
  it("signs 0X personal_sign bytes instead of the hex text", () => {
    expect(evmPersonalSignInput(" \t0X4869\n")).toEqual({ raw: "0x4869" });
    expect(evmPersonalSignInput("0x4869")).toEqual({ raw: "0x4869" });
    expect(evmPersonalSignInput("hello")).toBe("hello");
  });

  it("does not double-prefix calldata that already uses 0X", () => {
    expect(prefixEvmHex("0X1234")).toBe("0x1234");
    expect(prefixEvmHex("abcd")).toBe("0xabcd");
  });

  it("gives viem a lowercase 0x calldata prefix", () => {
    expect(normalizeEvmCalldata("0X1234")).toBe("0x1234");
    expect(normalizeEvmCalldata("0x1234")).toBe("0x1234");
    expect(normalizeEvmCalldata(undefined)).toBeUndefined();
  });

  it("accepts an uppercase hex chain id", () => {
    expect(parseEvmChainId("0X89")).toBe(137);
    expect(parseEvmChainId("0x89")).toBe(137);
    expect(parseEvmChainId("0x1g")).toBeNull();
  });
});
