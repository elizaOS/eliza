/**
 * BNB / USD price oracle for native BNB pay-in.
 *
 * BNB's price is decoupled from USD, so a dollar-quoted purchase can't be
 * naively converted to wei. We quote the live BNB/USD price at the moment
 * the user presses Buy and lock that quote into the payment record
 * (`metadata.price_quote`). The confirm step verifies the on-chain
 * `tx.value` is within `slippage_bps` of that locked quote.
 *
 * Sources, tried in order:
 *   1. Chainlink BNB/USD aggregator on BSC (decimals=8). Source of truth in
 *      production — manipulation-resistant, on-chain, ~60s heartbeat.
 *   2. CoinGecko spot price (REST). Fallback when the BSC RPC is unreachable.
 *
 * The result includes the source so we can audit which oracle priced any
 * given payment.
 */

import Decimal from "decimal.js";
import { type Address, createPublicClient, getAddress, type Hex, http, parseAbi } from "viem";
import { bsc } from "viem/chains";

import { resolveEvmRpc } from "../config/evm-rpc";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";

/** Chainlink BNB/USD aggregator on BSC mainnet (8 decimals, ~60s heartbeat). */
const CHAINLINK_BNB_USD: Address = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";

const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/**
 * Reject the oracle if the last update is older than this. The feed normally
 * ticks every minute; an hour of staleness means the feed is unhealthy and
 * the price could be far from market. Locking a payment to a stale quote is
 * how exchanges get drained.
 */
const BNB_USD_MAX_AGE_SECONDS = 60 * 60;
const COINGECKO_TIMEOUT_MS = 5000;
const CHAINLINK_TIMEOUT_MS = 5000;

export interface BnbPriceQuote {
  priceUsd: Decimal;
  source: "chainlink" | "coingecko";
  feedAddress?: Hex;
  updatedAt: number; // unix-seconds when the oracle last updated
  fetchedAt: number; // unix-ms when we read it
}

function envString(key: string): string | null {
  const v = getCloudAwareEnv()[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function fetchFromChainlink(): Promise<BnbPriceQuote> {
  const feedOverride = envString("CRYPTO_DIRECT_BSC_BNB_USD_FEED");
  const feed = feedOverride ? getAddress(feedOverride) : CHAINLINK_BNB_USD;
  const { url } = resolveEvmRpc("bnb");
  const client = createPublicClient({
    chain: bsc,
    transport: http(url, { timeout: CHAINLINK_TIMEOUT_MS }),
  });

  const [round, decimals] = await Promise.all([
    client.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
    client.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    }),
  ]);

  const [, answer, , updatedAtSec] = round;
  if (answer <= 0n) {
    throw new Error("Chainlink returned non-positive BNB/USD price");
  }
  const updatedAt = Number(updatedAtSec);
  const ageSeconds = Math.floor(Date.now() / 1000) - updatedAt;
  if (ageSeconds < 0 || ageSeconds > BNB_USD_MAX_AGE_SECONDS) {
    throw new Error(
      `Chainlink BNB/USD price is stale (last update ${ageSeconds}s ago); refusing to quote`,
    );
  }
  const priceUsd = new Decimal(answer.toString()).div(new Decimal(10).pow(Number(decimals)));
  if (priceUsd.lessThan(50) || priceUsd.greaterThan(100_000)) {
    // Sanity bounds — BNB has never traded outside this range.
    throw new Error(`Chainlink BNB/USD price out of sanity bounds: ${priceUsd.toString()}`);
  }
  return {
    priceUsd,
    source: "chainlink",
    feedAddress: feed,
    updatedAt,
    fetchedAt: Date.now(),
  };
}

async function fetchFromCoinGecko(): Promise<BnbPriceQuote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COINGECKO_TIMEOUT_MS);
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd",
      { signal: controller.signal },
    );
    if (!res.ok) {
      throw new Error(`CoinGecko returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { binancecoin?: { usd?: number } };
    const usd = json?.binancecoin?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      throw new Error("CoinGecko payload missing usd price");
    }
    const priceUsd = new Decimal(usd);
    if (priceUsd.lessThan(50) || priceUsd.greaterThan(100_000)) {
      throw new Error(`CoinGecko BNB/USD price out of sanity bounds: ${priceUsd.toString()}`);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      priceUsd,
      source: "coingecko",
      updatedAt: nowSec,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a live BNB/USD quote. Tries Chainlink first; falls back to CoinGecko.
 * Throws if both sources fail — the caller should refuse to create the
 * payment rather than guess at the price.
 */
export async function getBnbUsdQuote(): Promise<BnbPriceQuote> {
  try {
    return await fetchFromChainlink();
  } catch (chainlinkError) {
    logger.warn("[bnb-price-oracle] Chainlink read failed; trying CoinGecko", {
      error: chainlinkError instanceof Error ? chainlinkError.message : String(chainlinkError),
    });
    try {
      return await fetchFromCoinGecko();
    } catch (geckoError) {
      const chainlinkMsg =
        chainlinkError instanceof Error ? chainlinkError.message : String(chainlinkError);
      const geckoMsg = geckoError instanceof Error ? geckoError.message : String(geckoError);
      throw new Error(
        `BNB price oracle unavailable. Chainlink: ${chainlinkMsg}. CoinGecko: ${geckoMsg}.`,
      );
    }
  }
}
