/**
 * Rebalancing strategy.
 *
 * Maintains a target allocation between native tokens and the agent's own
 * ERC-20 token.  When actual allocation drifts beyond `rebalanceThreshold`
 * percentage points from the target, the strategy recommends a buy or sell
 * to restore balance.
 *
 * Config params (all optional, with defaults):
 *   targetNativePercent   — % of treasury to keep in native token  (default 30)
 *   targetTokenPercent    — % of treasury to keep in own token      (default 70)
 *   rebalanceThreshold    — drift % before we act                   (default 10)
 *   maxSingleTradePercent — max % of treasury in one trade          (default 20)
 *   minNativeReserve      — wei kept back for gas                   (default 0.01 ETH)
 */

import type { AgentState, Strategy, TradeDecision } from "./types.js";

export interface RebalanceParams {
  targetNativePercent?: number;
  targetTokenPercent?: number;
  rebalanceThreshold?: number;
  maxSingleTradePercent?: number;
  minNativeReserve?: string; // wei
}

const HOLD: TradeDecision = {
  action: "hold",
  amount: "0",
  reason: "Within rebalance threshold — no action needed",
  confidence: 1,
};

export class RebalanceStrategy implements Strategy {
  readonly name = "rebalance";

  private readonly targetNative: number;
  private readonly targetToken: number;
  private readonly threshold: number;
  private readonly maxTradePct: number;
  private readonly minNativeReserve: bigint;

  constructor(params: RebalanceParams = {}) {
    this.targetNative = params.targetNativePercent ?? 30;
    this.targetToken = params.targetTokenPercent ?? 70;
    this.threshold = params.rebalanceThreshold ?? 10;
    this.maxTradePct = params.maxSingleTradePercent ?? 20;
    this.minNativeReserve = BigInt(params.minNativeReserve ?? "10000000000000000"); // 0.01 ETH

    const total = this.targetNative + this.targetToken;
    if (Math.abs(total - 100) > 1) {
      throw new Error(
        `RebalanceStrategy: targetNativePercent + targetTokenPercent must sum to ~100 (got ${total})`,
      );
    }
  }

  async evaluate(state: AgentState): Promise<TradeDecision> {
    const { nativeBalance, tokenBalance, tokenPrice, treasuryValue } = state;

    // Can't rebalance without price data or empty treasury
    if (treasuryValue === 0n || tokenPrice === 0n) {
      return {
        action: "hold",
        amount: "0",
        reason: "Treasury value or token price is zero — cannot rebalance",
        confidence: 0.9,
      };
    }

    // Current allocation percentages
    const tokenValueInNative = (tokenBalance * tokenPrice) / BigInt(1e18);
    const actualNativePct = Number((nativeBalance * 10000n) / treasuryValue) / 100;
    const actualTokenPct = Number((tokenValueInNative * 10000n) / treasuryValue) / 100;

    const nativeDrift = actualNativePct - this.targetNative;
    const tokenDrift = actualTokenPct - this.targetToken;

    if (Math.abs(nativeDrift) < this.threshold && Math.abs(tokenDrift) < this.threshold) {
      return HOLD;
    }

    // We need more token → buy
    if (tokenDrift < -this.threshold) {
      const targetTokenValue = (treasuryValue * BigInt(Math.round(this.targetToken))) / 100n;
      const currentTokenValue = tokenValueInNative;
      const deficit = targetTokenValue - currentTokenValue;

      // Cap trade size
      const maxTrade = (treasuryValue * BigInt(this.maxTradePct)) / 100n;
      const buyAmount = deficit > maxTrade ? maxTrade : deficit;

      // Don't drain native reserves below gas threshold
      const spendable =
        nativeBalance > this.minNativeReserve ? nativeBalance - this.minNativeReserve : 0n;

      if (spendable === 0n || buyAmount === 0n) {
        return {
          action: "hold",
          amount: "0",
          reason: `Need to buy token but native reserve too low (min reserve: ${this.minNativeReserve.toString()} wei)`,
          confidence: 0.8,
        };
      }

      const safeAmount = buyAmount < spendable ? buyAmount : spendable;

      return {
        action: "buy",
        amount: safeAmount.toString(),
        reason: `Token allocation ${actualTokenPct.toFixed(1)}% below target ${this.targetToken}% — buying to rebalance`,
        confidence: 0.85,
      };
    }

    // We have too much token → sell
    if (tokenDrift > this.threshold) {
      const targetTokenValue = (treasuryValue * BigInt(Math.round(this.targetToken))) / 100n;
      const surplus = tokenValueInNative - targetTokenValue;

      // Cap trade size
      const maxTrade = (treasuryValue * BigInt(this.maxTradePct)) / 100n;
      const sellValueInNative = surplus > maxTrade ? maxTrade : surplus;

      // Convert native value → token amount
      const sellAmount = (sellValueInNative * BigInt(1e18)) / tokenPrice;

      if (sellAmount === 0n) {
        return HOLD;
      }

      return {
        action: "sell",
        amount: sellAmount.toString(),
        reason: `Token allocation ${actualTokenPct.toFixed(1)}% above target ${this.targetToken}% — selling to rebalance`,
        confidence: 0.85,
      };
    }

    return HOLD;
  }
}

export function createRebalanceStrategy(params: Record<string, unknown>): RebalanceStrategy {
  return new RebalanceStrategy({
    targetNativePercent: params.targetNativePercent as number | undefined,
    targetTokenPercent: params.targetTokenPercent as number | undefined,
    rebalanceThreshold: params.rebalanceThreshold as number | undefined,
    maxSingleTradePercent: params.maxSingleTradePercent as number | undefined,
    minNativeReserve: params.minNativeReserve as string | undefined,
  });
}
