import { clamp } from "@feed/shared";
import type { PerpMarketRecord } from "./types";

export type SyntheticQuoteSide = "buy" | "sell";

export interface SyntheticPerpQuoteState {
  midPrice: number;
  bidPrice: number;
  askPrice: number;
  spreadBps: number;
  bidDepth: number;
  askDepth: number;
  liquidityRegime: "thin" | "balanced" | "deep";
}

export interface SyntheticPerpExecution {
  midPrice: number;
  bidPrice: number;
  askPrice: number;
  spreadBps: number;
  bidDepth: number;
  askDepth: number;
  impactBps: number;
  executionPrice: number;
  nextMidPrice: number;
}

function getFinitePositivePrice(
  ...candidates: Array<number | undefined>
): number | undefined {
  return candidates.find(
    (candidate) => Number.isFinite(candidate) && (candidate ?? 0) > 0,
  );
}

function safeRatio(numerator: number, denominator: number): number {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return 0;
  }
  return numerator / denominator;
}

function getBaseDepth(market: PerpMarketRecord): number {
  const minOrderSize = market.minOrderSize ?? 10;
  // Keep the default depth model on normal markets, but cap extreme OI/volume
  // contributions so corrupted or highly skewed snapshots do not make a market
  // effectively impossible to move.
  const openInterestContribution = Math.min(
    Math.max(market.openInterest, 0) * 0.08,
    250_000,
  );
  const volumeContribution = Math.min(
    Math.max(market.volume24h, 0) * 0.02,
    150_000,
  );
  const baseDepth = 500 + openInterestContribution + volumeContribution;
  return Math.max(minOrderSize * 10, baseDepth);
}

function getLiquidityRegime(
  openInterest: number,
): "thin" | "balanced" | "deep" {
  if (openInterest >= 100_000) return "deep";
  if (openInterest >= 10_000) return "balanced";
  return "thin";
}

function getTargetQuoteState(
  market: PerpMarketRecord,
): SyntheticPerpQuoteState {
  const midPrice = getFinitePositivePrice(
    market.currentPrice,
    market.markPrice,
    market.indexPrice,
    100,
  )!;

  const indexReference =
    getFinitePositivePrice(market.indexPrice, market.markPrice, midPrice) ??
    midPrice;
  const markReference =
    getFinitePositivePrice(market.markPrice, market.indexPrice, midPrice) ??
    midPrice;

  const changeMagnitude = Math.abs(market.changePercent24h ?? 0);
  const volatilityBps = clamp(changeMagnitude * 3, 0, 120);
  const premiumBps = clamp(
    Math.abs(safeRatio(markReference - indexReference, indexReference)) * 10000,
    0,
    180,
  );
  const liquidityBps = clamp(
    45 / Math.sqrt(1 + market.openInterest / 25_000),
    8,
    45,
  );

  const spreadBps = clamp(
    12 + volatilityBps + premiumBps * 0.35 + liquidityBps,
    8,
    160,
  );
  const halfSpread = (midPrice * spreadBps) / 20_000;

  const imbalanceSignal = clamp(
    safeRatio(markReference - indexReference, indexReference),
    -0.35,
    0.35,
  );
  const baseDepth = getBaseDepth(market);
  const bidDepth = Math.max(
    market.minOrderSize ?? 10,
    baseDepth * (1 + imbalanceSignal * 0.45),
  );
  const askDepth = Math.max(
    market.minOrderSize ?? 10,
    baseDepth * (1 - imbalanceSignal * 0.45),
  );

  return {
    midPrice,
    bidPrice: Math.max(0.0001, midPrice - halfSpread),
    askPrice: Math.max(midPrice, midPrice + halfSpread),
    spreadBps,
    bidDepth,
    askDepth,
    liquidityRegime: getLiquidityRegime(market.openInterest),
  };
}

