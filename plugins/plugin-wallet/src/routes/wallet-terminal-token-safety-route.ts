/**
 * Read-only Solana token safety report for the crypto terminal:
 * `GET /api/wallet/terminal/token-safety?mint=<base58 mint>` asks the public
 * GoPlus Security token API about one mint and turns its answer into typed
 * checks and an avoid / caution / no-major-flags verdict.
 *
 * The report is a third-party signal, not proof of safety: a field GoPlus did
 * not report becomes an `unknown` check that holds the verdict at caution
 * rather than a silent pass. Reports are cached briefly per mint and
 * concurrent misses share one request; when a refresh fails the last good
 * report is served marked `stale`, and with nothing cached the route answers
 * 502. No route here touches wallets, keys, or order execution.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import type {
  WalletTerminalTokenSafetyResponse,
  WalletTokenSafetyCheck,
  WalletTokenSafetySeverity,
  WalletTokenSafetySource,
  WalletTokenSafetyVerdict,
} from "../contracts.js";

export const TERMINAL_TOKEN_SAFETY_PATH = "/api/wallet/terminal/token-safety";

const GOPLUS_SOLANA_URL =
  "https://api.gopluslabs.io/api/v1/solana/token_security";
const GOPLUS_PROVIDER = {
  providerId: "goplus",
  providerName: "GoPlus Security",
  providerUrl: "https://gopluslabs.io",
} as const;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_LIMIT = 20;
const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CONCENTRATION_WARN_PCT = 30;
const LOW_LIQUIDITY_USD = 10_000;

type TokenSafetyFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

interface CacheEntry {
  response: WalletTerminalTokenSafetyResponse;
  expiresAt: number;
}

class UpstreamNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamNotFoundError";
  }
}

const defaultFetch: TokenSafetyFetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

let safetyFetch: TokenSafetyFetch = defaultFetch;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WalletTerminalTokenSafetyResponse>>();
const refreshBuckets = new Map<string, { count: number; resetAt: number }>();

function source(
  available: boolean,
  stale: boolean,
  error: string | null,
): WalletTokenSafetySource {
  return { ...GOPLUS_PROVIDER, available, stale, error };
}

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

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GoPlus encodes flags as "0"/"1" strings, sometimes as numbers. */
function flag(value: unknown): boolean | null {
  if (value === "1" || value === 1) return true;
  if (value === "0" || value === 0) return false;
  return null;
}

