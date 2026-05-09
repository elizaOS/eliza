/**
 * Wallet / trade compat helpers — trade permission modes, local execution
 * guards, and wallet export rejection wrappers.
 *
 * Canonical home: `@elizaos/plugin-wallet/lib/server-wallet-trade`. The
 * legacy path `@elizaos/app-core/api/server-wallet-trade` is a re-export
 * shim and will be removed once external consumers migrate.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { syncAppEnvToEliza, syncElizaEnvAliases } from "@elizaos/core";

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
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): CompatWalletExportRejection | null {
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(hardenedGuard(req, body)),
  );
}
