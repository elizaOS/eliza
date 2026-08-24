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

describe("wallet linking validation edges", () => {
  const VALID_SOLANA = "11111111111111111111111111111111";
  const VALID_ETHEREUM = "0x1111111111111111111111111111111111111111";

  test("trims surrounding whitespace before validating EVM addresses", () => {
    expect(isValidEthereumAddress(`  ${VALID_ETHEREUM}  `)).toBe(true);
    expect(isValidEthereumAddress("   ")).toBe(false);
  });

  test("trims surrounding whitespace before validating Solana addresses", () => {
    expect(isValidSolanaAddress(`  ${VALID_SOLANA}  `)).toBe(true);
    expect(isValidSolanaAddress("\t\n")).toBe(false);
  });

  test("rejects a maximum-length Solana string that decodes to 33 bytes", () => {
    expect(isValidSolanaAddress("z".repeat(44))).toBe(false);
  });
});

describe("wallet linking README serialization edges", () => {
  const FIXED_NOW = new Date("2026-08-24T00:00:00.000Z");
  const VALID_SOLANA = "11111111111111111111111111111111";
  const VALID_ETHEREUM = "0x1111111111111111111111111111111111111111";

  function payloadOf(marker: string): unknown {
    return JSON.parse(marker.split("\n").slice(1, -1).join("\n"));
  }

  test("serializes a Solana-only profile with no Ethereum entry", () => {
    const marker = generateWalletReadmeComment(
      { solana: VALID_SOLANA },
      FIXED_NOW,
    );
    expect(payloadOf(marker)).toEqual({
      lastUpdated: "2026-08-24T00:00:00.000Z",
      wallets: [{ chain: "solana", address: VALID_SOLANA }],
    });
    expect(marker.startsWith("<!-- WALLET-LINKING-BEGIN")).toBe(true);
    expect(marker.endsWith("WALLET-LINKING-END -->")).toBe(true);
  });

  test("serializes an Ethereum-only profile with no Solana entry", () => {
    const marker = generateWalletReadmeComment(
      { ethereum: VALID_ETHEREUM },
      FIXED_NOW,
    );
    expect(payloadOf(marker)).toEqual({
      lastUpdated: "2026-08-24T00:00:00.000Z",
      wallets: [{ chain: "ethereum", address: VALID_ETHEREUM }],
    });
  });

  test("treats whitespace-only addresses as absent at the boundary", () => {
    expect(() =>
      generateWalletReadmeComment(
        { ethereum: "   ", solana: "\n\t " },
        FIXED_NOW,
      ),
    ).toThrow("Add at least one public wallet address.");
  });

  test("stores whitespace-trimmed address values in the payload", () => {
    const marker = generateWalletReadmeComment(
      { ethereum: `  ${VALID_ETHEREUM}  `, solana: ` ${VALID_SOLANA} ` },
      FIXED_NOW,
    );
    expect(payloadOf(marker)).toEqual({
      lastUpdated: "2026-08-24T00:00:00.000Z",
      wallets: [
        { chain: "ethereum", address: VALID_ETHEREUM },
        { chain: "solana", address: VALID_SOLANA },
      ],
    });
  });

  test("defaults the timestamp to wall-clock time when omitted", () => {
    const beforeMs = Date.now();
    const marker = generateWalletReadmeComment({ ethereum: VALID_ETHEREUM });
    const afterMs = Date.now();
    const parsed = payloadOf(marker) as { lastUpdated: string };
    const stampMs = Date.parse(parsed.lastUpdated);
    expect(Number.isNaN(stampMs)).toBe(false);
    expect(stampMs).toBeGreaterThanOrEqual(beforeMs);
    expect(stampMs).toBeLessThanOrEqual(afterMs);
  });

  test("reports the EVM failure before the Solana failure", () => {
    expect(() =>
      generateWalletReadmeComment(
        { ethereum: "not-an-address", solana: "not-a-solana-address" },
        FIXED_NOW,
      ),
    ).toThrow("Enter a valid EVM address.");
    expect(() =>
      generateWalletReadmeComment(
        { ethereum: VALID_ETHEREUM, solana: "not-a-solana-address" },
        FIXED_NOW,
      ),
    ).toThrow("Enter a valid Solana address.");
  });

  test("exposes a typed validation error carrying its own name", () => {
    let thrown: unknown = null;
    try {
      generateWalletReadmeComment({}, FIXED_NOW);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletAddressValidationError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as WalletAddressValidationError).name).toBe(
      "WalletAddressValidationError",
    );
  });
});
