import type { Address, Hash, Hex } from "viem";

/** Mirrors the on-chain TaskStatus enum */
export enum TaskStatus {
  Created = 0,
  Funded = 1,
  Fulfilled = 2,
  Challenged = 3,
  Resolved = 4,
  Cancelled = 5,
}

/** Supported built-in verifier types */
export type VerifierType = "optimistic" | "hash";

/** Parameters for creating a new mutual-stake escrow */
export interface CreateEscrowParams {
  /** Seller/service-provider address */
  seller: Address;
  /** Payment amount in token's smallest unit (e.g., 6 decimals for USDC) */
  paymentAmount: bigint;
  /** Buyer's anti-grief collateral */
  buyerStake: bigint;
  /** Seller's anti-fraud collateral */
  sellerStake: bigint;
  /** Verifier type or custom verifier contract address */
  verifier: VerifierType | Address;
  /** Verifier-specific configuration data (auto-generated for built-in verifiers) */
  verifierData?: Hex;
  /** Challenge window in seconds after fulfillment */
  challengeWindow: number;
  /** Unix timestamp deadline for the task */
  deadline: number;
  /** ERC-20 token address (defaults to USDC on Base) */
  token?: Address;
}

/** Result from creating an escrow */
export interface EscrowCreated {
  /** Address of the deployed StakeVault contract */
  address: Address;
  /** Transaction hash of the factory call */
  txHash: Hash;
}

/** Full escrow details from on-chain */
export interface EscrowDetails {
  buyer: Address;
  seller: Address;
  token: Address;
  paymentAmount: bigint;
  buyerStake: bigint;
  sellerStake: bigint;
  verifier: Address;
  deadline: bigint;
  challengeWindow: bigint;
  status: TaskStatus;
  fulfilledAt: bigint;
}

/** Transaction result */
export interface TxResult {
  txHash: Hash;
}
