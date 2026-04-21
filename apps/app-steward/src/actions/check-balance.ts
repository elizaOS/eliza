/**
 * CHECK_BALANCE action — retrieves wallet balances across chains.
 *
 * When triggered the action:
 *   1. GETs wallet balances from the local API
 *   2. Optionally filters by chain (bsc, ethereum, base, solana)
 *   3. Formats a human-readable summary with addresses, native balances,
 *      USD values, and top token holdings
 *
 * All balance fetching logic is handled server-side — this action is a
 * thin wrapper that formats the response for the LLM.
 *
 * @module actions/check-balance
 */

import type { Action, HandlerCallback, HandlerOptions } from "@elizaos/core";
import type {
  EvmChainBalance,
  WalletBalancesResponse,
} from "@elizaos/shared/contracts";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for the balance API call. */
const BALANCE_TIMEOUT_MS = 10_000;

/** Maximum token holdings to display per chain. */
const MAX_TOKENS_PER_CHAIN = 10;

const VALID_CHAINS = ["all", "bsc", "ethereum", "base", "solana"] as const;
type ValidChain = (typeof VALID_CHAINS)[number];

// ── Formatting helpers ──────────────────────────────────────────────────────

function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatUsd(value: string): string {
  const num = Number(value);
  if (Number.isNaN(num)) return `$${value}`;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatEvmChain(chain: EvmChainBalance, address: string): string {
  const label = chain.chain.toUpperCase();
  const short = shortenAddress(address);
  const lines: string[] = [];

  lines.push(`${label} (${short}):`);
  lines.push(
    `  ${chain.nativeSymbol}: ${chain.nativeBalance} (${formatUsd(chain.nativeValueUsd)})`,
  );

  if (chain.error) {
    lines.push(`  Error: ${chain.error}`);
  }

  const tokens = chain.tokens.slice(0, MAX_TOKENS_PER_CHAIN);
  if (tokens.length > 0) {
    lines.push("  Tokens:");
    for (const token of tokens) {
      lines.push(
        `    ${token.symbol}: ${token.balance} (${formatUsd(token.valueUsd)})`,
      );
    }
    if (chain.tokens.length > MAX_TOKENS_PER_CHAIN) {
      lines.push(
        `    ... and ${chain.tokens.length - MAX_TOKENS_PER_CHAIN} more`,
      );
    }
  }

  return lines.join("\n");
}

function formatSolana(
  solana: NonNullable<WalletBalancesResponse["solana"]>,
): string {
  const short = shortenAddress(solana.address);
  const lines: string[] = [];

  lines.push(`Solana (${short}):`);
  lines.push(`  SOL: ${solana.solBalance} (${formatUsd(solana.solValueUsd)})`);

  const tokens = solana.tokens.slice(0, MAX_TOKENS_PER_CHAIN);
  if (tokens.length > 0) {
    lines.push("  Tokens:");
    for (const token of tokens) {
      lines.push(
        `    ${token.symbol}: ${token.balance} (${formatUsd(token.valueUsd)})`,
      );
    }
    if (solana.tokens.length > MAX_TOKENS_PER_CHAIN) {
      lines.push(
        `    ... and ${solana.tokens.length - MAX_TOKENS_PER_CHAIN} more`,
      );
    }
  }

  return lines.join("\n");
}

function formatBalances(
  data: WalletBalancesResponse,
  chain: ValidChain,
): string {
  const sections: string[] = [];

  // EVM chains
  if (data.evm && chain !== "solana") {
    const chains =
      chain === "all"
        ? data.evm.chains
        : data.evm.chains.filter((c) => c.chain.toLowerCase() === chain);

    for (const evmChain of chains) {
      sections.push(formatEvmChain(evmChain, data.evm.address));
    }
  }

  // Solana
  if (data.solana && (chain === "all" || chain === "solana")) {
    sections.push(formatSolana(data.solana));
  }

  if (sections.length === 0) {
    if (chain === "all") {
      return "No wallet balances available.";
    }
    return `No balance data available for chain "${chain}".`;
  }

  return `Wallet Balances:\n\n${sections.join("\n\n")}`;
}

// ── Action ──────────────────────────────────────────────────────────────────

export const checkBalanceAction: Action = {
  name: "CHECK_BALANCE",

  similes: [
    "GET_BALANCE",
    "WALLET_BALANCE",
    "CHECK_WALLET",
    "MY_BALANCE",
    "PORTFOLIO",
    "HOLDINGS",
  ],

  description:
    "Check wallet balances across chains. Use this when a user asks about " +
    "their balance, portfolio, holdings, or wallet contents.",
  descriptionCompressed: "Check wallet balances across chains.",

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

      // ── Extract optional chain parameter ─────────────────────────────
      const rawChain =
        typeof params?.chain === "string"
          ? params.chain.trim().toLowerCase()
          : "all";

      const chain: ValidChain = VALID_CHAINS.includes(rawChain as ValidChain)
        ? (rawChain as ValidChain)
        : "all";

      // ── Fetch balances from API ──────────────────────────────────────
      const response = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/balances`,
        {
          headers: {
            ...buildAuthHeaders(),
          },
          signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const text = `Failed to fetch wallet balances (HTTP ${response.status}).`;
        if (callback) callback({ text, action: "CHECK_BALANCE_FAILED" });
        return {
          text,
          success: false,
        };
      }

      const data = (await response.json()) as WalletBalancesResponse;

      // ── Format and return ────────────────────────────────────────────
      const text = formatBalances(data, chain);
      if (callback) callback({ text, action: "CHECK_BALANCE_RESPONSE" });

      return {
        text,
        success: true,
        data: {
          chain,
          evm: data.evm,
          solana: data.solana,
        },
      };
    } catch (err) {
      const text = `Failed to fetch wallet balances: ${err instanceof Error ? err.message : String(err)}`;
      if (callback) callback({ text, action: "CHECK_BALANCE_FAILED" });
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
        'Which chain to check: "all", "bsc", "ethereum", "base", or "solana". Defaults to "all".',
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
