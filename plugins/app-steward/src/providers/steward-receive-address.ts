/**
 * stewardReceiveAddress provider — wallet receive addresses for the planner.
 *
 * Replaces the legacy GET_RECEIVE_ADDRESS action. Fetches
 * `/api/wallet/addresses` and renders a JSON-encoded summary so the LLM can
 * surface the user's deposit address without invoking a mutating action.
 *
 * @module providers/steward-receive-address
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { WalletAddresses } from "@elizaos/core";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "../actions/wallet-action-shared.js";

/** Timeout for the addresses API call. */
const ADDRESSES_TIMEOUT_MS = 10_000;

interface ReceiveAddressSnapshot {
  evm: string | null;
  solana: string | null;
}

export const stewardReceiveAddressProvider: Provider = {
  name: "stewardReceiveAddress",

  description:
    "Wallet receive addresses by chain (EVM, Solana). Read-only snapshot for " +
    "the planner so it can surface a deposit address without invoking a " +
    "mutating action.",
  descriptionCompressed: "Wallet receive addresses by chain.",

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
        `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/addresses`,
        {
          headers: { ...buildAuthHeaders() },
          signal: AbortSignal.timeout(ADDRESSES_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        return { text: "" };
      }

      const addresses = (await response.json()) as WalletAddresses;
      const snapshot: ReceiveAddressSnapshot = {
        evm: addresses.evmAddress,
        solana: addresses.solanaAddress,
      };

      if (!snapshot.evm && !snapshot.solana) {
        return { text: "" };
      }

      return {
        text: JSON.stringify({ steward_receive_address: snapshot }),
        data: { snapshot },
      };
    } catch {
      return { text: "", data: { snapshot: null } };
    }
  },
};
