/**
 * Coverage for token-address.
 */
import { describe, expect, it } from "vitest";
import { normalizeTokenAddress } from "./token-address.js";

describe("token-address", () => {
  it("lowercases evm", () => {
    expect(normalizeTokenAddress("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01", "ethereum")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });
  it("lowercases evm by shape", () => {
    expect(normalizeTokenAddress("0xABCDEF0123456789ABCDEF0123456789ABCDEF12")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef12",
    );
  });
  it("preserves solana", () => {
    expect(normalizeTokenAddress("So11111111111111111111111111111111111111112", "solana")).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });
  it("preserves non-hex", () => {
    expect(normalizeTokenAddress("not-an-address")).toBe("not-an-address");
  });
});
