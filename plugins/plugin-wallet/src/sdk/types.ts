/**
 * @module types
 * Core type definitions for the AgentWallet SDK.
 *
 * Contains shared interfaces, constants, and type utilities used across all
 * SDK modules: spending policies, wallet config, chain identifiers, and
 * value-add diagnostic types (BudgetForecast, WalletHealth, ActivityEntry).
 *
 * Supported chains: Base, Ethereum, Arbitrum, Polygon, Optimism, Avalanche,
 * Unichain, Linea, Sonic, Worldchain, and Base Sepolia (testnet).
 */
import type { JsonValue } from "@elizaos/core";
import type { Address, Hash, Hex } from "viem";

/** Spend policy for a single token */
export interface SpendPolicy {
  token: Address; // address(0) for native ETH
  perTxLimit: bigint; // max single tx amount (0 = no autonomous spending)
  periodLimit: bigint; // max total per rolling window (0 = no autonomous spending)
  periodLength: number; // window duration in seconds (default 86400)
}

/** On-chain spend policy state (includes tracking fields) */
export interface SpendPolicyState extends SpendPolicy {
  periodSpent: bigint;
  periodStart: number;
}

/** A pending over-limit transaction awaiting owner approval */
export interface PendingTx {
  txId: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  token: Address;
  amount: bigint;
  createdAt: number;
  executed: boolean;
  cancelled: boolean;
}

/** Budget remaining for a token */
export interface BudgetStatus {
  token: Address;
  perTxLimit: bigint;
  remainingInPeriod: bigint;
}

/** Result of agentExecute — either executed or queued */
export interface ExecuteResult {
  executed: boolean;
  txHash: Hash;
  pendingTxId?: bigint; // set if queued
}

/** Config for creating an AgentWallet client */
export interface AgentWalletConfig {
  accountAddress: Address;
  chain:
    | "base"
    | "base-sepolia"
    | "ethereum"
    | "arbitrum"
    | "polygon"
    | "optimism"
    | "avalanche"
    | "unichain"
    | "linea"
    | "sonic"
    | "worldchain";
  rpcUrl?: string;
}

/** Event emitted when a transaction exceeds spend limits */
export interface QueuedEvent {
  txId: bigint;
  to: Address;
  value: bigint;
  token: Address;
  amount: bigint;
  blockNumber: bigint | null;
  transactionHash: Hash | null;
}

// ─── [MAX-ADDED] Value-add types for agent customers ───

/** Budget forecast with time-aware remaining capacity */
export interface BudgetForecast {
  token: Address;
  perTxLimit: bigint;
  remainingInPeriod: bigint;
  periodLimit: bigint;
  periodLength: number;
  periodSpent: bigint;
  periodStart: number;
  /** Seconds until the current period resets (budget refills) */
  secondsUntilReset: number;
  /** Percentage of period budget already used (0-100) */
  utilizationPercent: number;
}

/** Wallet health diagnostic snapshot */
export interface WalletHealth {
  /** Wallet contract address */
  address: Address;
  /** NFT token contract bound to this wallet */
  tokenContract: Address;
  /** NFT token ID */
  tokenId: bigint;
  /** Current operator epoch (increments on invalidateAll) */
  operatorEpoch: bigint;
  /** Which operators from the checklist are currently active */
  activeOperators: { address: Address; active: boolean }[];
  /** Number of pending (unexecuted, uncancelled) transactions in queue */
  pendingQueueDepth: number;
  /** Budget status for each requested token */
  budgets: BudgetForecast[];
}

/** A decoded activity log entry from on-chain events */
export interface ActivityEntry {
  type:
    | "execution"
    | "queued"
    | "approved"
    | "cancelled"
    | "policy_update"
    | "operator_update";
  blockNumber: bigint;
  transactionHash: Hash;
  /** Decoded event args (varies by type) */
  args: Record<string, JsonValue>;
}

/** Params for a single transfer in a batch */
export interface BatchTransfer {
  token: Address;
  to: Address;
  amount: bigint;
}

/** Supported chain IDs */
export const CHAIN_IDS = {
  base: 8453,
  "base-sepolia": 84532,
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
  avalanche: 43114,
  unichain: 130,
  linea: 59144,
  sonic: 146,
  worldchain: 480,
} as const;

/** Supported chain name type */
export type SupportedChain = keyof typeof CHAIN_IDS;
