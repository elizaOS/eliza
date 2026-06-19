/**
 * @module swap/types
 * Type definitions and constants for the multi-chain Uniswap V3 SwapModule.
 *
 * Supported swap chains: Base, Arbitrum, Optimism, Polygon.
 * All router/quoter addresses verified against official Uniswap V3 deployment docs:
 * - Base: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 * - Arbitrum: https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
 * - Optimism: https://docs.uniswap.org/contracts/v3/reference/deployments/optimism-deployments
 * - Polygon: https://docs.uniswap.org/contracts/v3/reference/deployments/polygon-deployments
 *
 * Note: Base uses a unique SwapRouter02 address; Arbitrum, Optimism, and Polygon
 * share the same universal SwapRouter02 deployment address.
 */
import type { Address, Hash } from "viem";

/** Uniswap V3 fee tier options */
export type UniswapFeeTier = 100 | 500 | 3000 | 10000;

/** Chains supported for Uniswap V3 swap */
export type SwapChain = "base" | "arbitrum" | "optimism" | "polygon";

export interface SwapQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  amountInNet: bigint;
  feeAmount: bigint;
  amountOut: bigint;
  amountOutMinimum: bigint;
  poolFeeTier: UniswapFeeTier;
  effectiveRate: number;
  gasEstimate: bigint;
}

export interface SwapOptions {
  slippageBps?: number;
  feeTiers?: UniswapFeeTier[];
  deadlineSecs?: number;
  feeWallet?: Address;
}

export interface SwapResult {
  txHash: Hash;
  feeTxHash?: Hash;
  quote: SwapQuote;
  approvalRequired: boolean;
  approvalTxHash?: Hash;
}

export interface SwapModuleConfig {
  routerAddress: Address;
  quoterAddress: Address;
  feeBps: number;
  feeWallet: Address;
  /** Chain this SwapModule is configured for */
  chain: SwapChain;
}

// ─── Token Addresses ───

/** Well-known Base Mainnet token addresses */
export const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  WETH: "0x4200000000000000000000000000000000000006" as const,
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const,
  WNATIVE: "0x4200000000000000000000000000000000000006" as const,
};

/** Well-known Arbitrum token addresses */
export const ARBITRUM_TOKENS = {
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const,
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const,
  WNATIVE: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const,
};

/** Well-known Optimism token addresses */
export const OPTIMISM_TOKENS = {
  USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as const,
  WETH: "0x4200000000000000000000000000000000000006" as const,
  OP: "0x4200000000000000000000000000000000000042" as const,
  WNATIVE: "0x4200000000000000000000000000000000000006" as const,
};

/** Well-known Polygon token addresses */
export const POLYGON_TOKENS = {
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const,
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" as const,
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" as const,
  WNATIVE: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" as const,
};

// ─── Uniswap V3 Contract Addresses ───

/**
 * Uniswap V3 router and quoter addresses.
 *
 * Base has a different router (SwapRouter02 deployed at a unique address due to BASE chain launch).
 * Arbitrum, Optimism, and Polygon use the same universal SwapRouter02 address.
 *
 * Sources:
 *   - Base: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 *   - Arbitrum: https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
 *   - Optimism: https://docs.uniswap.org/contracts/v3/reference/deployments/optimism-deployments
 *   - Polygon: https://docs.uniswap.org/contracts/v3/reference/deployments/polygon-deployments
 */
export const UNISWAP_V3_ADDRESSES: Record<
  SwapChain,
  { ROUTER: Address; QUOTER_V2: Address }
> = {
  base: {
    ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
    QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  },
  arbitrum: {
    ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  },
  optimism: {
    ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  },
  polygon: {
    ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  },
};

/** Protocol fee in bps — 0.875% */
export const PROTOCOL_FEE_BPS = 875;
/** Protocol fee collector address (all EVM chains) */
export const PROTOCOL_FEE_COLLECTOR =
  "0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD" as const;
/** Default slippage in bps — 0.5% */
export const DEFAULT_SLIPPAGE_BPS = 50;
