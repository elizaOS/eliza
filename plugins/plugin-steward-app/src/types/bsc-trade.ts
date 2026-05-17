/**
 * BSC trade types specific to steward execution flow.
 *
 * This file holds the steward-specific variants that include policy results
 * and approval pending states.
 */

import type { StewardPolicyResult } from "./steward";

export type BscTradeSide = "buy" | "sell";
export type BscTradeRouteProvider = "pancakeswap-v2" | "0x";
export type BscTradeRoutePreference = BscTradeRouteProvider | "auto";

export interface BscTradePreflightRequest {
  tokenAddress?: string;
}

export interface BscTradeReadinessChecks {
  walletReady: boolean;
  rpcReady: boolean;
  chainReady: boolean;
  gasReady: boolean;
  tokenAddressValid: boolean;
}

export interface BscTradePreflightResponse {
  ok: boolean;
  walletAddress: string | null;
  rpcUrlHost: string | null;
  chainId: number | null;
  bnbBalance: string | null;
  minGasBnb: string;
  checks: BscTradeReadinessChecks;
  reasons: string[];
}

export interface BscTradeQuoteRequest {
  side: BscTradeSide;
  tokenAddress: string;
  amount: string;
  slippageBps?: number;
  routeProvider?: BscTradeRoutePreference;
}

export interface BscTradeQuoteLeg {
  symbol: string;
  amount: string;
  amountWei: string;
}

export interface BscTradeQuoteResponse {
  ok: boolean;
  side: BscTradeSide;
  routeProvider: BscTradeRouteProvider;
  routeProviderRequested: BscTradeRoutePreference;
  routeProviderFallbackUsed: boolean;
  routeProviderNotes?: string[];
  routerAddress: string;
  wrappedNativeAddress: string;
  tokenAddress: string;
  slippageBps: number;
  route: string[];
  quoteIn: BscTradeQuoteLeg;
  quoteOut: BscTradeQuoteLeg;
  minReceive: BscTradeQuoteLeg;
  price: string;
  preflight: BscTradePreflightResponse;
  swapTargetAddress?: string;
  swapCallData?: string;
  swapValueWei?: string;
  allowanceTarget?: string;
  quotedAt?: number;
}

export interface BscTradeExecuteRequest {
  side: BscTradeSide;
  tokenAddress: string;
  amount: string;
  slippageBps?: number;
  confirm?: boolean;
  deadlineSeconds?: number;
}

export interface BscUnsignedTradeTx {
  chainId: number;
  from: string | null;
  to: string;
  data: string;
  valueWei: string;
  deadline: number;
  explorerUrl: string;
}

export interface BscUnsignedApprovalTx {
  chainId: number;
  from: string | null;
  to: string;
  data: string;
  valueWei: string;
  explorerUrl: string;
  spender: string;
  amountWei: string;
}

export interface BscTradeExecutionResult {
  hash: string;
  nonce: number;
  gasLimit: string;
  valueWei: string;
  explorerUrl: string;
  blockNumber: number | null;
  status: "success" | "pending";
  approvalHash?: string;
}

export type BscTradeTxStatus = "pending" | "success" | "reverted" | "not_found";

export interface BscTradeTxStatusResponse {
  ok: boolean;
  hash: string;
  status: BscTradeTxStatus;
  explorerUrl: string;
  chainId: number | null;
  blockNumber: number | null;
  confirmations: number;
  nonce: number | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  reason?: string;
}

export interface BscTradeExecuteResponse {
  ok: boolean;
  side: BscTradeSide;
  mode: "local-key" | "user-sign" | "steward";
  quote: BscTradeQuoteResponse;
  executed: boolean;
  requiresUserSignature: boolean;
  unsignedTx: BscUnsignedTradeTx;
  unsignedApprovalTx?: BscUnsignedApprovalTx;
  requiresApproval?: boolean;
  execution?: Omit<BscTradeExecutionResult, "status"> & {
    status?:
      | BscTradeExecutionResult["status"]
      | "pending_approval"
      | "rejected";
    policyResults?: StewardPolicyResult[];
  };
  approval?: {
    status: "pending_approval";
    policyResults?: StewardPolicyResult[];
  };
  error?: string;
}

export interface BscTransferExecuteRequest {
  toAddress: string;
  amount: string;
  assetSymbol: string;
  tokenAddress?: string;
  confirm?: boolean;
}

export interface BscUnsignedTransferTx {
  chainId: number;
  from: string | null;
  to: string;
  data: string;
  valueWei: string;
  explorerUrl: string;
  assetSymbol: string;
  amount: string;
  tokenAddress?: string;
}

export interface BscTransferExecutionResult {
  hash: string;
  nonce: number;
  gasLimit: string;
  valueWei: string;
  explorerUrl: string;
  blockNumber: number | null;
  status: "success" | "pending";
}

export interface BscTransferExecuteResponse {
  ok: boolean;
  mode: "local-key" | "user-sign" | "steward";
  executed: boolean;
  requiresUserSignature: boolean;
  toAddress: string;
  amount: string;
  assetSymbol: string;
  tokenAddress?: string;
  unsignedTx: BscUnsignedTransferTx;
  execution?: Omit<BscTransferExecutionResult, "status"> & {
    status?:
      | BscTransferExecutionResult["status"]
      | "pending_approval"
      | "rejected";
    policyResults?: StewardPolicyResult[];
  };
  error?: string;
}
