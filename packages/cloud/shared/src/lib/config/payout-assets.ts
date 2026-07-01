/**
 * Creator-payout asset configuration (#10732).
 *
 * Creator payouts move from the elizaOS token to **USDC on Solana or Base**.
 * This module adds the USDC mint/contract config and an asset-aware resolver so
 * the payout processor can transfer either asset with the same ERC-20 / SPL
 * code path. USDC uses 6 decimals (elizaOS uses 9); with 1 USDC ≈ $1 the payout
 * amount is simply the USD value, removing token-price volatility entirely.
 *
 * US-only, Circle-issued USDC. Base + Solana are the offered creator-payout
 * networks; Ethereum + BNB mints are included for completeness/back-compat.
 */

import type { SupportedNetwork } from "../services/eliza-token-price";
import { ELIZA_TOKEN_ADDRESSES, isTestnetMode } from "./payout-networks";
import { ELIZA_DECIMALS } from "./token-constants";

export type PayoutAsset = "eliza" | "usdc";

export const PAYOUT_ASSETS: readonly PayoutAsset[] = ["eliza", "usdc"] as const;

export function isPayoutAsset(value: string): value is PayoutAsset {
  return value === "eliza" || value === "usdc";
}

/** USDC always uses 6 decimals across every supported chain. */
export const USDC_DECIMALS = 6;

/**
 * Circle USDC token addresses (mainnet). EVM = ERC-20 contract; Solana = SPL
 * mint. Base + Solana are the offered creator-payout networks (#10732).
 */
export const USDC_TOKEN_ADDRESSES: Record<SupportedNetwork, string> = {
  // Circle-native USDC (not bridged USDC.e).
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  bnb: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/** Testnet USDC (env-overridable) for base-sepolia + solana-devnet dry runs. */
export const USDC_TESTNET_TOKEN_ADDRESSES: Record<SupportedNetwork, string> = {
  ethereum: process.env.USDC_SEPOLIA || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  base: process.env.USDC_BASE_SEPOLIA || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  bnb: process.env.USDC_BNB_TESTNET || "0x64544969ed7EBf5f083679233325356EBe738930",
  solana: process.env.USDC_SOLANA_DEVNET || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

/** Networks offered for USDC creator payouts (#10732): Solana + Base only. */
export const USDC_PAYOUT_NETWORKS: readonly SupportedNetwork[] = ["solana", "base"] as const;

export function isUsdcPayoutNetwork(network: SupportedNetwork): boolean {
  return USDC_PAYOUT_NETWORKS.includes(network);
}

export interface PayoutTokenConfig {
  address: string;
  decimals: number;
  symbol: string;
}

/**
 * Resolve the on-chain token config for a payout of `asset` on `network`.
 * Testnet mode swaps to the testnet USDC address, mirroring how the elizaOS
 * payout path resolves its RPC/network.
 */
export function getPayoutTokenConfig(
  network: SupportedNetwork,
  asset: PayoutAsset,
): PayoutTokenConfig {
  if (asset === "usdc") {
    const table = isTestnetMode() ? USDC_TESTNET_TOKEN_ADDRESSES : USDC_TOKEN_ADDRESSES;
    return { address: table[network], decimals: USDC_DECIMALS, symbol: "USDC" };
  }
  return {
    address: ELIZA_TOKEN_ADDRESSES[network],
    decimals: ELIZA_DECIMALS[network],
    symbol: "elizaOS",
  };
}
