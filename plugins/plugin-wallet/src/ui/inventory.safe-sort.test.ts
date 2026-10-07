/**
 * Verifies safe sorting and NaN-handling in wallet inventory helpers and components.
 */

import type { WalletBalancesResponse } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import { parseUsd, summarizeWalletBalances } from "./InventoryView.helpers.js";

describe("wallet inventory safe sort", () => {
  it("parses USD values safely for NaN and Infinity", () => {
    expect(parseUsd(NaN)).toBe(0);
    expect(parseUsd(Infinity)).toBe(0);
    expect(parseUsd(-Infinity)).toBe(0);
    expect(parseUsd("invalid-number")).toBe(0);
    expect(parseUsd("123.45")).toBe(123.45);
    expect(parseUsd(50.5)).toBe(50.5);
    expect(parseUsd(null)).toBe(0);
    expect(parseUsd(undefined)).toBe(0);
  });

  it("safely summarizes and sorts wallet balances when token values contain NaN or malformed numbers", () => {
    const mockBalances: WalletBalancesResponse = {
      evm: {
        chains: [
          {
            chain: "Ethereum",
            nativeSymbol: "ETH",
            nativeBalance: "1.5",
            nativeValueUsd: "NaN",
            tokens: [
              {
                symbol: "USDC",
                name: "USD Coin",
                contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                balance: "1000",
                valueUsd: 1000,
              },
              {
                symbol: "BAD",
                name: "Bad Token",
                contractAddress: "0xbad",
                balance: "10",
                valueUsd: "invalid-usd",
              },
            ],
          },
        ],
      },
      solana: {
        solBalance: "10",
        solValueUsd: 1500,
        tokens: [
          {
            symbol: "JUP",
            name: "Jupiter",
            mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
            balance: "500",
            valueUsd: 500,
          },
        ],
      },
    } as unknown as WalletBalancesResponse;

    const summary = summarizeWalletBalances(mockBalances);

    expect(summary.tokens).toHaveLength(5);
    // Highest value first: SOL ($1500) -> USDC ($1000) -> JUP ($500) -> ETH native ($0) -> BAD ($0)
    expect(summary.tokens[0].symbol).toBe("SOL");
    expect(summary.tokens[1].symbol).toBe("USDC");
    expect(summary.tokens[2].symbol).toBe("JUP");
    expect(summary.totalUsd).toBe(3000);
  });

  it("safely handles non-finite subtraction in value sort comparators", () => {
    const aVal = NaN;
    const bVal = 500;
    const oldDiff = aVal - bVal;
    expect(Number.isNaN(oldDiff)).toBe(true);

    const safeA = Number.isFinite(aVal) ? aVal : 0;
    const safeB = Number.isFinite(bVal) ? bVal : 0;
    const safeDiff = safeB - safeA;
    expect(safeDiff).toBe(500);
  });
});

it("projects only whole finite provider amounts into wallet totals and ordering", () => {
  const cases: Array<[string, number]> = [
    ["12junk", 0],
    ["0x10", 0],
    ["Infinity", 0],
    [" 12.50 ", 12.5],
    ["1.25e2", 125],
    ["", 0],
    ["1e999", 0],
  ];
  const tokens = cases.map(([valueUsd], index) => ({
    symbol: `CASE${index}`,
    name: `Case ${index}`,
    contractAddress: `0x${index}`,
    balance: "1",
    valueUsd,
  }));
  const balances = {
    evm: {
      chains: [
        {
          chain: "Ethereum",
          nativeSymbol: "ETH",
          nativeBalance: "0",
          nativeValueUsd: "0",
          tokens,
        },
      ],
    },
    solana: null,
  } as unknown as WalletBalancesResponse;
  for (const [value, expected] of cases) expect(parseUsd(value)).toBe(expected);
  const summary = summarizeWalletBalances(balances);
  expect(summary.totalUsd).toBe(137.5);
  expect(summary.tokens.slice(0, 2).map((token) => token.symbol)).toEqual([
    "CASE4",
    "CASE3",
  ]);
  expect(
    Object.fromEntries(
      summary.tokens
        .filter((token) => !token.isNative)
        .map((token) => [token.symbol, token.valueUsd]),
    ),
  ).toEqual(
    Object.fromEntries(
      cases.map(([, expected], index) => [`CASE${index}`, expected]),
    ),
  );
});
