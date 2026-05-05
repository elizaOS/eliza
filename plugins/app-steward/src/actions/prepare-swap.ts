/**
 * PREPARE_SWAP action — fetches a non-binding swap proposal.
 *
 * Read-only. Calls the BSC trade preflight + quote endpoints to surface
 * route options, slippage estimates, expected output, and readiness checks
 * without executing or signing anything. Use this to gather information
 * before asking the user (or an admin/owner) to approve EXECUTE_TRADE.
 *
 * @module actions/prepare-swap
 */

import type { Action, HandlerCallback, HandlerOptions } from "@elizaos/core";
import type {
  BscTradePreflightResponse,
  BscTradeQuoteResponse,
  BscTradeSide,
} from "@elizaos/shared";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for the preflight + quote API calls. */
const PREPARE_SWAP_TIMEOUT_MS = 20_000;

/** Default slippage tolerance for prepared quotes (basis points). */
const DEFAULT_SLIPPAGE_BPS = 300;

/** Matches a 0x-prefixed 40-hex-char EVM address. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Native gas symbol for the BSC route — kept here so the action does not
 *  reach into shared chain-utils which is not exported as an entrypoint. */
const BSC_NATIVE_SYMBOL = "BNB";

function normalizeSymbol(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.toUpperCase() === "TBNB" ? "BNB" : trimmed.toUpperCase();
}

/**
 * Resolve {fromSymbol, toSymbol} into a BSC swap side + token contract
 * address. PancakeSwap routes are denominated in BNB, so swaps must be
 * either BNB → token (buy) or token → BNB (sell).
 */
function resolveSwapPair(
  fromSymbol: string,
  toSymbol: string,
  fromAddress: string | undefined,
  toAddress: string | undefined,
):
  | {
      ok: true;
      side: BscTradeSide;
      tokenAddress: string;
    }
  | {
      ok: false;
      reason: string;
    } {
  const isFromNative = fromSymbol === BSC_NATIVE_SYMBOL;
  const isToNative = toSymbol === BSC_NATIVE_SYMBOL;

  if (isFromNative && isToNative) {
    return { ok: false, reason: "BNB → BNB is not a valid swap." };
  }

  if (isFromNative) {
    if (!toAddress || !EVM_ADDRESS_RE.test(toAddress)) {
      return {
        ok: false,
        reason: `Cannot resolve token contract address for ${toSymbol}. Provide it explicitly via toAddress.`,
      };
    }
    return { ok: true, side: "buy", tokenAddress: toAddress };
  }

  if (isToNative) {
    if (!fromAddress || !EVM_ADDRESS_RE.test(fromAddress)) {
      return {
        ok: false,
        reason: `Cannot resolve token contract address for ${fromSymbol}. Provide it explicitly via fromAddress.`,
      };
    }
    return { ok: true, side: "sell", tokenAddress: fromAddress };
  }

  return {
    ok: false,
    reason:
      "BSC swaps must be routed through BNB. One of fromSymbol or toSymbol must be BNB.",
  };
}

function formatProposal(args: {
  side: BscTradeSide;
  fromSymbol: string;
  toSymbol: string;
  amount: string;
  preflight: BscTradePreflightResponse;
  quote: BscTradeQuoteResponse;
}): string {
  const lines: string[] = [];
  lines.push("Action: PREPARE_SWAP");
  lines.push(`Side: ${args.side}`);
  lines.push(`From: ${args.amount} ${args.fromSymbol}`);
  lines.push(
    `Expected out: ${args.quote.quoteOut.amount} ${args.quote.quoteOut.symbol}`,
  );
  lines.push(
    `Min received: ${args.quote.minReceive.amount} ${args.quote.minReceive.symbol}`,
  );
  lines.push(`Route provider: ${args.quote.routeProvider}`);
  lines.push(`Route: ${args.quote.route.join(" → ")}`);
  lines.push(`Slippage: ${args.quote.slippageBps} bps`);
  lines.push(`Price: ${args.quote.price}`);

  const checks = args.preflight.checks;
  lines.push(
    `Preflight: walletReady=${checks.walletReady} rpcReady=${checks.rpcReady} chainReady=${checks.chainReady} gasReady=${checks.gasReady}`,
  );
  if (args.preflight.reasons.length > 0) {
    lines.push(`Preflight notes: ${args.preflight.reasons.join("; ")}`);
  }
  lines.push("Executed: false");
  lines.push("This is a non-binding proposal. Use EXECUTE_TRADE to broadcast.");
  return lines.join("\n");
}

