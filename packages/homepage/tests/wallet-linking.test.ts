import { describe, expect, test } from "bun:test";
import {
  generateWalletReadmeComment,
  isValidEthereumAddress,
  isValidSolanaAddress,
} from "../src/lib/wallet-linking";

describe("wallet linking README marker", () => {
  test("validates public EVM and Solana address formats", () => {
    expect(
      isValidEthereumAddress("0x1111111111111111111111111111111111111111"),
    ).toBe(true);
    expect(isValidEthereumAddress("0xprivate-key")).toBe(false);
    expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isValidSolanaAddress("contains_underscore")).toBe(false);
  });

  test("generates the compatible hidden marker deterministically", () => {
    expect(
      generateWalletReadmeComment(
        {
          ethereum: "0x1111111111111111111111111111111111111111",
          solana: "11111111111111111111111111111111",
        },
        new Date("2026-08-02T09:00:00.000Z"),
      ),
    ).toBe(`<!-- WALLET-LINKING-BEGIN
{
  "lastUpdated": "2026-08-02T09:00:00.000Z",
  "wallets": [
    {
      "chain": "ethereum",
      "address": "0x1111111111111111111111111111111111111111"
    },
    {
      "chain": "solana",
      "address": "11111111111111111111111111111111"
    }
  ]
}
WALLET-LINKING-END -->`);
  });

  test("requires at least one address", () => {
    expect(() =>
      generateWalletReadmeComment({}, new Date("2026-08-02T09:00:00.000Z")),
    ).toThrow("Add at least one public wallet address.");
  });
});
