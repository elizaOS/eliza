/**
 * Wallet / trade compat helpers — trade permission modes, local execution
 * guards, and wallet export rejection wrappers.
 *
 * Exported from the `@elizaos/plugin-wallet` barrel for package consumers.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { syncAppEnvToEliza, syncElizaEnvAliases } from "@elizaos/core";
import type { TradePermissionMode } from "@elizaos/shared";

import type { WalletExportRequestBody } from "../contracts.js";
import {
  type WalletExportRejection as CompatWalletExportRejection,
  createHardenedExportGuard,
} from "./wallet-export-guard";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeCompatReason(reason: string): string {
  return reason;
}

function mirrorCompatHeaders(req: Pick<http.IncomingMessage, "headers">): void {
  const HEADER_ALIASES = [
    ["x-elizaos-token", "x-eliza-token"],
    ["x-elizaos-export-token", "x-eliza-export-token"],
    ["x-elizaos-client-id", "x-eliza-client-id"],
    ["x-elizaos-terminal-token", "x-eliza-terminal-token"],
    ["x-elizaos-ui-language", "x-eliza-ui-language"],
    ["x-elizaos-agent-action", "x-eliza-agent-action"],
  ] as const;

  for (const [appHeader, elizaHeader] of HEADER_ALIASES) {
    const appValue = req.headers[appHeader];
    const elizaValue = req.headers[elizaHeader];

    if (appValue != null && elizaValue == null) {
      req.headers[elizaHeader] = appValue;
    }

    if (elizaValue != null && appValue == null) {
      req.headers[appHeader] = elizaValue;
    }
  }
}

export function normalizeCompatRejection<
  T extends { status: number; reason: string } | null,
>(rejection: T): T {
  if (!rejection) {
    return rejection;
  }

  return {
    ...rejection,
    reason: normalizeCompatReason(rejection.reason),
  } as T;
}

export function runWithCompatAuthContext<T>(
  req: Pick<http.IncomingMessage, "headers">,
  operation: () => T,
): T {
  syncElizaEnvAliases();
  syncAppEnvToEliza();
  mirrorCompatHeaders(req);

  try {
    return operation();
  } finally {
    syncAppEnvToEliza();
    syncElizaEnvAliases();
  }
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function resolveBaseWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): CompatWalletExportRejection | null {
  if (!body.confirm) {
    return {
      status: 403,
      reason:
        'Export requires explicit confirmation. Send { "confirm": true } in the request body.',
    };
  }

  const expected = process.env.ELIZA_WALLET_EXPORT_TOKEN?.trim();
  if (!expected) {
    return {
      status: 403,
      reason:
        "Wallet export is disabled. Set ELIZA_WALLET_EXPORT_TOKEN to enable secure exports.",
    };
  }

  const headerToken =
    typeof req.headers["x-eliza-export-token"] === "string"
      ? req.headers["x-eliza-export-token"].trim()
      : "";
  const bodyToken =
    typeof body.exportToken === "string" ? body.exportToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing export token. Provide X-Eliza-Export-Token header or exportToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return { status: 401, reason: "Invalid export token." };
  }

  return null;
}

function resolveCompatWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): CompatWalletExportRejection | null {
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(resolveBaseWalletExportRejection(req, body)),
  );
}

// Create the hardened guard with the compat rejection resolver
const hardenedGuard = createHardenedExportGuard(
  resolveCompatWalletExportRejection,
);

// ---------------------------------------------------------------------------
// Exported types and functions
// ---------------------------------------------------------------------------

export type { TradePermissionMode };

export function resolveTradePermissionMode(config: {
  features?: { tradePermissionMode?: unknown } | null;
}): TradePermissionMode {
  const raw = config.features?.tradePermissionMode;
  if (
    raw === "user-sign-only" ||
    raw === "manual-local-key" ||
    raw === "agent-auto"
  ) {
    return raw;
  }
  return "user-sign-only";
}

// ---------------------------------------------------------------------------
// Autonomous (agent-auto) daily trade quota.
//
// Canonical semantics live in the host at
// `packages/agent/src/api/trade-safety.ts`; this copy is kept in exact parity
// (same 25/day cap, same UTC-calendar-day counting window, same consume/peek
// behavior) so the `@elizaos/agent`-free plugin barrel enforces the identical
// spend guard for its own consumers.
// ---------------------------------------------------------------------------

/** Maximum number of autonomous agent trades allowed per calendar day. */
export const AGENT_AUTO_MAX_DAILY_TRADES = 25;

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

type LocalTradeExecutionOptions = {
  consumeAgentQuota?: boolean;
};

/**
 * Returns true if local-key execution is permitted for the given actor.
 *
 * In `agent-auto` mode an autonomous agent is additionally capped at
 * `AGENT_AUTO_MAX_DAILY_TRADES` trades per calendar day. By default a permitted
 * agent-auto trade consumes one unit of daily quota; pass
 * `{ consumeAgentQuota: false }` to peek at remaining headroom without spending
 * it.
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
 * Hardened wallet export rejection function.
 *
 * Wraps the upstream token validation with per-IP rate limiting (1 per 10 min),
 * audit logging (IP + UA), and a 10s confirmation delay via single-use nonces.
 */
export function resolveWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): CompatWalletExportRejection | null {
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(hardenedGuard(req, body)),
  );
}
