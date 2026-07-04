/**
 * Normalizes wallet price and holding data for finance chat widgets before
 * they render portfolio rows.
 */
import type {
  WalletBalancesResponse,
  WalletMarketPriceSnapshot,
} from "@elizaos/contracts";

/**
 * Price-only wallet widget derivation (#10706).
 *
 * The wallet widget must show the top cryptocurrencies the user HOLDS, by
 * **unit price only** — never the amount held or the holding value. This pure
 * function does exactly that selection so the widget component only renders:
 *
 *   1. collect every holding (EVM native + tokens per chain, Solana SOL +
 *      tokens) with its USD holding value,
 *   2. drop any holding worth < $1 (dust),
 *   3. aggregate the same symbol across chains (its holding value is used only
 *      for ranking, never surfaced),
 *   4. keep only symbols that have a unit price in the market overview,
 *   5. rank by aggregated holding value (desc; ties broken by symbol), take
 *      top 5,
 *   6. return price-only rows — `{ symbol, priceUsd, change24hPct }`, with NO
 *      balance, holding value, or portfolio total.
 */

/** The minimum holding value (USD) a position must be worth to appear. */
export const MIN_HOLDING_USD = 1;
/** Max assets shown in the price-only widget. */
export const MAX_PRICED_HOLDINGS = 5;

/** A price-only row — deliberately carries no amount/holding value. */
export interface PricedHolding {
  symbol: string;
  priceUsd: number;
  change24hPct: number;
}

function parseUsd(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Flatten every held position to `{ symbol, valueUsd }` (holding value). */
function collectHoldings(
  balances: WalletBalancesResponse,
): { symbol: string; valueUsd: number }[] {
  const out: { symbol: string; valueUsd: number }[] = [];
  const { solana, evm } = balances;
  if (solana) {
    out.push({ symbol: "SOL", valueUsd: parseUsd(solana.solValueUsd) });
    for (const t of solana.tokens) {
      out.push({ symbol: t.symbol, valueUsd: parseUsd(t.valueUsd) });
    }
  }
  if (evm) {
    for (const chain of evm.chains) {
      out.push({
        symbol: chain.nativeSymbol,
        valueUsd: parseUsd(chain.nativeValueUsd),
      });
      for (const t of chain.tokens) {
        out.push({ symbol: t.symbol, valueUsd: parseUsd(t.valueUsd) });
      }
    }
  }
  return out;
}

/**
 * Select the top-{@link MAX_PRICED_HOLDINGS} priced holdings for the price-only
 * widget. See the module docstring for the exact contract. Pure + deterministic.
 */
export function selectPricedHoldings(
  balances: WalletBalancesResponse | null | undefined,
  prices: readonly WalletMarketPriceSnapshot[] | null | undefined,
): PricedHolding[] {
  if (!balances) return [];

  // symbol -> unit price snapshot (case-insensitive; first wins).
  const priceBySymbol = new Map<string, WalletMarketPriceSnapshot>();
  for (const p of prices ?? []) {
    const key = p.symbol.trim().toUpperCase();
    if (key && !priceBySymbol.has(key)) priceBySymbol.set(key, p);
  }

  // Aggregate holding value per symbol (used only for ranking, never surfaced).
  const heldValueBySymbol = new Map<string, number>();
  for (const { symbol, valueUsd } of collectHoldings(balances)) {
    if (valueUsd < MIN_HOLDING_USD) continue; // skip dust (< $1)
    const key = symbol.trim().toUpperCase();
    if (!key) continue;
    heldValueBySymbol.set(key, (heldValueBySymbol.get(key) ?? 0) + valueUsd);
  }

  const ranked = [...heldValueBySymbol.entries()]
    .filter(([symbol]) => priceBySymbol.has(symbol)) // must have a unit price
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]; // holding value desc
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; // tie-break by symbol
    })
    .slice(0, MAX_PRICED_HOLDINGS);

  return ranked.map(([symbol]) => {
    const snap = priceBySymbol.get(symbol);
    // biome-ignore lint/style/noNonNullAssertion: filtered to has-price above.
    const price = snap!;
    return {
      symbol: price.symbol,
      priceUsd: price.priceUsd,
      change24hPct: price.change24hPct,
    };
  });
}
