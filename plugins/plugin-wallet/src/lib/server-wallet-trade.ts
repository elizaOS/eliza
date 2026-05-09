/**
 * Wallet / trade compat helpers — trade permission modes, local execution
 * guards, and wallet export rejection wrappers.
 *
 * Canonical home: `@elizaos/plugin-wallet/lib/server-wallet-trade`. The
 * legacy path `@elizaos/app-core/api/server-wallet-trade` is a re-export
 * shim and will be removed once external consumers migrate.
 */
import type http from "node:http";
import { resolveWalletExportRejection as upstreamResolveWalletExportRejection } from "@elizaos/agent";
import { syncAppEnvToEliza, syncElizaEnvAliases } from "@elizaos/shared";

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

function resolveCompatWalletExportRejection(
  ...args: Parameters<typeof upstreamResolveWalletExportRejection>
): CompatWalletExportRejection | null {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(upstreamResolveWalletExportRejection(...args)),
  );
}

// Create the hardened guard with the compat rejection resolver
const hardenedGuard = createHardenedExportGuard(
  resolveCompatWalletExportRejection,
);

// ---------------------------------------------------------------------------
// Exported types and functions
// ---------------------------------------------------------------------------

export type TradePermissionMode =
  | "user-sign-only"
  | "manual-local-key"
  | "agent-auto";

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

export function canUseLocalTradeExecution(
  mode: TradePermissionMode,
  isAgent: boolean,
): boolean {
  if (mode === "agent-auto") {
    return true;
  }
  if (mode === "manual-local-key") {
    return !isAgent;
  }
  return false;
}

/**
 * Hardened wallet export rejection function.
 *
 * Wraps the upstream token validation with per-IP rate limiting (1 per 10 min),
 * audit logging (IP + UA), and a 10s confirmation delay via single-use nonces.
 */
export function resolveWalletExportRejection(
  ...args: Parameters<typeof upstreamResolveWalletExportRejection>
): CompatWalletExportRejection | null {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(hardenedGuard(...args)),
  );
}