export function getSyntheticPerpQuoteState(
  market: PerpMarketRecord,
): SyntheticPerpQuoteState {
  if (
    Number.isFinite(market.bidPrice) &&
    Number.isFinite(market.askPrice) &&
    Number.isFinite(market.spreadBps) &&
    Number.isFinite(market.bidDepth) &&
    Number.isFinite(market.askDepth) &&
    (market.bidPrice ?? 0) > 0 &&
    (market.askPrice ?? 0) >= (market.bidPrice ?? 0) &&
    (market.bidDepth ?? 0) > 0 &&
    (market.askDepth ?? 0) > 0
  ) {
    return {
      midPrice: getFinitePositivePrice(
        market.currentPrice,
        market.markPrice,
        market.indexPrice,
        ((market.bidPrice ?? 0) + (market.askPrice ?? 0)) / 2,
      )!,
      bidPrice: market.bidPrice!,
      askPrice: market.askPrice!,
      spreadBps: market.spreadBps!,
      bidDepth: market.bidDepth!,
      askDepth: market.askDepth!,
      liquidityRegime:
        market.liquidityRegime ?? getLiquidityRegime(market.openInterest),
    };
  }

  return getTargetQuoteState(market);
}

export function evolveSyntheticPerpQuoteState(params: {
  market: PerpMarketRecord;
  previousQuote?: SyntheticPerpQuoteState | null;
  elapsedMs?: number;
}): SyntheticPerpQuoteState {
  const target = getTargetQuoteState(params.market);
  const previous = params.previousQuote;
  if (!previous) {
    return target;
  }

  const elapsedMs = Math.max(0, params.elapsedMs ?? 60_000);
  const recovery = clamp(elapsedMs / (8 * 60 * 1000), 0.12, 0.55);
  const shockFraction = clamp(
    Math.abs(target.midPrice - previous.midPrice) /
      Math.max(previous.midPrice, 1),
    0,
    0.08,
  );
  const stressSpread = target.spreadBps * (1 + shockFraction * 8);
  const stressBidDepth = target.bidDepth / (1 + shockFraction * 6);
  const stressAskDepth = target.askDepth / (1 + shockFraction * 6);

  const spreadBps = clamp(
    previous.spreadBps + (stressSpread - previous.spreadBps) * recovery,
    8,
    220,
  );
  const bidDepth = Math.max(
    params.market.minOrderSize ?? 10,
    previous.bidDepth + (stressBidDepth - previous.bidDepth) * recovery,
  );
  const askDepth = Math.max(
    params.market.minOrderSize ?? 10,
    previous.askDepth + (stressAskDepth - previous.askDepth) * recovery,
  );
  const halfSpread = (target.midPrice * spreadBps) / 20_000;

  return {
    midPrice: target.midPrice,
    bidPrice: Math.max(0.0001, target.midPrice - halfSpread),
    askPrice: Math.max(target.midPrice, target.midPrice + halfSpread),
    spreadBps,
    bidDepth,
    askDepth,
    liquidityRegime: target.liquidityRegime,
  };
}

export function getSyntheticPerpExecutionPrice(params: {
  market: PerpMarketRecord;
  side: SyntheticQuoteSide;
  size: number;
}): SyntheticPerpExecution {
  const { market, side, size } = params;
  const quoteState = getSyntheticPerpQuoteState(market);
  const { midPrice, bidPrice, askPrice, spreadBps, bidDepth, askDepth } =
    quoteState;

  const sideDepth = side === "buy" ? askDepth : bidDepth;
  const depthRatio = clamp(size / Math.max(sideDepth, 1), 0, 8);
  const impactBps = clamp(
    6 + spreadBps * 0.12 + depthRatio ** 1.2 * 180,
    0,
    320,
  );
  const impactPrice = (midPrice * impactBps) / 10_000;

  const executionPrice =
    side === "buy"
      ? askPrice + impactPrice
      : Math.max(0.0001, bidPrice - impactPrice);

  const midShiftBps = clamp(impactBps * 0.35, 0, 140);
  const nextMidPrice =
    side === "buy"
      ? midPrice * (1 + midShiftBps / 10_000)
      : midPrice * (1 - midShiftBps / 10_000);

  return {
    midPrice,
    bidPrice,
    askPrice,
    spreadBps,
    bidDepth,
    askDepth,
    impactBps,
    executionPrice,
    nextMidPrice,
  };
}
