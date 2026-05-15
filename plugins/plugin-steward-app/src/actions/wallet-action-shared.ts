/**
 * Shared constants and helpers for wallet action handlers
 * (execute-trade, transfer-token, check-balance).
 *
 * @module actions/wallet-action-shared
 */

import { resolveApiToken, resolveDesktopApiPort } from "@elizaos/core";

/** Resolve the loopback API port for wallet action calls at runtime. */
export function getWalletActionApiPort(): string {
  return String(resolveDesktopApiPort(process.env));
}

/**
 * Build Authorization headers for loopback API calls.
 * Reads the resolved API token from the environment and formats it as a Bearer token.
 * Returns an empty object when no token is configured.
 */
export function buildAuthHeaders(): Record<string, string> {
  const token = resolveApiToken(process.env);
  if (!token) return {};
  return {
    Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`,
  };
}
