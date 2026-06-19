/**
 * @module bridge/types
 * Type definitions and constants for the CCTP V2 cross-chain USDC bridge.
 *
 * Supports 10 EVM chains + Solana via Circle's Cross-Chain Transfer Protocol V2.
 * EVM chains: Ethereum, Avalanche, Optimism, Arbitrum, Base, Polygon,
 *             Unichain, Linea, Sonic, Worldchain.
 * Non-EVM: Solana (via bridge/solana.ts — uses separate CCTP V2 programs).
 *
 * Contract addresses verified against:
 * - CCTP V2 EVM: https://developers.circle.com/cctp/references/contract-addresses
 * - Solana V2 programs: https://developers.circle.com/cctp/references/solana-programs
 * - USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
import type { Address, Hash, Hex } from "viem";

/** Supported bridge destination chains */
export type BridgeChain =
  | "ethereum"
  | "avalanche"
  | "optimism"
  | "arbitrum"
  | "base"
  | "polygon"
  | "unichain"
  | "linea"
  | "sonic"
  | "worldchain"
  | "solana";

/** EVM-only bridge chains (excludes non-EVM like Solana) */
export type EVMBridgeChain = Exclude<BridgeChain, "solana">;

/**
 * CCTP V2 domain IDs — official Circle domain identifiers.
 * Source: https://developers.circle.com/cctp/references/contract-addresses
 * Solana domain: 5 — https://developers.circle.com/cctp/docs/solana
 */
export const CCTP_DOMAIN_IDS: Record<BridgeChain, number> = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  base: 6,
  polygon: 7,
  unichain: 10,
  linea: 11,
  sonic: 13,
  worldchain: 14,
  solana: 5,
};

/**
 * EVM chain IDs for EVM-compatible bridge chains.
 * Solana is excluded — use solana.ts for Solana-specific operations.
 */
export const BRIDGE_CHAIN_IDS: Record<EVMBridgeChain, number> = {
  ethereum: 1,
  avalanche: 43114,
  optimism: 10,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  unichain: 130,
  linea: 59144,
  sonic: 146,
  worldchain: 480,
};

/**
 * USDC contract addresses per chain (native Circle USDC, not bridged variants).
 * Solana USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (stored as string, not Address/Hex)
 */
export const USDC_CONTRACT: Record<EVMBridgeChain, Address> = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  unichain: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
  linea: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
  sonic: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
  worldchain: "0x79A02482A880bCE3B13e09Da970dC34db4CD24d1",
};

/** Solana USDC mint address */
export const SOLANA_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;

/**
 * CCTP V2 TokenMessengerV2 — deterministic CREATE2 deployment, same address on all EVM chains.
 * Source: https://developers.circle.com/cctp/references/contract-addresses
 * Verified on-chain: BaseScan, Etherscan, Arbiscan (active transactions as of 2026-03-10)
 * Solana uses a different program — see bridge/solana.ts
 */
const CCTP_V2_TOKEN_MESSENGER: Address =
  "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

export const TOKEN_MESSENGER_V2: Record<EVMBridgeChain, Address> = {
  ethereum: CCTP_V2_TOKEN_MESSENGER,
  avalanche: CCTP_V2_TOKEN_MESSENGER,
  optimism: CCTP_V2_TOKEN_MESSENGER,
  arbitrum: CCTP_V2_TOKEN_MESSENGER,
  base: CCTP_V2_TOKEN_MESSENGER,
  polygon: CCTP_V2_TOKEN_MESSENGER,
  unichain: CCTP_V2_TOKEN_MESSENGER,
  linea: CCTP_V2_TOKEN_MESSENGER,
  sonic: CCTP_V2_TOKEN_MESSENGER,
  worldchain: CCTP_V2_TOKEN_MESSENGER,
};

/**
 * CCTP V2 MessageTransmitterV2 — deterministic CREATE2 deployment, same address on all EVM chains.
 * Source: https://developers.circle.com/cctp/references/contract-addresses
 * Solana uses a different program — see bridge/solana.ts
 */
const CCTP_V2_MESSAGE_TRANSMITTER: Address =
  "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

export const MESSAGE_TRANSMITTER_V2: Record<EVMBridgeChain, Address> = {
  ethereum: CCTP_V2_MESSAGE_TRANSMITTER,
  avalanche: CCTP_V2_MESSAGE_TRANSMITTER,
  optimism: CCTP_V2_MESSAGE_TRANSMITTER,
  arbitrum: CCTP_V2_MESSAGE_TRANSMITTER,
  base: CCTP_V2_MESSAGE_TRANSMITTER,
  polygon: CCTP_V2_MESSAGE_TRANSMITTER,
  unichain: CCTP_V2_MESSAGE_TRANSMITTER,
  linea: CCTP_V2_MESSAGE_TRANSMITTER,
  sonic: CCTP_V2_MESSAGE_TRANSMITTER,
  worldchain: CCTP_V2_MESSAGE_TRANSMITTER,
};

/**
 * CCTP V2 minFinalityThreshold values.
 * - FAST (0): ~12 seconds. Circle fast attestation.
 * - FINALIZED (1000): Full on-chain finality.
 */
export const FINALITY_THRESHOLD = {
  FAST: 0,
  FINALIZED: 1000,
} as const;

/** Circle IRIS attestation API base URL */
export const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";
/** Max attestation polling attempts before timeout */
export const MAX_ATTESTATION_POLLS = 60;
/** Polling interval for attestation (milliseconds) */
export const ATTESTATION_POLL_INTERVAL_MS = 5000;

/** Options for a bridge operation */
export interface BridgeOptions {
  minFinalityThreshold?: number;
  maxFee?: bigint;
  destinationAddress?: Address;
  destinationRpcUrl?: string;
  attestationApiUrl?: string;
}

/** Result of a bridge.burn() operation */
export interface BurnResult {
  burnTxHash: Hash;
  nonce: bigint;
  messageHash: Hex;
  messageBytes: Hex;
  sourceDomain: number;
  destinationDomain: number;
}

/** Circle attestation status */
export type AttestationStatus = "pending_confirmations" | "complete" | "error";

/** Circle IRIS API response for an attestation */
export interface AttestationResponse {
  status: AttestationStatus;
  attestation: Hex | null;
  error?: string;
}

/** Result of the full EVM↔EVM bridge() operation */
export interface BridgeResult {
  burnTxHash: Hash;
  mintTxHash: Hash;
  amount: bigint;
  fromChain: EVMBridgeChain;
  toChain: EVMBridgeChain;
  recipient: Address;
  nonce: bigint;
  elapsedMs: number;
}

/** Error codes for actionable bridge error messages */
export type BridgeErrorCode =
  | "UNSUPPORTED_CHAIN"
  | "INSUFFICIENT_ALLOWANCE"
  | "INSUFFICIENT_BALANCE"
  | "BURN_FAILED"
  | "ATTESTATION_TIMEOUT"
  | "ATTESTATION_ERROR"
  | "MINT_FAILED"
  | "INVALID_AMOUNT"
  | "NO_WALLET_CLIENT";
