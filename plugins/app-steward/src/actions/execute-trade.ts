/**
 * EXECUTE_TRADE action - executes a BSC token trade (buy or sell).
 *
 * When triggered the action:
 *   1. Validates parameters (side, tokenAddress format, amount > 0)
 *   2. POSTs to the local trade execution API with agent automation header
 *   3. Returns structured result: quote details, execution status, txHash
 *      if executed, or unsigned TX info if user-sign mode
 *
 * All business logic (permissions, safety caps, signing) is handled
 * server-side - this action is a thin wrapper.
 *
 * @module actions/execute-trade
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for the trade API call (includes on-chain confirmation). */
const TRADE_TIMEOUT_MS = 60_000;

/** Matches a 0x-prefixed 40-hex-char BSC address. */
const BSC_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Check if a value is a valid extracted param (not a placeholder). */
function isValidParam(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const v = val.trim().toLowerCase();
  return (
    v.length > 0 &&
    v !== "unknown" &&
    !v.includes("required") &&
    v !== "undefined" &&
    v !== "null"
  );
}

function walletNetworkLabel(): string {
  return process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
    ? "BSC testnet"
    : "BSC";
}

function buildTradeSuccessText(args: {
  side: string;
  amount: string;
  tokenAddress: string;
  routeProvider: string;
  mode: string;
  txHash: string;
  explorerUrl: string;
  status: string;
}): string {
  return [
    "Action: EXECUTE_TRADE",
    `Chain: ${walletNetworkLabel()}`,
    `Side: ${args.side}`,
    `Amount: ${args.amount} BNB`,
    `Token: ${args.tokenAddress}`,
    `Route provider: ${args.routeProvider}`,
    `Execution mode: ${args.mode}`,
    "Executed: true",
    `Tx hash: ${args.txHash}`,
    `Explorer: ${args.explorerUrl}`,
    `Status: ${args.status}`,
  ].join("\n");
}

function buildTradeFailureText(args: {
  side: string;
  amount: string;
  tokenAddress: string;
  routeProvider: string;
  mode: string;
  requiresUserSignature: boolean;
  reason: string;
}): string {
  return [
    "Action: EXECUTE_TRADE",
    `Chain: ${walletNetworkLabel()}`,
    `Side: ${args.side}`,
    `Amount: ${args.amount} BNB`,
    `Token: ${args.tokenAddress}`,
    `Route provider: ${args.routeProvider}`,
    `Execution mode: ${args.mode}`,
    "Executed: false",
    `Requires user signature: ${args.requiresUserSignature ? "true" : "false"}`,
    `Reason: ${args.reason}`,
  ].join("\n");
}

