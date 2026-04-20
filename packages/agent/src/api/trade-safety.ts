/**
 * Pure trade safety utilities — no heavy dependencies.
 * Extracted so they can be unit-tested without pulling in the full server.
 */

/** Maximum number of autonomous agent trades allowed per calendar day. */
export const AGENT_AUTO_MAX_DAILY_TRADES = 25;

/** Maximum age of a trade quote before it is considered stale. */
export const QUOTE_MAX_AGE_MS = 60_000; // 60 seconds

/** Tracks autonomous trade count for rate-limiting in agent-auto mode. */
export const agentAutoDailyTrades = { count: 0, resetDate: "" };

export function getAgentAutoTradeDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record an autonomous agent trade. Returns true if allowed, false if
 * the daily limit has been reached. Resets the counter on a new calendar day.
 */
export function recordAgentAutoTrade(log?: (msg: string) => void): boolean {
  const today = getAgentAutoTradeDate();
  if (agentAutoDailyTrades.resetDate !== today) {
    agentAutoDailyTrades.count = 0;
    agentAutoDailyTrades.resetDate = today;
  }
  if (agentAutoDailyTrades.count >= AGENT_AUTO_MAX_DAILY_TRADES) {
    log?.(
      `[trade] Agent-auto daily trade limit reached (${AGENT_AUTO_MAX_DAILY_TRADES}). Rejecting autonomous trade.`,
    );
    return false;
  }
  agentAutoDailyTrades.count += 1;
  log?.(
    `[trade] Agent-auto autonomous trade ${agentAutoDailyTrades.count}/${AGENT_AUTO_MAX_DAILY_TRADES} for ${today}`,
  );
  return true;
}

export type TradePermissionMode =
  | "user-sign-only"
  | "agent-auto"
  | "manual-local-key"
  | "disabled";

type LocalTradeExecutionOptions = {
  consumeAgentQuota?: boolean;
};

/**
 * Returns true if local-key execution is permitted for the given actor.
 */
export function canUseLocalTradeExecution(
  mode: TradePermissionMode,
  isAgent: boolean,
  log?: (msg: string) => void,
  options: LocalTradeExecutionOptions = {},
): boolean {
  if (mode === "agent-auto") {
    if (isAgent) {
      if (options.consumeAgentQuota === false) {
        const today = getAgentAutoTradeDate();
        if (agentAutoDailyTrades.resetDate !== today) {
          return true;
        }
        return agentAutoDailyTrades.count < AGENT_AUTO_MAX_DAILY_TRADES;
      }
      return recordAgentAutoTrade(log);
    }
    return true;
  }
  if (mode === "manual-local-key") return !isAgent;
  return false;
}

/**
 * Assert that a trade quote is still fresh. Throws if the quote is older
 * than QUOTE_MAX_AGE_MS. Silently passes if `quotedAt` is undefined
 * (backwards compatibility with quotes that lack the field).
 */
export function assertQuoteFresh(
  quotedAt: number | undefined,
  now: number = Date.now(),
): void {
  if (quotedAt && now - quotedAt > QUOTE_MAX_AGE_MS) {
    throw new Error("Quote expired — please request a fresh quote");
  }
}
