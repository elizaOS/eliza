/**
 * Read-only Solana token safety report for the crypto terminal:
 * `GET /api/wallet/terminal/token-safety?mint=<base58 mint>` serves the
 * GoPlus Security report built by `analytics/goplus/solana-token-security.ts`.
 *
 * Reports are cached briefly per mint and concurrent misses share one request;
 * when a refresh fails the last good report is served marked `stale`, and with
 * nothing cached the route answers 502. No route here touches wallets, keys,
 * or order execution.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  defaultGoPlusFetch,
  fetchGoPlusSolanaTokenSecurity,
  type GoPlusFetch,
  GoPlusNotFoundError,
  SOLANA_MINT_PATTERN,
} from "../analytics/goplus/solana-token-security.js";
import type { WalletTerminalTokenSafetyResponse } from "../contracts.js";

export const TERMINAL_TOKEN_SAFETY_PATH = "/api/wallet/terminal/token-safety";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_LIMIT = 20;

interface CacheEntry {
  response: WalletTerminalTokenSafetyResponse;
  expiresAt: number;
}

let safetyFetch: GoPlusFetch = defaultGoPlusFetch;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WalletTerminalTokenSafetyResponse>>();
const refreshBuckets = new Map<string, { count: number; resetAt: number }>();

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Token safety provider failed";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function loadReport(mint: string): Promise<WalletTerminalTokenSafetyResponse> {
  let pending = inFlight.get(mint);
  if (!pending) {
    pending = fetchGoPlusSolanaTokenSecurity(mint, safetyFetch)
      .then((response) => {
        cache.delete(mint);
        cache.set(mint, { response, expiresAt: Date.now() + CACHE_TTL_MS });
        while (cache.size > CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return response;
      })
      .finally(() => {
        inFlight.delete(mint);
      });
    inFlight.set(mint, pending);
  }
  return pending;
}

function resolveClientAddress(req: http.IncomingMessage): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const candidate = first?.split(",")[0]?.trim();
  return candidate || req.socket.remoteAddress || "unknown";
}

function consumeRefreshSlot(clientAddress: string): number | null {
  const now = Date.now();
  for (const [key, bucket] of refreshBuckets) {
    if (bucket.resetAt <= now) refreshBuckets.delete(key);
  }
  const bucket = refreshBuckets.get(clientAddress);
  if (!bucket) {
    refreshBuckets.set(clientAddress, {
      count: 1,
      resetAt: now + REFRESH_WINDOW_MS,
    });
    return null;
  }
  if (bucket.count >= REFRESH_LIMIT) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  bucket.count += 1;
  return null;
}

function markStale(
  response: WalletTerminalTokenSafetyResponse,
  error: string,
): WalletTerminalTokenSafetyResponse {
  return {
    ...response,
    stale: true,
    source: { ...response.source, stale: true, error },
  };
}

/** Serve the token safety route; returns false when the path is not ours. */
export async function handleWalletTerminalTokenSafetyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== TERMINAL_TOKEN_SAFETY_PATH) return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const mint = (url.searchParams.get("mint") ?? "").trim();
  if (!SOLANA_MINT_PATTERN.test(mint)) {
    sendJson(res, 400, { error: "mint must be a base58 Solana mint address" });
    return true;
  }
  res.setHeader("Cache-Control", "public, max-age=60");

  const cached = cache.get(mint);
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(res, 200, cached.response);
    return true;
  }
  if (!inFlight.has(mint)) {
    const retryAfter = consumeRefreshSlot(resolveClientAddress(req));
    if (retryAfter !== null) {
      if (cached) {
        sendJson(res, 200, markStale(cached.response, "Refresh rate limited"));
        return true;
      }
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Too many token safety checks" });
      return true;
    }
  }
  try {
    sendJson(res, 200, await loadReport(mint));
  } catch (error) {
    // error-policy:J1 transport boundary: stale cache or a structured 404/502.
    const message = errorMessage(error);
    if (error instanceof GoPlusNotFoundError) {
      sendJson(res, 404, { error: message });
      return true;
    }
    if (cached) {
      logger.warn(
        `[WalletTerminalTokenSafetyRoute] refresh failed; serving stale report (${message})`,
      );
      sendJson(res, 200, markStale(cached.response, message));
      return true;
    }
    logger.error(
      `[WalletTerminalTokenSafetyRoute] token safety unavailable (${message})`,
    );
    sendJson(res, 502, { error: "Token safety report is unavailable" });
  }
  return true;
}

export function __resetWalletTerminalTokenSafetyRouteForTests(): void {
  safetyFetch = defaultGoPlusFetch;
  cache.clear();
  inFlight.clear();
  refreshBuckets.clear();
}

export function __setWalletTerminalTokenSafetyFetchForTests(
  fetcher: GoPlusFetch,
): void {
  safetyFetch = fetcher;
}

export function __expireWalletTerminalTokenSafetyCacheForTests(): void {
  for (const entry of cache.values()) entry.expiresAt = 0;
}
