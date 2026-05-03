/**
 * types.ts - Plugin-level types for elizaos-plugin-agentwallet.
 * Where possible, re-exports real SDK types.
 */

export type EvmChain = 'base' | 'base-sepolia' | 'ethereum' | 'arbitrum' | 'polygon';
export type SolanaNetwork = 'mainnet-beta' | 'devnet';

export interface TokenBalance {
  symbol: string;
  address: string;
  balance: string;
  usdValue?: number;
  decimals: number;
}

export interface WalletState {
  address: string;
  chain: 'evm' | 'solana';
  network: string;
  balances: TokenBalance[];
  spendLimitUsd?: number;
  lastUpdated: number;
}

export interface TransferParams {
  toAddress: string;
  amount: string;
  token: string;
  chain?: 'evm' | 'solana';
}

export interface SwapParams {
  fromToken: string;
  toToken: string;
  amount: string;
  slippageBps?: number;
  chain?: 'evm' | 'solana';
}

export interface BridgeParams {
  fromChain: string;
  toChain: string;
  amount: string;
  token: string;
  toAddress?: string;
}

export interface X402PayParams {
  endpoint: string;
  maxAmountUsd: string;
  description?: string;
}

export interface TransferResult {
  txHash: string;
  success: boolean;
}

export interface SwapResult {
  txHash: string;
  outputAmount: string;
}

export interface BridgeResult {
  sourceTxHash: string;
  trackingUrl?: string | null;
}

export interface X402PayResult {
  amountPaid: string;
  httpStatus: number;
  contentType?: string;
}

/** Unified SDK wrapper returned by getSDK() */
export interface AgentWalletSDK {
  evmWallet: unknown | null;
  solanaWallet: unknown | null;
  getBalances(): Promise<TokenBalance[]>;
  getAddress(): string;
  getNetwork(): string;
  transfer(params: TransferParams): Promise<TransferResult>;
  swap(params: SwapParams): Promise<SwapResult>;
  bridge(params: BridgeParams): Promise<BridgeResult>;
  x402Pay(params: X402PayParams): Promise<X402PayResult>;
}
