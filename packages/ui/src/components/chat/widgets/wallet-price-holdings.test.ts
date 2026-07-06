// Wallet-widget row selection: `selectPricedHoldings` (held path — empty on
// missing balances, price-only rows with no amount/holding value leaked, dust
// (<$1) skipped, capped at the top 3 by holding value, only priced symbols
// included, same symbol aggregated across chains, native SOL/ETH counted);
// `selectDefaultPriceRows` (BTC/SOL/ETH baseline + trending fill); and
// `selectWalletWidgetRows` (the doctrine composition, #14344). Pure — no jsdom.
import type {
  WalletBalancesResponse,
  WalletMarketMover,
  WalletMarketOverviewResponse,
  WalletMarketPriceSnapshot,
} from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_PRICED_HOLDINGS,
  MIN_HOLDING_USD,
  type PricedHolding,
  selectDefaultPriceRows,
  selectPricedHoldings,
  selectWalletWidgetRows,
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

  it("caps the list at the top 3 by holding value (ranked desc)", () => {
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
    expect(MAX_PRICED_HOLDINGS).toBe(3);
    // top 3 by value: G(70) B(60) D(50)
    expect(rows.map((r) => r.symbol)).toEqual(["G", "B", "D"]);
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

const mover = (
  symbol: string,
  priceUsd: number,
  change24hPct = 0,
): WalletMarketMover => ({
  id: symbol.toLowerCase(),
  symbol,
  name: symbol,
  priceUsd,
  change24hPct,
  marketCapRank: null,
  imageUrl: null,
});

/** Build a market overview from fixed price snapshots + optional movers. */
function overview(
  prices: WalletMarketPriceSnapshot[],
  movers: WalletMarketMover[] = [],
): WalletMarketOverviewResponse {
  return { prices, movers } as unknown as WalletMarketOverviewResponse;
}

describe("selectDefaultPriceRows", () => {
  it("returns [] when there is no overview", () => {
    expect(selectDefaultPriceRows(null)).toEqual([]);
    expect(selectDefaultPriceRows(undefined)).toEqual([]);
  });

  it("returns BTC/SOL/ETH in doctrine order from the fixed snapshots", () => {
    // Provided out of order — output must be BTC, SOL, ETH regardless.
    const rows = selectDefaultPriceRows(
      overview([
        price("ETH", 3000, 1.1),
        price("BTC", 64000, -0.5),
        price("SOL", 150, 2.2),
      ]),
    );
    expect(rows).toEqual<PricedHolding[]>([
      { symbol: "BTC", priceUsd: 64000, change24hPct: -0.5 },
      { symbol: "SOL", priceUsd: 150, change24hPct: 2.2 },
      { symbol: "ETH", priceUsd: 3000, change24hPct: 1.1 },
    ]);
  });

  it("fills a missing fixed snapshot from trending movers, up to 3 rows", () => {
    // Partial-source response: SOL snapshot dropped → fill one trending row,
    // never a duplicate of an already-shown fixed symbol.
    const rows = selectDefaultPriceRows(
      overview(
        [price("BTC", 64000), price("ETH", 3000)],
        [mover("BTC", 64000), mover("DOGE", 0.2, 12)],
      ),
    );
    expect(rows.map((r) => r.symbol)).toEqual(["BTC", "ETH", "DOGE"]);
  });

  it("never exceeds MAX_PRICED_HOLDINGS even with many movers", () => {
    const rows = selectDefaultPriceRows(
      overview(
        [],
        [mover("A", 1), mover("B", 2), mover("C", 3), mover("D", 4)],
      ),
    );
    expect(rows).toHaveLength(MAX_PRICED_HOLDINGS);
    expect(rows.map((r) => r.symbol)).toEqual(["A", "B", "C"]);
  });
});

describe("selectWalletWidgetRows (doctrine composition, #14344)", () => {
  it("shows top-3 held when the account holds ≥1 priced asset", () => {
    const rows = selectWalletWidgetRows(
      balances([
        { symbol: "USDC", valueUsd: "500" },
        { symbol: "WBTC", valueUsd: "2000" },
      ]),
      overview([price("USDC", 1), price("WBTC", 64000)]),
    );
    expect(rows.map((r) => r.symbol)).toEqual(["WBTC", "USDC"]);
  });

  it("falls back to the BTC/SOL/ETH baseline when nothing is held", () => {
    const rows = selectWalletWidgetRows(
      balances([]),
      overview([price("BTC", 64000), price("SOL", 150), price("ETH", 3000)]),
    );
    expect(rows.map((r) => r.symbol)).toEqual(["BTC", "SOL", "ETH"]);
  });

  it("shows the baseline when balances are unavailable but overview loaded", () => {
    const rows = selectWalletWidgetRows(
      null,
      overview([price("BTC", 64000), price("SOL", 150), price("ETH", 3000)]),
    );
    expect(rows.map((r) => r.symbol)).toEqual(["BTC", "SOL", "ETH"]);
  });

  it("returns [] (self-hide) only when both balances and overview are null", () => {
    expect(selectWalletWidgetRows(null, null)).toEqual([]);
  });
});
