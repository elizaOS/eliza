/**
 * stewardBalance provider — read-only wallet balance snapshot for the planner.
 *
 * Replaces the legacy CHECK_BALANCE action. Fetches `/api/wallet/balances` and
 * renders a JSON-encoded summary so the LLM can see chain holdings without a
 * mutating action call.
 *
 * @module providers/steward-balance
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { WalletBalancesResponse } from "@elizaos/core";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "../actions/wallet-action-shared.js";

/** Timeout for the balance API call. */
const BALANCE_TIMEOUT_MS = 10_000;

/** Maximum token holdings to surface per chain. */
const MAX_TOKENS_PER_CHAIN = 10;

interface BalanceEvmChainSummary {
  chain: string;
  chainId: number;
  nativeSymbol: string;
  nativeBalance: string;
  nativeValueUsd: string;
  tokens: Array<{
    symbol: string;
    balance: string;
    valueUsd: string;
  }>;
  tokenOverflow: number;
  error: string | null;
}

interface BalanceSolanaSummary {
  address: string;
  solBalance: string;
  solValueUsd: string;
  tokens: Array<{
    symbol: string;
    balance: string;
    valueUsd: string;
  }>;
  tokenOverflow: number;
}

interface BalanceSnapshot {
  evm: {
    address: string;
    chains: BalanceEvmChainSummary[];
  } | null;
  solana: BalanceSolanaSummary | null;
}

function buildSnapshot(data: WalletBalancesResponse): BalanceSnapshot {
  return {
    evm: data.evm
      ? {
          address: data.evm.address,
          chains: data.evm.chains.map(
            (c): BalanceEvmChainSummary => ({
              chain: c.chain,
              chainId: c.chainId,
              nativeSymbol: c.nativeSymbol,
              nativeBalance: c.nativeBalance,
              nativeValueUsd: c.nativeValueUsd,
              tokens: c.tokens.slice(0, MAX_TOKENS_PER_CHAIN).map((t) => ({
                symbol: t.symbol,
                balance: t.balance,
                valueUsd: t.valueUsd,
              })),
              tokenOverflow: Math.max(
                0,
                c.tokens.length - MAX_TOKENS_PER_CHAIN,
              ),
              error: c.error,
            }),
          ),
        }
      : null,
    solana: data.solana
      ? {
          address: data.solana.address,
          solBalance: data.solana.solBalance,
          solValueUsd: data.solana.solValueUsd,
          tokens: data.solana.tokens
            .slice(0, MAX_TOKENS_PER_CHAIN)
            .map((t) => ({
              symbol: t.symbol,
              balance: t.balance,
              valueUsd: t.valueUsd,
            })),
          tokenOverflow: Math.max(
            0,
            data.solana.tokens.length - MAX_TOKENS_PER_CHAIN,
          ),
        }
      : null,
  };
}

export const stewardBalanceProvider: Provider = {
  name: "stewardBalance",

  description:
    "Wallet balances across configured chains (EVM + Solana). Read-only " +
    "snapshot for the planner so it can answer balance / portfolio / holdings " +
    "questions without invoking a mutating action.",
  descriptionCompressed: "Wallet balances across chains.",

  dynamic: true,
  contexts: ["finance", "wallet", "crypto"],
  contextGate: { anyOf: ["finance", "wallet", "crypto"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const response = await fetch(
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/balances`,
        {
          headers: { ...buildAuthHeaders() },
          signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        return { text: "" };
      }

      const data = (await response.json()) as WalletBalancesResponse;
      const snapshot = buildSnapshot(data);

      if (!snapshot.evm && !snapshot.solana) {
        return { text: "" };
      }

      return {
        text: JSON.stringify({ steward_balance: snapshot }),
        data: { snapshot },
      };
    } catch {
      return { text: "", data: { snapshot: null } };
    }
  },
};
