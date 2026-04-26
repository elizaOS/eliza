/**
 * PREPARE_TRANSFER action — produces a non-binding transfer proposal.
 *
 * Read-only. Validates the recipient address format, looks up the
 * sender's balance for the requested asset, and surfaces a proposal
 * (gas estimate placeholder, sufficient-funds check, network label)
 * without signing or broadcasting anything. Use this before TRANSFER_TOKEN
 * so the user (or admin/owner) can review what will be sent.
 *
 * @module actions/prepare-transfer
 */

import type { Action, HandlerCallback, HandlerOptions } from "@elizaos/core";
import type {
  EvmChainBalance,
  WalletAddresses,
  WalletBalancesResponse,
} from "@elizaos/shared/contracts";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for the address + balance API calls. */
const PREPARE_TRANSFER_TIMEOUT_MS = 15_000;

/** Matches a 0x-prefixed 40-hex-char EVM address. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Approximate native gas reserve for a BNB / token transfer (BSC). */
const APPROX_TRANSFER_GAS_BNB = "0.0005";

function walletNetworkLabel(): string {
  return process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
    ? "BSC testnet"
    : "BSC";
}

function findBscBalance(
  data: WalletBalancesResponse,
): EvmChainBalance | undefined {
  return data.evm?.chains.find((c) => c.chain.toLowerCase() === "bsc");
}

function resolveAvailableBalance(
  bsc: EvmChainBalance | undefined,
  assetSymbol: string,
): { found: boolean; balance: string | null; isNative: boolean } {
  if (!bsc) return { found: false, balance: null, isNative: false };

  const upper = assetSymbol.toUpperCase();
  if (upper === bsc.nativeSymbol.toUpperCase()) {
    return { found: true, balance: bsc.nativeBalance, isNative: true };
  }

  const token = bsc.tokens.find((t) => t.symbol.toUpperCase() === upper);
  if (token) {
    return { found: true, balance: token.balance, isNative: false };
  }

  return { found: false, balance: null, isNative: false };
}

function hasSufficientFunds(
  available: string | null,
  amount: string,
): boolean | null {
  if (available === null) return null;
  const av = Number(available);
  const am = Number(amount);
  if (Number.isNaN(av) || Number.isNaN(am)) return null;
  return av >= am;
}

