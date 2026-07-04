// `selectPricedHoldings` selection logic: empty on missing balances, price-only
// rows with no amount/holding value leaked, dust (<$1) skipped, capped at the top
// 5 by holding value, only priced symbols included, same symbol aggregated across
// chains (case-insensitive), native SOL/ETH counted. Pure function — no jsdom.
import type {
  WalletBalancesResponse,
  WalletMarketPriceSnapshot,
} from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_PRICED_HOLDINGS,
  MIN_HOLDING_USD,
  type PricedHolding,
  selectPricedHoldings,
} from "./wallet-price-holdings.ts";

/**
 * Price-only wallet widget derivation (#10706). The acceptance criteria are the
 * contract: top-5 HELD assets, prices only, skip holdings < $1, and never leak
 * the amount/holding value. Each is pinned here.
 */

const price = (
  symbol: string,
  priceUsd: number,
  change24hPct = 0,
): WalletMarketPriceSnapshot => ({
  id: symbol.toLowerCase(),
  symbol,
  name: symbol,
  priceUsd,
  change24hPct,
  imageUrl: null,
});

/** Build a balances response from simple `{symbol, valueUsd}` holdings. */
function balances(
  evmTokens: { symbol: string; valueUsd: string }[] = [],
  solTokens: { symbol: string; valueUsd: string }[] = [],
  opts: { solValueUsd?: string; ethNativeUsd?: string } = {},
): WalletBalancesResponse {
  return {
    evm: {
      address: "0xabc",
      chains: [
        {
          chain: "ethereum",
          chainId: 1,
          nativeBalance: "0",
          nativeSymbol: "ETH",
          nativeValueUsd: opts.ethNativeUsd ?? "0",
          tokens: evmTokens.map((t) => ({
            symbol: t.symbol,
            name: t.symbol,
            address: `0x${t.symbol}`,
            balance: "0",
            decimals: 18,
            valueUsd: t.valueUsd,
          })),
          error: null,
        },
      ],
    },
    solana: {
      address: "sol1",
      solBalance: "0",
      solValueUsd: opts.solValueUsd ?? "0",
      tokens: solTokens.map((t) => ({
        symbol: t.symbol,
        name: t.symbol,
        mint: t.symbol,
        balance: "0",
        decimals: 9,
        valueUsd: t.valueUsd,
      })),
    },
  } as unknown as WalletBalancesResponse;
}

describe("selectPricedHoldings", () => {
  it("returns [] for missing balances", () => {
    expect(selectPricedHoldings(null, [price("ETH", 3000)])).toEqual([]);
    expect(selectPricedHoldings(undefined, [])).toEqual([]);
  });

  it("returns price-only rows with NO amount/holding value leaked", () => {
    const rows = selectPricedHoldings(
      balances([{ symbol: "USDC", valueUsd: "500" }]),
      [price("USDC", 1.0, -0.01)],
    );
    expect(rows).toEqual<PricedHolding[]>([
      { symbol: "USDC", priceUsd: 1.0, change24hPct: -0.01 },
    ]);
    // the row shape carries only symbol/price/change — no balance/valueUsd key
    expect(Object.keys(rows[0]).sort()).toEqual([
      "change24hPct",
      "priceUsd",
      "symbol",
    ]);
  });

  it("skips holdings worth less than $1 (dust)", () => {
    const rows = selectPricedHoldings(
      balances([
        { symbol: "USDC", valueUsd: "5" }, // kept
        { symbol: "SHIB", valueUsd: "0.40" }, // dust → dropped
        { symbol: "PEPE", valueUsd: "0.99" }, // just under → dropped
      ]),
      [price("USDC", 1), price("SHIB", 0.00001), price("PEPE", 0.000001)],
    );
    expect(rows.map((r) => r.symbol)).toEqual(["USDC"]);
    expect(MIN_HOLDING_USD).toBe(1);
  });

  it("caps the list at the top 5 by holding value (ranked desc)", () => {
    const held = [
      { symbol: "A", valueUsd: "10" },
      { symbol: "B", valueUsd: "60" },
      { symbol: "C", valueUsd: "30" },
      { symbol: "D", valueUsd: "50" },
      { symbol: "E", valueUsd: "20" },
      { symbol: "F", valueUsd: "40" },
      { symbol: "G", valueUsd: "70" },
    ];
    const rows = selectPricedHoldings(
      balances(held),
      held.map((h) => price(h.symbol, 1)),
    );
    expect(rows).toHaveLength(MAX_PRICED_HOLDINGS);
    // top 5 by value: G(70) B(60) D(50) F(40) C(30)
    expect(rows.map((r) => r.symbol)).toEqual(["G", "B", "D", "F", "C"]);
  });

  it("only includes symbols that have a unit price in the market overview", () => {
    const rows = selectPricedHoldings(
      balances([
        { symbol: "USDC", valueUsd: "100" },
        { symbol: "UNKNOWN", valueUsd: "999" }, // held but no price → excluded
      ]),
      [price("USDC", 1)],
    );
    expect(rows.map((r) => r.symbol)).toEqual(["USDC"]);
  });

  it("aggregates the same symbol across chains for ranking (case-insensitive)", () => {
    // USDC held on EVM ($30) + Solana ($40) aggregates to $70 → outranks ETH $50
    const rows = selectPricedHoldings(
      balances(
        [{ symbol: "usdc", valueUsd: "30" }],
        [{ symbol: "USDC", valueUsd: "40" }],
        { ethNativeUsd: "50" },
      ),
      [price("USDC", 1), price("ETH", 3000)],
    );
    expect(rows.map((r) => r.symbol)).toEqual(["USDC", "ETH"]);
  });

  it("counts native SOL and native ETH as holdings", () => {
    const rows = selectPricedHoldings(
      balances([], [], { solValueUsd: "25", ethNativeUsd: "80" }),
      [price("ETH", 3000), price("SOL", 150)],
    );
    expect(rows.map((r) => r.symbol)).toEqual(["ETH", "SOL"]);
  });

  it("renders nothing when no qualifying priced holdings exist", () => {
    expect(
      selectPricedHoldings(balances([{ symbol: "SHIB", valueUsd: "0.10" }]), [
        price("SHIB", 0.00001),
      ]),
    ).toEqual([]);
  });
});
