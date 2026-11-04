/**
 * Read-only swap quotes for the desk panel.
 *
 * This module fetches a Jupiter route and never builds, signs, or sends a
 * transaction. The desk holds no key and the UI is not allowed to sign, so the
 * trader executes the swap in their own wallet from the link in the result.
 */
import { LIMITS } from "./limits.ts";
import { JUPITER_QUOTE } from "./live-swap.ts";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isMint(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}

export interface SwapQuote {
  inMint: string;
  outMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  route: string;
  /** Where the trader signs. The desk never signs. */
  jupiterUrl: string;
}

export const QUOTE_SLIPPAGE_BPS = 1500;

/**
 * Quote a SOL to token buy. `sol` is what the trader spends.
 * Throws a plain message on bad input or an upstream error, so the route can
 * pass it to the panel without inventing a value.
 */
export async function quoteBuy(
  input: { mint: unknown; sol: unknown },
  fetchImpl: typeof fetch = fetch
): Promise<SwapQuote> {
  if (!isMint(input.mint)) throw new Error("That is not a token address.");
  const sol = Number(input.sol);
  if (!Number.isFinite(sol) || sol <= 0) throw new Error("Enter an amount of SOL above zero.");
  if (sol > 1_000) throw new Error("That amount is above the desk limit.");
  const lamports = Math.round(sol * 1e9);
  if (lamports <= 0) throw new Error("That amount rounds to zero lamports.");

  const url = new URL(JUPITER_QUOTE);
  url.searchParams.set("inputMint", LIMITS.wsolMint);
  url.searchParams.set("outputMint", input.mint);
  url.searchParams.set("amount", String(lamports));
  url.searchParams.set("slippageBps", String(QUOTE_SLIPPAGE_BPS));

  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`Jupiter quote HTTP ${response.status}`);
  const body = (await response.json()) as {
    inAmount?: string;
    outAmount?: string;
    priceImpactPct?: string;
    routePlan?: Array<{ swapInfo?: { label?: string } }>;
  };
  if (!body.outAmount || BigInt(body.outAmount) <= 0n)
    throw new Error("Jupiter found no route for that amount.");

  const route = (body.routePlan ?? [])
    .map((step) => step.swapInfo?.label ?? "")
    .filter((label) => label.length > 0)
    .join(" -> ");

  return {
    inMint: LIMITS.wsolMint,
    outMint: input.mint,
    inAmount: String(body.inAmount ?? lamports),
    outAmount: String(body.outAmount),
    priceImpactPct: String(body.priceImpactPct ?? "0"),
    slippageBps: QUOTE_SLIPPAGE_BPS,
    route: route || "direct",
    jupiterUrl: `https://jup.ag/swap/SOL-${input.mint}`,
  };
}