export const prepareSwapAction: Action = {
  name: "PREPARE_SWAP",

  similes: [
    "QUOTE_SWAP",
    "PREVIEW_SWAP",
    "ESTIMATE_SWAP",
    "SWAP_QUOTE",
    "GET_SWAP_QUOTE",
  ],

  description:
    "Prepare a non-binding swap proposal: returns route options, slippage " +
    "estimate, expected output, and readiness checks without signing or " +
    "broadcasting anything. Read-only. Use before EXECUTE_TRADE so the user " +
    "can review the route.",
  descriptionCompressed: "Quote a BSC swap (no execution).",

  validate: async () => true,

  handler: async (
    _runtime,
    _message,
    _state,
    options,
    callback?: HandlerCallback,
  ) => {
    try {
      const params = (options as HandlerOptions | undefined)?.parameters;

      const fromSymbol = normalizeSymbol(params?.fromSymbol);
      const toSymbol = normalizeSymbol(params?.toSymbol);

      if (!fromSymbol || !toSymbol) {
        const text =
          "I need both fromSymbol and toSymbol (e.g. BNB and USDT) to prepare a swap.";
        if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
        return { text, success: false };
      }

      const fromAddress =
        typeof params?.fromAddress === "string"
          ? params.fromAddress.trim()
          : undefined;
      const toAddress =
        typeof params?.toAddress === "string"
          ? params.toAddress.trim()
          : undefined;

      const pair = resolveSwapPair(
        fromSymbol,
        toSymbol,
        fromAddress,
        toAddress,
      );
      if (pair.ok === false) {
        if (callback) {
          callback({ text: pair.reason, action: "PREPARE_SWAP_FAILED" });
        }
        return { text: pair.reason, success: false };
      }

      const amountRaw =
        typeof params?.amount === "string" && params.amount.trim().length > 0
          ? params.amount.trim()
          : typeof params?.amount === "number" && params.amount > 0
            ? String(params.amount)
            : undefined;

      if (
        amountRaw !== undefined &&
        (Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0)
      ) {
        const text =
          "amount must be a positive number (in the from-asset's units).";
        if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
        return { text, success: false };
      }

      const slippageBps =
        typeof params?.slippageBps === "number"
          ? params.slippageBps
          : typeof params?.slippageBps === "string" &&
              params.slippageBps.trim().length > 0
            ? Number(params.slippageBps)
            : DEFAULT_SLIPPAGE_BPS;

      if (Number.isNaN(slippageBps) || slippageBps < 0) {
        const text = "slippageBps must be a non-negative number.";
        if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
        return { text, success: false };
      }

      // ── Preflight ─────────────────────────────────────────────────────
      const preflightResponse = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/trade/preflight`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildAuthHeaders(),
          },
          body: JSON.stringify({ tokenAddress: pair.tokenAddress }),
          signal: AbortSignal.timeout(PREPARE_SWAP_TIMEOUT_MS),
        },
      );

      if (!preflightResponse.ok) {
        const text = `Swap preflight failed (HTTP ${preflightResponse.status}).`;
        if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
        return { text, success: false };
      }

      const preflight =
        (await preflightResponse.json()) as BscTradePreflightResponse;

      // When no amount is supplied, return preflight-only proposal so the
      // caller can surface readiness + token validity without a live quote.
      if (amountRaw === undefined) {
        const lines = [
          "Action: PREPARE_SWAP",
          `Side: ${pair.side}`,
          `From: ${fromSymbol}`,
          `To: ${toSymbol}`,
          `Token: ${pair.tokenAddress}`,
          `Preflight: walletReady=${preflight.checks.walletReady} rpcReady=${preflight.checks.rpcReady} chainReady=${preflight.checks.chainReady} gasReady=${preflight.checks.gasReady}`,
        ];
        if (preflight.reasons.length > 0) {
          lines.push(`Preflight notes: ${preflight.reasons.join("; ")}`);
        }
        lines.push("Quote: skipped (no amount provided)");
        lines.push("Executed: false");
        const text = lines.join("\n");
        if (callback) callback({ text, action: "PREPARE_SWAP_RESPONSE" });
        return {
          text,
          success: true,
          data: {
            side: pair.side,
            fromSymbol,
            toSymbol,
            tokenAddress: pair.tokenAddress,
            slippageBps,
            preflight,
            executed: false,
          },
        };
      }

      // ── Quote ─────────────────────────────────────────────────────────
      const quoteResponse = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/trade/quote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildAuthHeaders(),
          },
          body: JSON.stringify({
            side: pair.side,
            tokenAddress: pair.tokenAddress,
            amount: amountRaw,
            slippageBps,
          }),
          signal: AbortSignal.timeout(PREPARE_SWAP_TIMEOUT_MS),
        },
      );

      if (!quoteResponse.ok) {
        const errBody = (await quoteResponse
          .json()
          .catch(() => ({}))) as Record<string, string>;
        const text = `Swap quote failed: ${errBody.error ?? `HTTP ${quoteResponse.status}`}`;
        if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
        return { text, success: false };
      }

      const quote = (await quoteResponse.json()) as BscTradeQuoteResponse;
      if (!quote.ok) {
        const text = "Swap quote was not ok.";
        if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
        return { text, success: false };
      }

      const text = formatProposal({
        side: pair.side,
        fromSymbol,
        toSymbol,
        amount: amountRaw,
        preflight,
        quote,
      });

      if (callback) callback({ text, action: "PREPARE_SWAP_RESPONSE" });

      return {
        text,
        success: true,
        data: {
          side: pair.side,
          fromSymbol,
          toSymbol,
          tokenAddress: pair.tokenAddress,
          amount: amountRaw,
          slippageBps: quote.slippageBps,
          routeProvider: quote.routeProvider,
          route: quote.route,
          quoteIn: quote.quoteIn,
          quoteOut: quote.quoteOut,
          minReceive: quote.minReceive,
          price: quote.price,
          preflight,
          executed: false,
        },
      };
    } catch (err) {
      const text = `Failed to prepare swap: ${err instanceof Error ? err.message : String(err)}`;
      if (callback) callback({ text, action: "PREPARE_SWAP_FAILED" });
      return { text, success: false };
    }
  },

  parameters: [
    {
      name: "fromSymbol",
      description:
        'Source asset symbol (e.g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "toSymbol",
      description:
        'Destination asset symbol (e.g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "amount",
      description:
        'Amount of the source asset to swap (human-readable units, e.g. "0.5").',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "fromAddress",
      description:
        "Source token contract address (required when the source asset is not BNB).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "toAddress",
      description:
        "Destination token contract address (required when the destination asset is not BNB).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "slippageBps",
      description: "Slippage tolerance in basis points (default 300 = 3%).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
};
