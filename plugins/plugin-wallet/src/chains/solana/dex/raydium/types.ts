/**
 * Quote/swap request-response shapes consumed by `RaydiumService`. Named
 * `Jupiter*` because they mirror the Jupiter aggregator quote API shape, not
 * because Raydium calls Jupiter — `RaydiumService` hits `api.raydium.io`
 * directly and parses responses into these types.
 */
export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps: number;
}

/** Minimal Jupiter route step shape used by swap quotes */
export interface JupiterRoutePlanSwapInfo {
  ammKey?: string;
  label?: string;
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
}

export interface JupiterRoutePlanStep {
  swapInfo?: JupiterRoutePlanSwapInfo;
  percent?: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapParams {
  quoteResponse: JupiterQuoteResponse;
  userPublicKey: string;
  slippageBps: number;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}
