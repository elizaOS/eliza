/**
 * Price-threshold strategy.
 *
 * Reacts to price levels:
 *  - Price drops below `buyBelowPrice`  → "buy the dip"
 *  - Price rises above `sellAbovePrice` → "take profit"
 *
 * Config params:
 *   buyBelowPrice     — token price (native-wei/token) below which to buy
 *   buyAmountWei      — how much native to spend when buying
 *   sellAbovePrice    — token price above which to sell
 *   sellAmountTokens  — how many token-units to sell
 *   minNativeReserve  — gas reserve in native-wei (default 0.01 ETH)
 *
 * At least one of (buyBelowPrice, sellAbovePrice) must be provided.
 */

import type { AgentState, Strategy, TradeDecision } from "./types.js";

export interface ThresholdParams {
  /** Token price threshold (native-wei per token) below which we buy */
  buyBelowPrice?: string;
  /** Native-wei to spend on each buy trigger */
  buyAmountWei?: string;
  /** Token price threshold above which we sell */
  sellAbovePrice?: string;
  /** Token units to sell on each sell trigger */
  sellAmountTokens?: string;
  /** Minimum native balance reserved for gas */
  minNativeReserve?: string;
}

const HOLD: TradeDecision = {
  action: "hold",
  amount: "0",
  reason: "Price within configured thresholds — no action",
  confidence: 1,
};

export class ThresholdStrategy implements Strategy {
  readonly name = "threshold";

  private readonly buyBelowPrice: bigint | null;
  private readonly buyAmount: bigint | null;
  private readonly sellAbovePrice: bigint | null;
  private readonly sellAmount: bigint | null;
  private readonly minNativeReserve: bigint;

  constructor(params: ThresholdParams) {
    this.buyBelowPrice = params.buyBelowPrice ? BigInt(params.buyBelowPrice) : null;
    this.buyAmount = params.buyAmountWei ? BigInt(params.buyAmountWei) : null;
    this.sellAbovePrice = params.sellAbovePrice ? BigInt(params.sellAbovePrice) : null;
    this.sellAmount = params.sellAmountTokens ? BigInt(params.sellAmountTokens) : null;
    this.minNativeReserve = BigInt(params.minNativeReserve ?? "10000000000000000"); // 0.01 ETH

    if (!this.buyBelowPrice && !this.sellAbovePrice) {
      throw new Error(
        "ThresholdStrategy: at least one of buyBelowPrice or sellAbovePrice must be configured",
      );
    }
  }

  async evaluate(state: AgentState): Promise<TradeDecision> {
    const { tokenPrice, nativeBalance, tokenBalance } = state;

    if (tokenPrice === 0n) {
      return {
        action: "hold",
        amount: "0",
        reason: "Token price is zero — cannot evaluate thresholds",
        confidence: 0,
      };
    }

    // ── Sell trigger (check first — profit-taking has priority over dip-buying) ──
    if (this.sellAbovePrice !== null && tokenPrice > this.sellAbovePrice) {
      if (this.sellAmount === null) {
        return {
          action: "hold",
          amount: "0",
          reason: `Sell threshold triggered (price ${tokenPrice} > ${this.sellAbovePrice}) but no sellAmountTokens configured`,
          confidence: 0.5,
        };
      }

      if (tokenBalance === 0n) {
        return {
          action: "hold",
          amount: "0",
          reason: "Sell threshold triggered but token balance is zero",
          confidence: 0.8,
        };
      }

      const safeAmount = this.sellAmount < tokenBalance ? this.sellAmount : tokenBalance;

      return {
        action: "sell",
        amount: safeAmount.toString(),
        reason: `Take profit — price ${tokenPrice.toString()} wei exceeds sell threshold ${this.sellAbovePrice.toString()} wei`,
        confidence: 0.9,
      };
    }

    // ── Buy trigger (buy the dip) ──────────────────────────────────────────────
    if (this.buyBelowPrice !== null && tokenPrice < this.buyBelowPrice) {
      if (this.buyAmount === null) {
        return {
          action: "hold",
          amount: "0",
          reason: `Buy threshold triggered (price ${tokenPrice} < ${this.buyBelowPrice}) but no buyAmountWei configured`,
          confidence: 0.5,
        };
      }

      const spendable =
        nativeBalance > this.minNativeReserve ? nativeBalance - this.minNativeReserve : 0n;

      if (spendable < this.buyAmount) {
        return {
          action: "hold",
          amount: "0",
          reason: `Buy threshold triggered but insufficient balance — spendable ${spendable.toString()} < ${this.buyAmount.toString()}`,
          confidence: 0.8,
        };
      }

      return {
        action: "buy",
        amount: this.buyAmount.toString(),
        reason: `Buy the dip — price ${tokenPrice.toString()} wei below buy threshold ${this.buyBelowPrice.toString()} wei`,
        confidence: 0.88,
      };
    }

    return HOLD;
  }
}

export function createThresholdStrategy(params: Record<string, unknown>): ThresholdStrategy {
  return new ThresholdStrategy({
    buyBelowPrice: params.buyBelowPrice as string | undefined,
    buyAmountWei: params.buyAmountWei as string | undefined,
    sellAbovePrice: params.sellAbovePrice as string | undefined,
    sellAmountTokens: params.sellAmountTokens as string | undefined,
    minNativeReserve: params.minNativeReserve as string | undefined,
  });
}
