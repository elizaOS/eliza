import { type ContractTransactionResponse, type TransactionResponse, type TransactionReceipt as EthersTransactionReceipt, type Log as EthersLog } from 'ethers';

// Define supported chain types for the Polygon plugin
export type SupportedChain = string; // Or a more specific union like 'mainnet' | 'mumbai'

// Network type to distinguish between Ethereum (L1) and Polygon (L2)
export type NetworkType = 'L1' | 'L2';

// Address type compatible with both ethers and viem
export type Address = `0x${string}`;

// Hash type for transaction and block hashes
export type Hash = `0x${string}`;

// Transaction types that match viem's patterns but work with our dual-network approach
export interface Transaction {
  hash: Hash;
  from: Address;
  to: Address;
  value: bigint;
  data?: Hash;
  chainId: number;
}

// Block identifier type for getBlock functions
export type BlockIdentifier = number | Hash;

// Basic block information returned by getBlock
export interface BlockInfo {
  number: number;
  hash: Hash;
  parentHash: Hash;
  timestamp: bigint;
  nonce?: string;
  difficulty?: bigint;
  gasLimit: bigint;
  gasUsed: bigint;
  miner: Address;
  extraData?: string;
  baseFeePerGas?: bigint;
  transactions: Hash[] | TransactionInfo[];
}

// Transaction information returned by getTransaction
export interface TransactionInfo {
  hash: Hash;
  blockHash: Hash | null;
  blockNumber: number | null;
  from: Address;
  to: Address | null;
  value: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gas: bigint;
  input: Hash;
  nonce: number;
  transactionIndex: number | null;
}

// Use ethers TransactionReceipt type as a base and extend it
export interface TransactionReceipt extends Omit<EthersTransactionReceipt, 'logs'> {
  logs: Log[];
}

// Use ethers Log type
export type Log = EthersLog;

// Combined transaction details returned by getTransactionDetails
export interface TransactionDetails {
  transaction: TransactionInfo | null;
  receipt: TransactionReceipt | null;
}

// Balance information for tokens
export interface TokenBalance {
  address: Address;
  tokenAddress?: Address;
  balance: bigint;
  formattedBalance: string;
  decimals: number;
  symbol?: string;
}

// ERC20 token information
export interface TokenInfo {
  address: Address;
  name?: string;
  symbol?: string;
  decimals: number;
  totalSupply?: bigint;
  chainId: number;
}

// Gas price estimates
export interface GasPriceInfo {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface GasPriceEstimates {
  safeLow?: GasPriceInfo;
  average?: GasPriceInfo;
  fast?: GasPriceInfo;
  estimatedBaseFee?: bigint;
  fallbackGasPrice?: bigint;
}

// Call parameters for contract interactions
export interface ContractCallParams {
  to: Address;
  data: Hash;
  value?: bigint;
  from?: Address;
}

// Transaction parameters for sending transactions
export interface TransactionParams {
  to: Address;
  value?: bigint;
  data?: Hash;
  nonce?: number;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

// Cache entry for storing data with timestamps
export interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

// RPC error information
export interface RpcError extends Error {
  code?: number;
  data?: unknown;
}
