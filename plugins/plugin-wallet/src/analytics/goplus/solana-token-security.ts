/**
 * GoPlus Security client for Solana token risk: fetches one mint's
 * `token_security` report and turns it into typed checks with an
 * avoid / caution / no-major-flags verdict.
 *
 * Consumers are the terminal's public token safety route and the agent's
 * `WALLET action=token_safety` handler, so both read a mint the same way.
 * The report is a third-party signal, not proof of safety: a field GoPlus did
 * not report becomes an `unknown` check that holds the verdict at caution
 * rather than a silent pass.
 */
import type {
  WalletTerminalTokenSafetyResponse,
  WalletTokenSafetyCheck,
  WalletTokenSafetySeverity,
  WalletTokenSafetySource,
  WalletTokenSafetyVerdict,
} from "../../contracts.js";

const GOPLUS_SOLANA_URL =
  "https://api.gopluslabs.io/api/v1/solana/token_security";
const GOPLUS_PROVIDER = {
  providerId: "goplus",
  providerName: "GoPlus Security",
  providerUrl: "https://gopluslabs.io",
} as const;
const FETCH_TIMEOUT_MS = 10_000;
const CONCENTRATION_WARN_PCT = 30;
const LOW_LIQUIDITY_USD = 10_000;

/** Base58 Solana address, 32 to 44 characters. */
export const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type GoPlusFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

/** GoPlus answered but has no report for the requested mint. */
export class GoPlusNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoPlusNotFoundError";
  }
}

export const defaultGoPlusFetch: GoPlusFetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export function goPlusSource(
  available: boolean,
  stale: boolean,
  error: string | null,
): WalletTokenSafetySource {
  return { ...GOPLUS_PROVIDER, available, stale, error };
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
 * {@link GoPlusNotFoundError} when GoPlus has no report for the mint.
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
    throw new GoPlusNotFoundError("GoPlus has no report for this mint");
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
    source: goPlusSource(true, false, null),
    verdict: verdictFor(checks),
    checks,
    holderCount,
    top10HolderPct,
    liquidityUsd,
    trustedToken: flag(report.trusted_token) === true,
  };
}

/** Fetch and parse the GoPlus report for one validated Solana mint. */
export async function fetchGoPlusSolanaTokenSecurity(
  mint: string,
  fetcher: GoPlusFetch = defaultGoPlusFetch,
): Promise<WalletTerminalTokenSafetyResponse> {
  const url = new URL(GOPLUS_SOLANA_URL);
  url.searchParams.set("contract_addresses", mint);
  const response = await fetcher(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "Eliza Wallet Token Safety/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`GoPlus responded ${response.status}`);
  }
  return parseGoPlusSolanaTokenSecurity(mint, await response.json());
}
