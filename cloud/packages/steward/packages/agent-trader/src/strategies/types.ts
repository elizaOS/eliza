/**
 * Core strategy interface and shared types.
 *
 * A Strategy receives an AgentState snapshot and returns a TradeDecision.
 * It has no side effects — transaction submission is handled by the loop.
 */

// ─── Agent State ─────────────────────────────────────────────────────────────

export interface AgentState {
  /** Native token balance (ETH / BNB / etc.) in wei */
  nativeBalance: bigint;
  /** Agent's own ERC-20 token balance in token-wei */
  tokenBalance: bigint;
  /**
   * Current token price expressed as native-wei per single token-unit.
   * e.g. if 1 TOKEN = 0.001 ETH, tokenPrice = 1_000_000_000_000_000n (1e15)
   */
  tokenPrice: bigint;
  /** Seconds elapsed since the last trade (0 if never traded) */
  lastTradeAge: number;
  /** Aggregate trade value (wei) in the last 24 hours */
  dailyVolume: bigint;
  /** Total treasury value in native-wei (nativeBalance + tokenBalance × tokenPrice) */
  treasuryValue: bigint;
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface TradeDecision {
  /** What to do */
  action: "buy" | "sell" | "hold";
  /**
   * Size of the trade in wei.
   * For "buy":  how much native to spend.
   * For "sell": how many token-units to swap.
   * For "hold": "0"
   */
  amount: string;
  /** Human-readable justification (ends up in the decision log) */
  reason: string;
  /** Confidence score 0–1; lower scores can be used to skip risky trades */
  confidence: number;
}

// ─── Strategy interface ──────────────────────────────────────────────────────

export interface Strategy {
  /** Display name used in logs */
  readonly name: string;
  /**
   * Evaluate the current state and return a trading decision.
   * Must not throw — return a "hold" decision on errors.
   */
  evaluate(state: AgentState): Promise<TradeDecision>;
}