export const prepareTransferAction: Action = {
  name: "PREPARE_TRANSFER",

  similes: [
    "PREVIEW_TRANSFER",
    "ESTIMATE_TRANSFER",
    "QUOTE_TRANSFER",
    "TRANSFER_PREVIEW",
  ],

  description:
    "Prepare a non-binding transfer proposal: validates the recipient " +
    "address, looks up the sender's balance, and surfaces a gas estimate " +
    "and sufficient-funds check without signing or broadcasting anything. " +
    "Read-only. Use before TRANSFER_TOKEN.",
  descriptionCompressed: "Preview a token transfer (no execution).",

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

      // ── Validate toAddress ─────────────────────────────────────────────
      const toAddress =
        typeof params?.toAddress === "string" ? params.toAddress.trim() : "";
      if (!toAddress || !EVM_ADDRESS_RE.test(toAddress)) {
        const text =
          "I need a valid recipient address (0x-prefixed, 40 hex chars).";
        if (callback) callback({ text, action: "PREPARE_TRANSFER_FAILED" });
        return { text, success: false };
      }

      // ── Validate assetSymbol ───────────────────────────────────────────
      const assetSymbolRaw =
        typeof params?.assetSymbol === "string"
          ? params.assetSymbol.trim()
          : "";
      if (!assetSymbolRaw) {
        const text =
          "I need an asset symbol (e.g. BNB, USDT, USDC) for the transfer.";
        if (callback) callback({ text, action: "PREPARE_TRANSFER_FAILED" });
        return { text, success: false };
      }
      if (!/^[A-Za-z0-9]{1,20}$/.test(assetSymbolRaw)) {
        const text = "Invalid asset symbol format.";
        if (callback) callback({ text, action: "PREPARE_TRANSFER_FAILED" });
        return { text, success: false };
      }
      const assetSymbol =
        assetSymbolRaw.toUpperCase() === "TBNB"
          ? "BNB"
          : assetSymbolRaw.toUpperCase();

      // ── Validate amount ────────────────────────────────────────────────
      const amountRaw =
        typeof params?.amount === "string"
          ? params.amount.trim()
          : typeof params?.amount === "number"
            ? String(params.amount)
            : "";
      if (
        !amountRaw ||
        Number.isNaN(Number(amountRaw)) ||
        Number(amountRaw) <= 0
      ) {
        const text = "I need a positive numeric amount for the transfer.";
        if (callback) callback({ text, action: "PREPARE_TRANSFER_FAILED" });
        return { text, success: false };
      }

      // ── Fetch addresses + balances in parallel ─────────────────────────
      const port = getWalletActionApiPort();
      const [addressesResponse, balancesResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/wallet/addresses`, {
          headers: { ...buildAuthHeaders() },
          signal: AbortSignal.timeout(PREPARE_TRANSFER_TIMEOUT_MS),
        }),
        fetch(`http://127.0.0.1:${port}/api/wallet/balances`, {
          headers: { ...buildAuthHeaders() },
          signal: AbortSignal.timeout(PREPARE_TRANSFER_TIMEOUT_MS),
        }),
      ]);

      if (!addressesResponse.ok || !balancesResponse.ok) {
        const text = `Failed to fetch wallet state (addresses=${addressesResponse.status}, balances=${balancesResponse.status}).`;
        if (callback) callback({ text, action: "PREPARE_TRANSFER_FAILED" });
        return { text, success: false };
      }

      const addresses = (await addressesResponse.json()) as WalletAddresses;
      const balances =
        (await balancesResponse.json()) as WalletBalancesResponse;

      const fromAddress = addresses.evmAddress;
      const bsc = findBscBalance(balances);
      const { found, balance, isNative } = resolveAvailableBalance(
        bsc,
        assetSymbol,
      );

      const sufficient = hasSufficientFunds(balance, amountRaw);
      const nativeAvailable = bsc?.nativeBalance ?? null;
      const gasSufficient =
        nativeAvailable === null
          ? null
          : Number(nativeAvailable) >= Number(APPROX_TRANSFER_GAS_BNB);

      // Recipient sanity warnings — surface but do not reject.
      const warnings: string[] = [];
      if (
        fromAddress &&
        fromAddress.toLowerCase() === toAddress.toLowerCase()
      ) {
        warnings.push("Recipient is the sender's own wallet address.");
      }
      if (!found) {
        warnings.push(
          `Asset ${assetSymbol} was not found in the BSC wallet balance — confirm the symbol or supply tokenAddress to TRANSFER_TOKEN.`,
        );
      }
      if (sufficient === false) {
        warnings.push(
          `Insufficient ${assetSymbol} balance (${balance ?? "unknown"} available, ${amountRaw} requested).`,
        );
      }
      if (gasSufficient === false) {
        warnings.push(
          `Native gas balance is below the estimated minimum (~${APPROX_TRANSFER_GAS_BNB} BNB).`,
        );
      }

      const lines: string[] = [];
      lines.push("Action: PREPARE_TRANSFER");
      lines.push(`Chain: ${walletNetworkLabel()}`);
      lines.push(`From: ${fromAddress ?? "unknown"}`);
      lines.push(`Recipient: ${toAddress}`);
      lines.push(`Amount: ${amountRaw} ${assetSymbol}`);
      lines.push(
        `Asset type: ${found ? (isNative ? "native" : "token") : "unknown"}`,
      );
      lines.push(`Available balance: ${balance ?? "unknown"} ${assetSymbol}`);
      lines.push(
        `Sufficient funds: ${sufficient === null ? "unknown" : sufficient ? "true" : "false"}`,
      );
      lines.push(
        `Estimated gas (native): ~${APPROX_TRANSFER_GAS_BNB} ${bsc?.nativeSymbol ?? "BNB"}`,
      );
      lines.push(
        `Native gas available: ${nativeAvailable ?? "unknown"} ${bsc?.nativeSymbol ?? "BNB"}`,
      );
      if (warnings.length > 0) {
        lines.push(`Warnings: ${warnings.join(" | ")}`);
      }
      lines.push("Executed: false");
      lines.push(
        "This is a non-binding proposal. Use TRANSFER_TOKEN to broadcast.",
      );

      const text = lines.join("\n");
      if (callback) callback({ text, action: "PREPARE_TRANSFER_RESPONSE" });

      return {
        text,
        success: true,
        data: {
          fromAddress,
          toAddress,
          assetSymbol,
          amount: amountRaw,
          isNative,
          assetFound: found,
          availableBalance: balance,
          sufficientFunds: sufficient,
          estimatedGasNative: APPROX_TRANSFER_GAS_BNB,
          nativeGasAvailable: nativeAvailable,
          gasSufficient,
          warnings,
          chain: walletNetworkLabel(),
          executed: false,
        },
      };
    } catch (err) {
      const text = `Failed to prepare transfer: ${err instanceof Error ? err.message : String(err)}`;
      if (callback) callback({ text, action: "PREPARE_TRANSFER_FAILED" });
      return { text, success: false };
    }
  },

  parameters: [
    {
      name: "toAddress",
      description: "Recipient EVM address (0x-prefixed, 40 hex characters).",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "assetSymbol",
      description: 'Token symbol to transfer (e.g. "BNB", "USDT", "USDC").',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "amount",
      description: 'Human-readable transfer amount (e.g. "1.5", "100").',
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