/** Status of an `{ status, authority }` authority object, or null if absent. */
function authorityStatus(value: unknown): boolean | null {
  return isObject(value) ? flag(value.status) : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function check(
  id: string,
  label: string,
  severity: WalletTokenSafetySeverity,
  detail: string,
): WalletTokenSafetyCheck {
  return { id, label, severity, detail };
}

function authorityCheck(
  id: string,
  label: string,
  status: boolean | null,
  activeSeverity: WalletTokenSafetySeverity,
  active: string,
  absent: string,
): WalletTokenSafetyCheck {
  if (status === null) {
    return check(id, label, "unknown", "GoPlus did not report this field.");
  }
  return status
    ? check(id, label, activeSeverity, active)
    : check(id, label, "ok", absent);
}

function sumTopHolderPct(holders: unknown): number | null {
  if (!Array.isArray(holders) || holders.length === 0) return null;
  let total = 0;
  for (const holder of holders.slice(0, 10)) {
    const fraction = isObject(holder) ? finiteNumber(holder.percent) : null;
    if (fraction === null || fraction < 0) return null;
    total += fraction;
  }
  return Math.min(100, total * 100);
}

function sumLiquidityUsd(dex: unknown): number | null {
  if (!Array.isArray(dex)) return null;
  let total = 0;
  for (const pool of dex) {
    const tvl = isObject(pool) ? finiteNumber(pool.tvl) : null;
    if (tvl !== null && tvl > 0) total += tvl;
  }
  return total;
}

function verdictFor(
  checks: WalletTokenSafetyCheck[],
): WalletTokenSafetyVerdict {
  if (checks.some((entry) => entry.severity === "danger")) return "avoid";
  if (
    checks.some(
      (entry) => entry.severity === "warn" || entry.severity === "unknown",
    )
  ) {
    return "caution";
  }
  return "no-major-flags";
}

/**
 * Turn one GoPlus Solana `token_security` payload into the terminal report.
 * Throws on a malformed envelope or an upstream error code, and throws
 * {@link UpstreamNotFoundError} when GoPlus has no report for the mint.
 */
export function parseGoPlusSolanaTokenSecurity(
  mint: string,
  payload: unknown,
  now: Date = new Date(),
): WalletTerminalTokenSafetyResponse {
  if (!isObject(payload)) {
    throw new Error("GoPlus response was not an object");
  }
  if (payload.code !== 1) {
    const message = optionalText(payload.message) ?? "unknown error";
    throw new Error(
      `GoPlus responded with code ${String(payload.code)}: ${message}`,
    );
  }
  const result = payload.result;
  if (!isObject(result)) {
    throw new Error("GoPlus response had no result object");
  }
  const report = result[mint];
  if (!isObject(report)) {
    throw new UpstreamNotFoundError("GoPlus has no report for this mint");
  }

  const metadata = isObject(report.metadata) ? report.metadata : null;
  const top10HolderPct = sumTopHolderPct(report.holders);
  const liquidityUsd = sumLiquidityUsd(report.dex);
  const holderCount = finiteNumber(report.holder_count);
  const transferHook = report.transfer_hook;
  const transferFee = report.transfer_fee;
  const defaultState = optionalText(
    typeof report.default_account_state === "number"
      ? String(report.default_account_state)
      : report.default_account_state,
  );

  const checks: WalletTokenSafetyCheck[] = [
    authorityCheck(
      "mint-authority",
      "Mint authority",
      authorityStatus(report.mintable),
      "danger",
      "Someone can still mint new supply and dilute holders.",
      "Supply is fixed; no one can mint more.",
    ),
    authorityCheck(
      "freeze-authority",
      "Freeze authority",
      authorityStatus(report.freezable),
      "danger",
      "Someone can freeze holder token accounts, blocking sells.",
      "No one can freeze holder accounts.",
    ),
    authorityCheck(
      "balance-mutable",
      "Balance control",
      authorityStatus(report.balance_mutable_authority),
      "danger",
      "An authority can move or burn tokens from any holder (permanent delegate).",
      "No authority can move holder balances.",
    ),
    (() => {
      const status = flag(report.non_transferable);
      return status === null
        ? check(
            "non-transferable",
            "Transferability",
            "unknown",
            "GoPlus did not report this field.",
          )
        : status
          ? check(
              "non-transferable",
              "Transferability",
              "danger",
              "Tokens cannot be transferred, so they cannot be sold.",
            )
          : check(
              "non-transferable",
              "Transferability",
              "ok",
              "Tokens can be transferred.",
            );
    })(),
    defaultState === null
      ? check(
          "default-frozen",
          "Default account state",
          "unknown",
          "GoPlus did not report this field.",
        )
      : defaultState === "2"
        ? check(
            "default-frozen",
            "Default account state",
            "danger",
            "New token accounts start frozen until the issuer thaws them.",
          )
        : check(
            "default-frozen",
            "Default account state",
            "ok",
            "New token accounts start usable.",
          ),
    !Array.isArray(transferHook)
      ? check(
          "transfer-hook",
          "Transfer hook",
          "unknown",
          "GoPlus did not report this field.",
        )
      : transferHook.length > 0
        ? check(
            "transfer-hook",
            "Transfer hook",
            "danger",
            "Every transfer runs an external program that can block or tax sells.",
          )
        : check(
            "transfer-hook",
            "Transfer hook",
            "ok",
            "No transfer hook program is attached.",
          ),
    !isObject(transferFee)
      ? check(
          "transfer-fee",
          "Transfer fee",
          "unknown",
          "GoPlus did not report this field.",
        )
      : Object.keys(transferFee).length > 0
        ? check(
            "transfer-fee",
            "Transfer fee",
            "warn",
            "A Token-2022 transfer fee is taken on every transfer.",
          )
        : check("transfer-fee", "Transfer fee", "ok", "No transfer fee."),
    authorityCheck(
      "upgradable-extensions",
      "Upgradable extensions",
      (() => {
        const statuses = [
          authorityStatus(report.transfer_fee_upgradable),
          authorityStatus(report.transfer_hook_upgradable),
          authorityStatus(report.default_account_state_upgradable),
        ];
        if (statuses.some((status) => status === true)) return true;
        if (statuses.some((status) => status === null)) return null;
        return false;
      })(),
      "warn",
      "An authority can later add or change a transfer fee, transfer hook, or default frozen state.",
      "Transfer fee, transfer hook, and default state cannot be changed.",
    ),
    authorityCheck(
      "closable",
      "Close authority",
      authorityStatus(report.closable),
      "warn",
      "An authority can close the mint account.",
      "No one can close the mint account.",
    ),
    authorityCheck(
      "metadata-mutable",
      "Metadata",
      authorityStatus(report.metadata_mutable),
      "warn",
      "The name, symbol, and image can still be changed.",
      "Metadata is locked.",
    ),
    top10HolderPct === null
      ? check(
          "holder-concentration",
          "Holder concentration",
          "unknown",
          "GoPlus did not report holder shares.",
        )
      : check(
          "holder-concentration",
          "Holder concentration",
          top10HolderPct >= CONCENTRATION_WARN_PCT ? "warn" : "ok",
          `Top 10 holders own ${top10HolderPct.toFixed(1)}% of supply (may include exchanges and pools).`,
        ),
    liquidityUsd === null
      ? check(
          "liquidity",
          "DEX liquidity",
          "unknown",
          "GoPlus did not report DEX pools.",
        )
      : check(
          "liquidity",
          "DEX liquidity",
          liquidityUsd < LOW_LIQUIDITY_USD ? "warn" : "ok",
          liquidityUsd === 0
            ? "No DEX pool liquidity was reported."
            : `About $${Math.round(liquidityUsd).toLocaleString("en-US")} of pool liquidity across reported DEXes.`,
        ),
  ];

  return {
    mint,
    name: optionalText(metadata?.name),
    symbol: optionalText(metadata?.symbol),
    generatedAt: now.toISOString(),
    stale: false,
    source: source(true, false, null),
    verdict: verdictFor(checks),
    checks,
    holderCount,
    top10HolderPct,
    liquidityUsd,
    trustedToken: flag(report.trusted_token) === true,
  };
}

async function buildReport(
  mint: string,
): Promise<WalletTerminalTokenSafetyResponse> {
  const url = new URL(GOPLUS_SOLANA_URL);
  url.searchParams.set("contract_addresses", mint);
  const response = await safetyFetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "Eliza Wallet Terminal Safety/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`GoPlus responded ${response.status}`);
  }
  return parseGoPlusSolanaTokenSecurity(mint, await response.json());
}

function loadReport(mint: string): Promise<WalletTerminalTokenSafetyResponse> {
  let pending = inFlight.get(mint);
  if (!pending) {
    pending = buildReport(mint)
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
    if (error instanceof UpstreamNotFoundError) {
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
  safetyFetch = defaultFetch;
  cache.clear();
  inFlight.clear();
  refreshBuckets.clear();
}

export function __setWalletTerminalTokenSafetyFetchForTests(
  fetcher: TokenSafetyFetch,
): void {
  safetyFetch = fetcher;
}

export function __expireWalletTerminalTokenSafetyCacheForTests(): void {
  for (const entry of cache.values()) entry.expiresAt = 0;
}