export const executeTradeAction: Action = {
  name: "EXECUTE_TRADE",
  contexts: ["finance", "crypto", "wallet", "payments"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "payments"] },
  roleGate: { minRole: "ADMIN" },

  similes: ["BUY_TOKEN", "SELL_TOKEN", "SWAP", "TRADE", "BUY", "SELL"],

  description:
    "Execute a BSC token trade (buy or sell). Use this when a user asks to " +
    "buy or sell a token on BSC/BNB Chain. The trade is routed through " +
    "PancakeSwap and respects the current trade permission mode. Requires " +
    "sender role of ADMIN or OWNER — non-admin senders cannot initiate a " +
    "trade through this action.",
  descriptionCompressed:
    "Execute BSC token trade (buy/sell) via PancakeSwap (admin/owner only).",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const hasWallet =
      runtime.getSetting("EVM_PRIVATE_KEY") ||
      runtime.getSetting("PRIVY_APP_ID") ||
      runtime.getSetting("STEWARD_API_URL");
    if (!hasWallet) return false;
  },

  handler: async (
    _runtime,
    _message,
    _state,
    options,
    callback?: HandlerCallback,
  ) => {
    try {
      const params = (options as HandlerOptions | undefined)?.parameters;
      logger.debug(
        `[EXECUTE_TRADE] handler called with params:`,
        JSON.stringify(params ?? {}),
      );

      const rawSide = isValidParam(params?.side as string)
        ? (params?.side as string)
        : undefined;
      const side =
        typeof rawSide === "string" ? rawSide.trim().toLowerCase() : undefined;

      if (side !== "buy" && side !== "sell") {
        const text = 'I need a valid trade side ("buy" or "sell").';
        callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
        return { text, success: false };
      }

      const rawAddr = isValidParam(params?.tokenAddress as string)
        ? (params?.tokenAddress as string)
        : undefined;
      const tokenAddress =
        typeof rawAddr === "string" ? rawAddr.trim() : undefined;

      if (!tokenAddress || !BSC_ADDRESS_RE.test(tokenAddress)) {
        const text =
          "I need a valid BSC token contract address (0x-prefixed, 40 hex chars).";
        callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
        return { text, success: false };
      }

      const rawAmt = isValidParam(params?.amount as string)
        ? (params?.amount as string)
        : typeof params?.amount === "number" && params.amount > 0
          ? String(params.amount)
          : undefined;
      const amountRaw = typeof rawAmt === "string" ? rawAmt.trim() : undefined;

      if (
        !amountRaw ||
        Number.isNaN(Number(amountRaw)) ||
        Number(amountRaw) <= 0
      ) {
        const text = "I need a positive numeric amount for the trade.";
        callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
        return { text, success: false };
      }

      const slippageBps =
        typeof params?.slippageBps === "number"
          ? params.slippageBps
          : typeof params?.slippageBps === "string" &&
              params.slippageBps.trim() !== ""
            ? Number(params.slippageBps)
            : 300;

      if (Number.isNaN(slippageBps) || slippageBps < 0) {
        const text = "slippageBps must be a non-negative number.";
        callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
        return { text, success: false };
      }

      const routeProvider =
        typeof params?.routeProvider === "string" &&
        params.routeProvider.trim().length > 0
          ? params.routeProvider.trim()
          : "pancakeswap-v2";

      logger.debug(
        `[EXECUTE_TRADE] resolved: side=${side} token=${tokenAddress} amount=${amountRaw} slippage=${slippageBps} routeProvider=${routeProvider}`,
      );

      const response = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/trade/execute`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Agent-Action": "1",
            ...buildAuthHeaders(),
          },
          body: JSON.stringify({
            side,
            tokenAddress,
            amount: amountRaw,
            slippageBps,
            routeProvider,
            confirm: true,
          }),
          signal: AbortSignal.timeout(TRADE_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<
          string,
          string
        >;
        const text = buildTradeFailureText({
          side,
          amount: amountRaw,
          tokenAddress,
          routeProvider,
          mode: "unknown",
          requiresUserSignature: false,
          reason: body.error ?? `HTTP ${response.status}`,
        });
        callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
        return { text, success: false };
      }

      const result = (await response.json()) as {
        ok: boolean;
        side: string;
        mode: string;
        quote?: Record<string, unknown>;
        executed: boolean;
        requiresUserSignature: boolean;
        unsignedTx?: Record<string, unknown>;
        execution?: {
          hash: string;
          explorerUrl: string;
          status: string;
          blockNumber: number | null;
        };
        error?: string;
      };

      logger.debug(
        `[EXECUTE_TRADE] API response:`,
        JSON.stringify({
          ok: result.ok,
          side: result.side,
          mode: result.mode,
          executed: result.executed,
          requiresUserSignature: result.requiresUserSignature,
          hasExecution: !!result.execution,
          error: result.error,
        }),
      );

      const resolvedRouteProvider =
        typeof result.quote?.routeProvider === "string"
          ? result.quote.routeProvider
          : routeProvider;

      if (!result.ok) {
        const text = buildTradeFailureText({
          side,
          amount: amountRaw,
          tokenAddress,
          routeProvider: resolvedRouteProvider,
          mode: result.mode,
          requiresUserSignature: result.requiresUserSignature,
          reason: result.error ?? "unknown error",
        });
        callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
        return { text, success: false };
      }

      if (result.executed && result.execution) {
        const text = buildTradeSuccessText({
          side,
          amount: amountRaw,
          tokenAddress,
          routeProvider: resolvedRouteProvider,
          mode: result.mode,
          txHash: result.execution.hash,
          explorerUrl: result.execution.explorerUrl,
          status: result.execution.status,
        });
        callback?.({
          text,
          action: "EXECUTE_TRADE_SUCCESS",
          txHash: result.execution.hash,
          explorerUrl: result.execution.explorerUrl,
          executionMode: result.mode,
          routeProvider: resolvedRouteProvider,
          executed: true,
          tokenAddress,
          side,
        });
        return {
          text,
          success: true,
          data: {
            side,
            tokenAddress,
            amount: amountRaw,
            mode: result.mode,
            routeProvider: resolvedRouteProvider,
            txHash: result.execution.hash,
            explorerUrl: result.execution.explorerUrl,
            executed: true,
          },
        };
      }

      // For agent automation, reporting "success" without an on-chain execution
      // leads to false-positive heartbeat status.
      const text = buildTradeFailureText({
        side,
        amount: amountRaw,
        tokenAddress,
        routeProvider: resolvedRouteProvider,
        mode: result.mode,
        requiresUserSignature: result.requiresUserSignature,
        reason: result.requiresUserSignature
          ? `User signature is required to complete the ${side}.`
          : "Trade was prepared but not executed on-chain.",
      });
      callback?.({
        text,
        action: "EXECUTE_TRADE_FAILED",
        executionMode: result.mode,
        routeProvider: resolvedRouteProvider,
        executed: false,
        tokenAddress,
        side,
        requiresUserSignature: result.requiresUserSignature,
      });
      return {
        text,
        success: false,
        data: {
          side,
          tokenAddress,
          amount: amountRaw,
          mode: result.mode,
          routeProvider: resolvedRouteProvider,
          requiresUserSignature: result.requiresUserSignature,
          executed: false,
          unsignedTx: result.unsignedTx,
        },
      };
    } catch (err) {
      const text = `Trade failed: ${err instanceof Error ? err.message : String(err)}`;
      callback?.({ text, action: "EXECUTE_TRADE_FAILED" });
      return { text, success: false };
    }
  },

  parameters: [
    {
      name: "side",
      description: 'Trade direction: "buy" or "sell"',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "tokenAddress",
      description:
        "BSC token contract address (0x-prefixed, 40 hex characters)",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "amount",
      description:
        'Human-readable trade amount (e.g. "0.5" BNB for buys, or token amount for sells)',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "slippageBps",
      description: "Slippage tolerance in basis points (default 300 = 3%)",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "routeProvider",
      description:
        'Route provider preference for the swap: "pancakeswap-v2" or "0x". Defaults to "pancakeswap-v2".',
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
