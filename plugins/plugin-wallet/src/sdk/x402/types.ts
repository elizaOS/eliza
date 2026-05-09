/**
 * @module x402/types
 * x402 protocol type definitions and well-known asset constants.
 *
 * Implements the x402 HTTP payment protocol spec (coinbase/x402) for
 * multi-chain USDC payments. Covers 10 mainnet chains: Base, Ethereum,
 * Arbitrum, Polygon, Optimism, Avalanche, Unichain, Linea, Sonic, Worldchain.
 *
 * USDC addresses are sourced from Circle's official registry:
 * https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
// x402 protocol types — compatible with @x402/core spec
import type { Address, Hash } from "viem";

// ─── x402 Protocol Types (from coinbase/x402 spec) ───

/** Resource information included in x402 responses */
export interface X402ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

/** Payment requirements returned in 402 response PAYMENT-REQUIRED header */
export interface X402PaymentRequirements {
  scheme: string; // e.g. "exact"
  network: string; // e.g. "base:8453"
  asset: string; // token contract address (e.g. USDC on Base)
  amount: string; // amount in smallest unit (e.g. "1000000" = 1 USDC)
  payTo: string; // recipient address
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Full 402 response payload (base64-decoded from PAYMENT-REQUIRED header) */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** Payment payload sent back with PAYMENT-SIGNATURE header */
export interface X402PaymentPayload {
  x402Version: number;
  resource: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>; // scheme-specific (e.g. tx hash, signature)
  extensions?: Record<string, unknown>;
}

/** Settlement response returned in PAYMENT-RESPONSE header */
export interface X402SettlementResponse {
  success: boolean;
  txHash?: string;
  network?: string;
  error?: string;
}

// ─── AgentWallet x402 Client Types ───

/** Per-service spending cap configuration */
export interface X402ServiceBudget {
  /** Domain or URL pattern (e.g. "api.example.com" or "*") */
  service: string;
  /** Max spend per single request in token base units */
  maxPerRequest: bigint;
  /** Max total spend per day in token base units */
  dailyLimit: bigint;
}

/** Transaction log entry for x402 payments */
export interface X402TransactionLog {
  timestamp: number;
  service: string;
  url: string;
  amount: bigint;
  token: Address;
  recipient: Address;
  txHash: Hash;
  network: string;
  scheme: string;
  success: boolean;
  error?: string;
}

/** Configuration for the x402 client */
export interface X402ClientConfig {
  /** Service-level budget controls */
  serviceBudgets?: X402ServiceBudget[];
  /** Global daily spending limit (token base units, default: unlimited) */
  globalDailyLimit?: bigint;
  /** Global per-request max (token base units, default: unlimited) */
  globalPerRequestMax?: bigint;
  /** Supported networks (default: ["base:8453"]) */
  supportedNetworks?: string[];
  /** Supported assets by network (default: USDC on Base) */
  supportedAssets?: Record<string, Address[]>;
  /** Max retries after payment (default: 1) */
  maxRetries?: number;
  /** Custom facilitator URL (optional, for verify/settle) */
  facilitatorUrl?: string;
  /** Whether to auto-pay 402 responses (default: true) */
  autoPay?: boolean;
  /** Callback before payment — return false to reject */
  onBeforePayment?: (
    req: X402PaymentRequirements,
    url: string,
  ) => Promise<boolean> | boolean;
  /** Callback after payment */
  onPaymentComplete?: (log: X402TransactionLog) => void;
}

// ─── Well-known Assets ───

/**
 * USDC contract addresses by network (chain-name:chainId format).
 * Sources:
 *   - EVM chains: https://developers.circle.com/cctp/references/contract-addresses
 *   - Linea: https://linea.build/ecosystem/usdc
 *   - Unichain: https://docs.unichain.org/docs/technical-information/token-addresses
 *   - Sonic: https://docs.soniclabs.com/build/useful-addresses
 *   - Worldchain: https://docs.worldcoin.org/world-chain/addresses/usdc
 */
export const USDC_ADDRESSES: Record<string, Address> = {
  // Testnets
  "base-sepolia:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Mainnets
  "base:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "ethereum:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "arbitrum:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "polygon:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "bsc:56": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  "optimism:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  "avalanche:43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  "unichain:130": "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
  "linea:59144": "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
  "sonic:146": "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
  "worldchain:480": "0x79A02482A880bCE3B13e09Da970dC34db4CD24d1",
} as const;

/** Default supported networks (all mainnet chains) */
export const DEFAULT_SUPPORTED_NETWORKS = [
  "base:8453",
  "ethereum:1",
  "arbitrum:42161",
  "polygon:137",
  "bsc:56",
  "optimism:10",
  "avalanche:43114",
  "unichain:130",
  "linea:59144",
  "sonic:146",
  "worldchain:480",
] as const;
