/**
 * Handler for the WALLET `token_safety` subaction: runs the GoPlus Security
 * check on one Solana mint so the agent can answer "is this token safe?" with
 * the same checks and verdict the terminal's Token safety tab shows.
 *
 * The mint comes from the `address`/`tokenAddress`/`mint`/`query` params, or
 * from the one Solana address in the message text. The handler is read-only;
 * it never touches a wallet or signer. Failures return to the planner as a
 * typed unsuccessful result with the provider's reason.
 */
import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { WalletTerminalTokenSafetyResponse } from "../../contracts.js";
import { readParams, readStringParam } from "../token-info/params.js";
import {
  defaultGoPlusFetch,
  fetchGoPlusSolanaTokenSecurity,
  type GoPlusFetch,
  SOLANA_MINT_PATTERN,
} from "./solana-token-security.js";

const SOLANA_CHAIN_NAMES = new Set(["solana", "sol", "solana-mainnet"]);
const MINT_IN_TEXT = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const VERDICT_TEXT: Record<
  WalletTerminalTokenSafetyResponse["verdict"],
  string
> = {
  avoid: "AVOID: at least one power can take, lock, or block holder tokens.",
  caution: "CAUTION: some risks or unreported fields need a closer look.",
  "no-major-flags":
    "NO MAJOR FLAGS: nothing GoPlus reported stands out. That is not proof of safety.",
};

const SEVERITY_TEXT = {
  danger: "DANGER",
  warn: "WARN",
  unknown: "NOT REPORTED",
  ok: "OK",
} as const;

type SafetyData = Parameters<HandlerCallback>[0]["data"];

function result(
  callback: HandlerCallback | undefined,
  success: boolean,
  text: string,
  data: Record<string, unknown>,
): ActionResult {
  const payload = { actionName: "WALLET", subaction: "token_safety", ...data };
  callback?.({ text, actions: ["WALLET"], data: payload as SafetyData });
  return success
    ? { success, text, data: payload as ActionResult["data"] }
    : {
        success,
        text,
        error: String(data.error),
        data: payload as ActionResult["data"],
      };
}

/** Resolve the mint from params first, then from a single address in text. */
export function resolveTokenSafetyMint(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>,
): { mint: string } | { error: "MISSING_MINT" | "AMBIGUOUS_MINT" } {
  const fromParams = readStringParam(
    readParams(options),
    "address",
    "tokenAddress",
    "mint",
    "token",
    "query",
  );
  if (fromParams && SOLANA_MINT_PATTERN.test(fromParams)) {
    return { mint: fromParams };
  }
  const text =
    typeof message.content.text === "string" ? message.content.text : "";
  const found = [...new Set(text.match(MINT_IN_TEXT) ?? [])];
  if (found.length === 1 && found[0]) return { mint: found[0] };
  return { error: found.length > 1 ? "AMBIGUOUS_MINT" : "MISSING_MINT" };
}

/** Render a report as complete planner-facing text, one line per check. */
export function formatTokenSafetyReport(
  report: WalletTerminalTokenSafetyResponse,
): string {
  const name = [report.name, report.symbol ? `(${report.symbol})` : null]
    .filter(Boolean)
    .join(" ");
  return [
    `Token safety for ${name ? `${name} ` : ""}${report.mint} from ${report.source.providerName}:`,
    VERDICT_TEXT[report.verdict],
    ...report.checks.map(
      (entry) =>
        `- ${entry.label}: ${SEVERITY_TEXT[entry.severity]}. ${entry.detail}`,
    ),
    ...(report.holderCount !== null
      ? [`Holders: ${report.holderCount.toLocaleString("en-US")}.`]
      : []),
    `Checked ${report.generatedAt}. A third-party report is a signal, not a guarantee; confirm sellability with a simulation before trading.`,
  ].join("\n");
}

export async function tokenSafetyHandler(
  _runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions | Record<string, unknown>,
  callback?: HandlerCallback,
  fetcher: GoPlusFetch = defaultGoPlusFetch,
): Promise<ActionResult> {
  const chain = readStringParam(readParams(options), "chain", "network");
  if (chain && !SOLANA_CHAIN_NAMES.has(chain.toLowerCase())) {
    return result(
      callback,
      false,
      `Token safety checks support Solana mints only, not ${chain}.`,
      { error: "UNSUPPORTED_CHAIN", chain },
    );
  }
  const resolved = resolveTokenSafetyMint(message, options);
  if ("error" in resolved) {
    return result(
      callback,
      false,
      resolved.error === "AMBIGUOUS_MINT"
        ? "The message names more than one Solana address. Say which mint to check."
        : "Give the Solana token mint address to check.",
      { error: resolved.error },
    );
  }
  try {
    const report = await fetchGoPlusSolanaTokenSecurity(resolved.mint, fetcher);
    return result(callback, true, formatTokenSafetyReport(report), {
      target: "goplus",
      mint: resolved.mint,
      report,
    });
  } catch (error) {
    // error-policy:J1 action boundary: the planner receives a typed failure.
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "GoPlus request failed";
    return result(
      callback,
      false,
      `Token safety report for ${resolved.mint} is unavailable: ${detail}.`,
      { error: "TOKEN_SAFETY_UNAVAILABLE", mint: resolved.mint, detail },
    );
  }
}
