/**
 * Shared Token Constants
 *
 * Canonical source of truth for elizaOS token configuration.
 * Previously duplicated across token-redemption, payout-processor,
 * and payout-status files with inconsistent values.
 *
 * elizaOS uses 9 decimals on ALL networks (EVM + Solana).
 */

import { parseAbi } from "viem";
import { base, bsc, type Chain, mainnet } from "viem/chains";
import type { SupportedNetwork } from "@/lib/services/eliza-token-price";

// Token decimals per network (elizaOS uses 9 decimals on all networks)
export const ELIZA_DECIMALS: Record<SupportedNetwork, number> = {
  ethereum: 9,
  base: 9,
  bnb: 9,
  solana: 9,
};

// EVM chain configurations
export const EVM_CHAINS: Record<string, Chain> = {
  ethereum: mainnet,
  base: base,
  bnb: bsc,
};

// Standard ERC20 ABI for token operations
export const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
