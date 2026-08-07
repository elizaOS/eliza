/**
 * Unit coverage for payout-address validation and README marker serialization.
 */

import { describe, expect, test } from "bun:test";
import {
  generateWalletReadmeComment,
  isValidEthereumAddress,
  isValidSolanaAddress,
  WalletAddressValidationError,
} from "../src/lib/wallet-linking";

describe("wallet linking README marker", () => {
  test("accepts EIP-55, lowercase, and uppercase EVM addresses", () => {
    expect(
      isValidEthereumAddress("0x1111111111111111111111111111111111111111"),
    ).toBe(true);
    expect(
      isValidEthereumAddress("0x52908400098527886E0F7030069857D2E4169EE7"),
    ).toBe(true);
    expect(
      isValidEthereumAddress("0xd2Bb04998A32BBd6A5F666EA306F4745a606495f"),
    ).toBe(true);
  });

  test("rejects invalid EVM formats and mixed-case checksums", () => {
    expect(isValidEthereumAddress("0xprivate-key")).toBe(false);
    expect(
      isValidEthereumAddress("0xd2Bb04998A32BBd6A5F666EA306F4745a606495E"),
    ).toBe(false);
  });

  test("validates public Solana address formats", () => {
    expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isValidSolanaAddress("22222222222222222222222222222222")).toBe(
      false,
    );
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

  test("requires at least one valid address at the serialization boundary", () => {
    expect(() =>
      generateWalletReadmeComment({}, new Date("2026-08-02T09:00:00.000Z")),
    ).toThrow(WalletAddressValidationError);
    expect(() =>
      generateWalletReadmeComment({
        ethereum: "0xd2Bb04998A32BBd6A5F666EA306F4745a606495E",
      }),
    ).toThrow("Enter a valid EVM address.");
    expect(() =>
      generateWalletReadmeComment({ solana: "WALLET-LINKING-END -->" }),
    ).toThrow("Enter a valid Solana address.");
  });
});
