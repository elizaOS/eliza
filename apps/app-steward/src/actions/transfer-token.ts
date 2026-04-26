/**
 * TRANSFER_TOKEN action — transfers tokens or native BNB to another address.
 *
 * When triggered the action:
 *   1. Validates parameters (toAddress 0x format, amount > 0, assetSymbol non-empty)
 *   2. POSTs to the local transfer execution API with agent automation header
 *   3. Returns structured result: execution status, txHash, explorer URL,
 *      or unsigned TX info if user-sign mode
 *
 * All business logic (permissions, safety caps, signing) is handled
 * server-side — this action is a thin wrapper.
 *
 * @module actions/transfer-token
 */

import { hasAdminAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for the transfer API call (includes on-chain confirmation). */
const TRANSFER_TIMEOUT_MS = 60_000;

/** Chain ID used for BSC mainnet / testnet when routing through steward. */
const BSC_CHAIN_ID = 56;
const BSC_TESTNET_CHAIN_ID = 97;

/** Matches a 0x-prefixed 40-hex-char EVM address. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_ADDRESS_CAPTURE_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const DECIMAL_AMOUNT_CAPTURE_RE = /\b(\d+(?:\.\d+)?)\b/;
const ASSET_SYMBOL_CAPTURE_RE =
  /\b(?:t?bnb|bnb|eth|usdt|usdc|busd|dai|weth|wbtc)\b/i;

function extractMessageText(message: unknown): string {
  if (
    !message ||
    typeof message !== "object" ||
    !("content" in message) ||
    !message.content ||
    typeof message.content !== "object" ||
    !("text" in message.content) ||
    typeof message.content.text !== "string"
  ) {
    return "";
  }
  return message.content.text.trim();
}

function inferTransferParamsFromMessage(message: unknown): {
  toAddress?: string;
  amount?: string;
  assetSymbol?: string;
} {
  const text = extractMessageText(message);
  const addressMatches = text.match(EVM_ADDRESS_CAPTURE_RE) ?? [];
  const toAddress = addressMatches[addressMatches.length - 1];
  const amount = text.match(DECIMAL_AMOUNT_CAPTURE_RE)?.[1];
  const assetSymbol = text.match(ASSET_SYMBOL_CAPTURE_RE)?.[0];
  return {
    toAddress,
    amount,
    assetSymbol:
      typeof assetSymbol === "string"
        ? assetSymbol.trim().toUpperCase() === "TBNB"
          ? "BNB"
          : assetSymbol.trim().toUpperCase()
        : undefined,
  };
}

function isStewardConfigured(): boolean {
  const url = process.env.STEWARD_API_URL?.trim();
  const agentId =
    process.env.STEWARD_AGENT_ID?.trim() ||
    process.env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    process.env.ELIZA_STEWARD_AGENT_ID?.trim();
  return Boolean(url && agentId);
}

function resolveBscChainId(): number {
  return process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
    ? BSC_TESTNET_CHAIN_ID
    : BSC_CHAIN_ID;
}

function walletNetworkLabel(): string {
  return process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
    ? "BSC testnet"
    : "BSC";
}

function buildTransferSuccessText(args: {
  amount: string;
  assetSymbol: string;
  toAddress: string;
  mode: string;
  txHash: string;
  explorerUrl: string;
  status: string;
}): string {
  return [
    "Action: TRANSFER_TOKEN",
    `Chain: ${walletNetworkLabel()}`,
    `Amount: ${args.amount} ${args.assetSymbol}`,
    `Recipient: ${args.toAddress}`,
    `Execution mode: ${args.mode}`,
    "Executed: true",
    `Tx hash: ${args.txHash}`,
    `Explorer: ${args.explorerUrl}`,
    `Status: ${args.status}`,
  ].join("\n");
}

function buildTransferFailureText(args: {
  amount: string;
  assetSymbol: string;
  toAddress: string;
  mode: string;
  requiresUserSignature: boolean;
  reason: string;
}): string {
  return [
    "Action: TRANSFER_TOKEN",
    `Chain: ${walletNetworkLabel()}`,
    `Amount: ${args.amount} ${args.assetSymbol}`,
    `Recipient: ${args.toAddress}`,
    `Execution mode: ${args.mode}`,
    "Executed: false",
    `Requires user signature: ${args.requiresUserSignature ? "true" : "false"}`,
    `Reason: ${args.reason}`,
  ].join("\n");
}

export const transferTokenAction: Action = {
  name: "TRANSFER_TOKEN",

  similes: ["SEND_TOKEN", "TRANSFER", "SEND", "SEND_BNB", "SEND_CRYPTO", "PAY"],

  description:
    "Transfer tokens or native BNB to another address. Use this when a user " +
    "asks to send, transfer, or pay tokens to a recipient address on BSC. " +
    "Requires sender role of ADMIN or OWNER — non-admin senders cannot " +
    "initiate a transfer through this action.",
  descriptionCompressed:
    "Transfer tokens/BNB to address on BSC (admin/owner only).",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const hasWallet = Boolean(
      runtime.getSetting("EVM_PRIVATE_KEY") ||
        runtime.getSetting("PRIVY_APP_ID") ||
        runtime.getSetting("STEWARD_API_URL"), // Steward provides the wallet
    );
    if (!hasWallet) return false;
    // Mutating action — gate on admin/owner role. Non-admin senders are
    // rejected at validate so the action never reaches the handler.
    return hasAdminAccess(runtime, message);
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
      const inferredParams = inferTransferParamsFromMessage(_message);

      // ── Validate toAddress ─────────────────────────────────────────────
      const toAddress =
        typeof params?.toAddress === "string"
          ? EVM_ADDRESS_RE.test(params.toAddress.trim())
            ? params.toAddress.trim()
            : inferredParams.toAddress
          : inferredParams.toAddress;

      if (!toAddress || !EVM_ADDRESS_RE.test(toAddress)) {
        const text =
          "I need a valid recipient address (0x-prefixed, 40 hex chars).";
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return {
          text,
          success: false,
        };
      }

      // ── Validate amount ────────────────────────────────────────────────
      const amountRaw =
        typeof params?.amount === "string"
          ? Number(params.amount.trim()) > 0
            ? params.amount.trim()
            : inferredParams.amount
          : typeof params?.amount === "number"
            ? String(params.amount)
            : inferredParams.amount;

      if (
        !amountRaw ||
        Number.isNaN(Number(amountRaw)) ||
        Number(amountRaw) <= 0
      ) {
        const text = "I need a positive numeric amount for the transfer.";
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return {
          text,
          success: false,
        };
      }

      // ── Validate assetSymbol ───────────────────────────────────────────
      const assetSymbol =
        typeof params?.assetSymbol === "string"
          ? params.assetSymbol.trim().length > 0
            ? params.assetSymbol.trim()
            : inferredParams.assetSymbol
          : inferredParams.assetSymbol;

      if (!assetSymbol) {
        const text =
          "I need an asset symbol (e.g. BNB, USDT, USDC) for the transfer.";
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return {
          text,
          success: false,
        };
      }

      if (!/^[A-Za-z0-9]{1,20}$/.test(assetSymbol)) {
        const text = "Invalid asset symbol format.";
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return { text, success: false };
      }

      // ── Optional tokenAddress ──────────────────────────────────────────
      const tokenAddress =
        typeof params?.tokenAddress === "string" &&
        params.tokenAddress.trim() !== ""
          ? params.tokenAddress.trim()
          : undefined;

      if (tokenAddress && !EVM_ADDRESS_RE.test(tokenAddress)) {
        const text = "Invalid token address format.";
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return { text, success: false };
      }

      // ── Try Steward vault signing first ─────────────────────────────────
      if (isStewardConfigured()) {
        try {
          const stewardResult = await fetch(
            `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/steward-sign`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...buildAuthHeaders(),
              },
              body: JSON.stringify({
                to: toAddress,
                value: amountRaw,
                chainId: resolveBscChainId(),
                description: `Transfer ${amountRaw} ${assetSymbol} to ${toAddress}`,
              }),
              signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
            },
          );

          const stewardBody = (await stewardResult
            .json()
            .catch(() => ({}))) as Record<string, unknown>;

          // Approved — steward signed and broadcast
          if (stewardResult.ok && stewardBody.approved === true) {
            const txHash =
              typeof stewardBody.txHash === "string"
                ? stewardBody.txHash
                : "unknown";
            const explorerUrl =
              resolveBscChainId() === BSC_CHAIN_ID
                ? `https://bscscan.com/tx/${txHash}`
                : `https://testnet.bscscan.com/tx/${txHash}`;
            const text = buildTransferSuccessText({
              amount: amountRaw,
              assetSymbol,
              toAddress,
              mode: "steward",
              txHash,
              explorerUrl,
              status: "success",
            });
            if (callback) {
              callback({
                text,
                action: "TRANSFER_TOKEN_SUCCESS",
                txHash,
                explorerUrl,
                executionMode: "steward",
                executed: true,
                recipient: toAddress,
              });
            }
            return {
              text,
              success: true,
              data: {
                toAddress,
                amount: amountRaw,
                assetSymbol,
                mode: "steward",
                txHash,
                explorerUrl,
                executed: true,
              },
            };
          }

          // Pending approval — tx queued for manual review
          if (stewardResult.status === 202 && stewardBody.pending === true) {
            const txId =
              typeof stewardBody.txId === "string" ? stewardBody.txId : "";
            const text = buildTransferFailureText({
              amount: amountRaw,
              assetSymbol,
              toAddress,
              mode: "steward",
              requiresUserSignature: false,
              reason: `Transaction queued for manual approval${txId ? ` (ID: ${txId})` : ""}. A policy admin must approve before it broadcasts.`,
            });
            if (callback) {
              callback({
                text,
                action: "TRANSFER_TOKEN_PENDING",
                executionMode: "steward",
                executed: false,
                recipient: toAddress,
                txId,
              });
            }
            return {
              text,
              success: false,
              data: {
                toAddress,
                amount: amountRaw,
                assetSymbol,
                mode: "steward",
                pending: true,
                txId,
                executed: false,
              },
            };
          }

          // Denied — policy violation
          if (stewardResult.status === 403) {
            const violations = Array.isArray(stewardBody.violations)
              ? (stewardBody.violations as Array<{
                  policy: string;
                  reason: string;
                }>)
              : [];
            const violationText = violations
              .map((v) => `• ${v.policy}: ${v.reason}`)
              .join("\n");
            const reason = violationText
              ? `Policy violations:\n${violationText}`
              : "Transaction denied by steward policy.";
            const text = buildTransferFailureText({
              amount: amountRaw,
              assetSymbol,
              toAddress,
              mode: "steward",
              requiresUserSignature: false,
              reason,
            });
            if (callback) {
              callback({
                text,
                action: "TRANSFER_TOKEN_FAILED",
                executionMode: "steward",
                executed: false,
                recipient: toAddress,
                violations,
              });
            }
            return {
              text,
              success: false,
              data: {
                toAddress,
                amount: amountRaw,
                assetSymbol,
                mode: "steward",
                denied: true,
                violations,
                executed: false,
              },
            };
          }

          // Other steward errors — fall through to direct signing
        } catch (_stewardErr) {
          // Steward unavailable — fall through to direct signing
        }
      }

      // ── POST to transfer execution API (direct signing fallback) ───────
      const body: Record<string, unknown> = {
        toAddress,
        amount: amountRaw,
        assetSymbol,
        confirm: true,
      };

      if (tokenAddress) {
        body.tokenAddress = tokenAddress;
      }

      const response = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/transfer/execute`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Agent-Action": "1",
            ...buildAuthHeaders(),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as Record<
          string,
          string
        >;
        const text = `Transfer failed: ${errBody.error ?? `HTTP ${response.status}`}`;
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return {
          text,
          success: false,
        };
      }

      const result = (await response.json()) as {
        ok: boolean;
        mode: string;
        executed: boolean;
        requiresUserSignature: boolean;
        toAddress: string;
        amount: string;
        assetSymbol: string;
        unsignedTx?: Record<string, unknown>;
        execution?: {
          hash: string;
          explorerUrl: string;
          status: string;
          blockNumber: number | null;
        };
        error?: string;
      };

      if (!result.ok) {
        const text = `Transfer failed: ${result.error ?? "unknown error"}`;
        if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
        return {
          text,
          success: false,
        };
      }

      // ── Build human-readable response ──────────────────────────────────
      if (result.executed && result.execution) {
        const text = buildTransferSuccessText({
          amount: amountRaw,
          assetSymbol,
          toAddress,
          mode: result.mode,
          txHash: result.execution.hash,
          explorerUrl: result.execution.explorerUrl,
          status: result.execution.status,
        });
        if (callback) {
          callback({
            text,
            action: "TRANSFER_TOKEN_SUCCESS",
            txHash: result.execution.hash,
            explorerUrl: result.execution.explorerUrl,
            executionMode: result.mode,
            executed: true,
            recipient: toAddress,
          });
        }
        return {
          text,
          success: true,
          data: {
            toAddress,
            amount: amountRaw,
            assetSymbol,
            mode: result.mode,
            txHash: result.execution.hash,
            explorerUrl: result.execution.explorerUrl,
            executed: true,
          },
        };
      }

      // For agent automation, reporting "success" without an on-chain execution
      // leads to false-positive heartbeat status.
      const text = buildTransferFailureText({
        amount: amountRaw,
        assetSymbol,
        toAddress,
        mode: result.mode,
        requiresUserSignature: result.requiresUserSignature,
        reason: result.requiresUserSignature
          ? "User signature is required before the transfer can be broadcast."
          : "Transfer was prepared but not executed on-chain.",
      });
      if (callback) {
        callback({
          text,
          action: "TRANSFER_TOKEN_FAILED",
          executionMode: result.mode,
          executed: false,
          recipient: toAddress,
          requiresUserSignature: result.requiresUserSignature,
        });
      }
      return {
        text,
        success: false,
        data: {
          toAddress,
          amount: amountRaw,
          assetSymbol,
          mode: result.mode,
          requiresUserSignature: result.requiresUserSignature,
          executed: false,
          unsignedTx: result.unsignedTx,
        },
      };
    } catch (err) {
      const text = `Transfer failed: ${err instanceof Error ? err.message : String(err)}`;
      if (callback) callback({ text, action: "TRANSFER_TOKEN_FAILED" });
      return {
        text,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "toAddress",
      description: "Recipient EVM address (0x-prefixed, 40 hex characters)",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "amount",
      description:
        'Human-readable transfer amount (e.g. "1.5" BNB, "100" USDT)',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "assetSymbol",
      description: 'Token symbol to transfer (e.g. "BNB", "USDT", "USDC")',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "tokenAddress",
      description:
        "Token contract address for custom tokens (optional, not needed for native BNB)",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
