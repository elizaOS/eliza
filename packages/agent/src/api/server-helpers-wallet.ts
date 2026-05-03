/**
 * Wallet intent/export helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import type http from "node:http";
import type {
  WalletExportRejection,
  WalletExportRequestBody,
} from "@elizaos/shared";
import type { FallbackParsedAction } from "./binance-skill-helpers.js";

export type { WalletExportRejection };

// ---------------------------------------------------------------------------
// Wallet intent fallback parsing
// ---------------------------------------------------------------------------

const EVM_ADDRESS_CAPTURE_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const DECIMAL_AMOUNT_CAPTURE_RE = /\b(\d+(?:\.\d+)?)\b/;
const SEND_NATIVE_ASSET_RE =
  /\b(?:t?bnb|bnb|eth|usdt|usdc|busd|dai|weth|wbtc)\b/i;
const SWAP_ROUTE_PROVIDER_RE = /\b(pancakeswap-v2|0x|auto)\b/i;

type WalletIntentFallback =
  | { action: FallbackParsedAction; errorText?: undefined }
  | { action?: undefined; errorText: string };

function normalizeWalletAssetSymbol(asset: string): string {
  const normalized = asset.trim().toUpperCase();
  if (normalized === "TBNB") return "BNB";
  return normalized;
}

function resolveWalletDrillTokenAddress(): string | null {
  if (process.env.NODE_ENV === "production" && !process.env.VITEST) {
    return null;
  }
  const raw = process.env.WALLET_DRILL_TOKEN_ADDRESS?.trim();
  return raw && /^0x[a-fA-F0-9]{40}$/.test(raw) ? raw : null;
}

function buildWalletParameterFailureReply(
  actionName: "TRANSFER_TOKEN" | "EXECUTE_TRADE",
  reason: string,
): string {
  const walletNetwork =
    process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
      ? "BSC testnet"
      : "BSC";
  return [
    `Action: ${actionName}`,
    `Chain: ${walletNetwork}`,
    "Executed: false",
    `Reason: ${reason}`,
  ].join("\n");
}

function inferTransferFallbackAction(
  prompt: string,
): WalletIntentFallback | null {
  if (!/\b(send|transfer|pay)\b/i.test(prompt)) return null;

  const recipient = prompt.match(EVM_ADDRESS_CAPTURE_RE)?.[0];
  if (!recipient) {
    return {
      errorText: buildWalletParameterFailureReply(
        "TRANSFER_TOKEN",
        "I need a recipient EVM address to send funds.",
      ),
    };
  }

  const amount = prompt.match(DECIMAL_AMOUNT_CAPTURE_RE)?.[1];
  if (!amount) {
    return {
      errorText: buildWalletParameterFailureReply(
        "TRANSFER_TOKEN",
        "I need a positive transfer amount.",
      ),
    };
  }

  const assetMatch = prompt.match(SEND_NATIVE_ASSET_RE)?.[0];
  if (!assetMatch) {
    return {
      errorText: buildWalletParameterFailureReply(
        "TRANSFER_TOKEN",
        "I need an asset symbol such as BNB, USDT, or USDC.",
      ),
    };
  }

  return {
    action: {
      name: "TRANSFER_TOKEN",
      parameters: {
        toAddress: recipient,
        amount,
        assetSymbol: normalizeWalletAssetSymbol(assetMatch),
      },
    },
  };
}

function inferTradeSide(prompt: string): "buy" | "sell" | null {
  if (/\bsell\b/i.test(prompt)) return "sell";
  if (/\b(buy|swap|trade)\b/i.test(prompt)) return "buy";
  return null;
}

function inferTradeFallbackAction(prompt: string): WalletIntentFallback | null {
  if (!/\b(swap|trade|buy|sell)\b/i.test(prompt)) return null;

  const side = inferTradeSide(prompt);
  if (!side) {
    return {
      errorText: buildWalletParameterFailureReply(
        "EXECUTE_TRADE",
        'I need a trade side ("buy" or "sell").',
      ),
    };
  }

  const amount = prompt.match(DECIMAL_AMOUNT_CAPTURE_RE)?.[1];
  if (!amount) {
    return {
      errorText: buildWalletParameterFailureReply(
        "EXECUTE_TRADE",
        "I need a positive trade amount.",
      ),
    };
  }

  const addresses = prompt.match(EVM_ADDRESS_CAPTURE_RE) ?? [];
  const drillTokenAddress = resolveWalletDrillTokenAddress();
  const tokenAddress = addresses[0] ?? drillTokenAddress;
  if (!tokenAddress) {
    return {
      errorText: buildWalletParameterFailureReply(
        "EXECUTE_TRADE",
        drillTokenAddress === null &&
          process.env.NODE_ENV === "production" &&
          !process.env.VITEST
          ? "I need a target token contract address in the prompt."
          : "I need a target token address. Set WALLET_DRILL_TOKEN_ADDRESS or include the token contract address in the prompt.",
      ),
    };
  }

  const routeProvider =
    prompt.match(SWAP_ROUTE_PROVIDER_RE)?.[1]?.toLowerCase() ??
    "pancakeswap-v2";

  return {
    action: {
      name: "EXECUTE_TRADE",
      parameters: {
        side,
        amount,
        tokenAddress,
        routeProvider,
      },
    },
  };
}

export function inferWalletExecutionFallback(
  prompt: string,
): WalletIntentFallback | null {
  return (
    inferTransferFallbackAction(prompt) ?? inferTradeFallbackAction(prompt)
  );
}

export function hasUsableWalletFallbackParams(
  action: FallbackParsedAction,
): boolean {
  const parameters = action.parameters ?? {};
  if (action.name === "TRANSFER_TOKEN") {
    return (
      typeof parameters.toAddress === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(parameters.toAddress) &&
      typeof parameters.amount === "string" &&
      parameters.amount.trim().length > 0 &&
      typeof parameters.assetSymbol === "string" &&
      parameters.assetSymbol.trim().length > 0
    );
  }

  if (action.name === "EXECUTE_TRADE") {
    return (
      (parameters.side === "buy" || parameters.side === "sell") &&
      typeof parameters.amount === "string" &&
      parameters.amount.trim().length > 0 &&
      typeof parameters.tokenAddress === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(parameters.tokenAddress)
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Wallet export rejection
// ---------------------------------------------------------------------------

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function resolveWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): WalletExportRejection | null {
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
