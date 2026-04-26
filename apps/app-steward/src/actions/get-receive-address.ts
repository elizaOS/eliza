/**
 * GET_RECEIVE_ADDRESS action — returns the wallet receive addresses by chain.
 *
 * Read-only. Fetches the EVM and Solana addresses configured for the wallet
 * and surfaces them so the user can copy a deposit address. The optional
 * `chain` parameter filters the response. EVM-family chains (ethereum, base,
 * bsc) all share the same EVM address.
 *
 * @module actions/get-receive-address
 */

import type { Action, HandlerCallback, HandlerOptions } from "@elizaos/core";
import type { WalletAddresses } from "@elizaos/shared/contracts";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for the addresses API call. */
const ADDRESSES_TIMEOUT_MS = 10_000;

const VALID_CHAINS = [
  "all",
  "evm",
  "solana",
  "bsc",
  "ethereum",
  "base",
] as const;
type ValidChain = (typeof VALID_CHAINS)[number];

const EVM_FAMILY: ReadonlySet<ValidChain> = new Set([
  "evm",
  "bsc",
  "ethereum",
  "base",
]);

interface ReceiveAddressEntry {
  chain: string;
  address: string;
}

function buildEntries(
  addresses: WalletAddresses,
  chain: ValidChain,
): ReceiveAddressEntry[] {
  const entries: ReceiveAddressEntry[] = [];

  if (chain === "all" || EVM_FAMILY.has(chain)) {
    if (addresses.evmAddress) {
      const label =
        chain === "all" || chain === "evm" ? "EVM" : chain.toUpperCase();
      entries.push({ chain: label, address: addresses.evmAddress });
    }
  }

  if ((chain === "all" || chain === "solana") && addresses.solanaAddress) {
    entries.push({ chain: "Solana", address: addresses.solanaAddress });
  }

  return entries;
}

function formatEntries(entries: ReceiveAddressEntry[]): string {
  if (entries.length === 0) {
    return "No receive addresses are configured for this wallet.";
  }
  const lines = ["Receive Addresses:"];
  for (const entry of entries) {
    lines.push(`  ${entry.chain}: ${entry.address}`);
  }
  return lines.join("\n");
}

export const getReceiveAddressAction: Action = {
  name: "GET_RECEIVE_ADDRESS",

  similes: [
    "RECEIVE_ADDRESS",
    "DEPOSIT_ADDRESS",
    "WALLET_ADDRESS",
    "MY_ADDRESS",
    "SHOW_ADDRESS",
  ],

  description:
    "Return wallet receive addresses by chain. Use this when a user asks " +
    "for their wallet address, deposit address, or where to send funds. " +
    "Read-only — does not initiate any transaction.",
  descriptionCompressed: "Return wallet receive addresses by chain.",

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

      const rawChain =
        typeof params?.chain === "string"
          ? params.chain.trim().toLowerCase()
          : "all";

      const chain: ValidChain = VALID_CHAINS.includes(rawChain as ValidChain)
        ? (rawChain as ValidChain)
        : "all";

      const response = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/addresses`,
        {
          headers: {
            ...buildAuthHeaders(),
          },
          signal: AbortSignal.timeout(ADDRESSES_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const text = `Failed to fetch wallet addresses (HTTP ${response.status}).`;
        if (callback) callback({ text, action: "GET_RECEIVE_ADDRESS_FAILED" });
        return {
          text,
          success: false,
        };
      }

      const addresses = (await response.json()) as WalletAddresses;
      const entries = buildEntries(addresses, chain);
      const text = formatEntries(entries);

      if (callback) {
        callback({ text, action: "GET_RECEIVE_ADDRESS_RESPONSE" });
      }

      return {
        text,
        success: true,
        data: {
          chain,
          addresses: entries,
          evmAddress: addresses.evmAddress,
          solanaAddress: addresses.solanaAddress,
        },
      };
    } catch (err) {
      const text = `Failed to fetch wallet addresses: ${err instanceof Error ? err.message : String(err)}`;
      if (callback) callback({ text, action: "GET_RECEIVE_ADDRESS_FAILED" });
      return {
        text,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "chain",
      description:
        'Which chain to return: "all", "evm", "solana", "bsc", "ethereum", or "base". EVM-family chains share the same EVM address. Defaults to "all".',
      required: false,
      schema: {
        type: "string" as const,
        enum: ["all", "evm", "solana", "bsc", "ethereum", "base"],
      },
    },
  ],
};
