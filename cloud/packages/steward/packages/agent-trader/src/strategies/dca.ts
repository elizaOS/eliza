/**
 * Dollar-cost averaging (DCA) strategy.
 *
 * Buys a fixed amount of the agent's own token on every loop tick —
 * regardless of price — to build a position gradually over time.
 *
 * Config params:
 *   buyAmountWei       — how much native to spend each tick (required)
 *   minIntervalSeconds — minimum time between buys (default: same as loop interval)
 *   minNativeReserve   — wei to always keep back for gas (default: 0.01 ETH)
 *
 * The strategy emits "hold" when:
 *  - Not enough time has elapsed since the last trade
 *  - Native balance minus gas reserve is below the buy amount
 */

import type { AgentState, Strategy, TradeDecision } from "./types.js";

export interface DCAParams {
  /** Native-wei to spend per buy tick */
  buyAmountWei: string;
  /** Minimum seconds between DCA buys (0 = every tick) */
  minIntervalSeconds?: number;
  /** Minimum native balance to keep in reserve for gas */
  minNativeReserve?: string;
}

export class DCAStrategy implements Strategy {
  readonly name = "dca";

  private readonly buyAmount: bigint;
  private readonly minInterval: number;
  private readonly minNativeReserve: bigint;

  constructor(params: DCAParams) {
    if (!params.buyAmountWei) {
      throw new Error("DCAStrategy: buyAmountWei is required");
    }
    this.buyAmount = BigInt(params.buyAmountWei);
    this.minInterval = params.minIntervalSeconds ?? 0;
    this.minNativeReserve = BigInt(params.minNativeReserve ?? "10000000000000000"); // 0.01 ETH
  }

  async evaluate(state: AgentState): Promise<TradeDecision> {
    const { nativeBalance, lastTradeAge } = state;

    // Enforce minimum time between buys
    if (this.minInterval > 0 && lastTradeAge < this.minInterval) {
      return {
        action: "hold",
        amount: "0",
        reason: `DCA interval not elapsed — last trade was ${lastTradeAge}s ago (min ${this.minInterval}s)`,
        confidence: 1,
      };
    }

    // Ensure we have enough to buy + keep gas reserve
    const spendable =
      nativeBalance > this.minNativeReserve ? nativeBalance - this.minNativeReserve : 0n;

    if (spendable < this.buyAmount) {
      return {
        action: "hold",
        amount: "0",
        reason: `Insufficient balance for DCA buy — spendable ${spendable.toString()} wei < buy amount ${this.buyAmount.toString()} wei`,
        confidence: 0.95,
      };
    }

    return {
      action: "buy",
      amount: this.buyAmount.toString(),
      reason: `DCA buy — spending ${this.buyAmount.toString()} wei (last trade: ${lastTradeAge}s ago)`,
      confidence: 0.9,
    };
  }
}

export function createDCAStrategy(params: Record<string, unknown>): DCAStrategy {
  if (!params.buyAmountWei) {
    throw new Error("DCA strategy requires buyAmountWei in params");
  }
  return new DCAStrategy({
    buyAmountWei: params.buyAmountWei as string,
    minIntervalSeconds: params.minIntervalSeconds as number | undefined,
    minNativeReserve: params.minNativeReserve as string | undefined,
  });
}
