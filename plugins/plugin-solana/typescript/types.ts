import type { Keypair, PublicKey } from "@solana/web3.js";

export interface Item {
  name: string;
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  uiAmount: string;
  priceUsd: string;
  valueUsd: string;
  valueSol?: string;
}

export interface Prices {
  solana: { usd: string };
  bitcoin: { usd: string };
  ethereum: { usd: string };
}

export interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<Item>;
  prices?: Prices;
  lastUpdated?: number;
}

export interface TokenAccountInfo {
  pubkey: PublicKey;
  account: {
    lamports: number;
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
          };
        };
        type: string;
      };
      program: string;
      space: number;
    };
    owner: string;
    executable: boolean;
    rentEpoch: number;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: string;
}

export interface WalletAddressResponse {
  publicKey: string;
}

export interface WalletBalanceResponse {
  publicKey: string;
  balance: number;
  symbol: string;
}

export interface TokenBalanceResponse {
  publicKey: string;
  token: string;
  balance: number;
  decimals: number;
}

export interface WalletPortfolioResponse {
  publicKey: string;
  totalUsd: string;
  totalSol: string;
  tokens: PortfolioTokenResponse[];
  prices?: {
    solana: number;
    bitcoin: number;
    ethereum: number;
  };
  lastUpdated?: string;
  hasBirdeyeData: boolean;
}

export interface PortfolioTokenResponse {
  name: string;
  symbol: string;
  address: string;
  balance: string;
  decimals: number;
  priceUsd: string;
  valueUsd: string;
  valueSol: string;
}

export interface WalletTokensResponse {
  publicKey: string;
  tokens: TokenAccountResponse[];
  count: number;
}

export interface TokenAccountResponse {
  mint: string;
  balance: number;
  decimals: number;
  amount: string;
}

export interface MintBalance {
  amount: string;
  decimals: number;
  uiAmount: number;
}

export interface ParsedTokenAccount {
  pubkey: PublicKey;
  account: {
    lamports: number;
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
            uiAmountString?: string;
          };
          isNative?: boolean;
          state?: string;
          extensions?: Array<Record<string, string | number | boolean>>;
        };
        type: string;
      };
      program: string;
      space: number;
    };
    owner: PublicKey | string;
    executable: boolean;
    rentEpoch: number;
  };
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | {
    amount: string;
    feeBps: number;
  };
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapResult {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  error?: string;
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  outAmount?: number;
  fees?: SwapFees;
  error?: string;
}

export interface SwapFees {
  totalFee: number;
  platformFee: number;
  networkFee: number;
}

export interface ExchangeProvider {
  name: string;
  getQuote(params: SwapQuoteParams): Promise<JupiterQuote>;
  executeSwap(params: SwapExecuteParams): Promise<SwapResult>;
}

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

export interface SwapExecuteParams {
  quote: JupiterQuote;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
}

export interface JupiterServiceInterface {
  getQuote(params: SwapQuoteParams): Promise<JupiterQuote>;
  swap(params: SwapExecuteParams): Promise<SwapResult>;
}

export interface ExtendedJupiterServiceInterface extends JupiterServiceInterface {
  getPriceImpact?(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<number>;
  findBestSlippage?(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<number>;
  estimateLamportsNeeded?(params: { inputMint: string; inAmount: number }): number;
  executeSwap?(params: {
    quoteResponse: JupiterQuote;
    userPublicKey: string;
    slippageBps: number;
  }): Promise<JupiterSwapResult>;
  estimateGasFees?(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<SwapFees>;
}

export interface TradingSignal {
  sourceTokenCA: string;
  targetTokenCA: string;
}

export interface SwapExecutionResponse {
  success: boolean;
  outAmount?: string;
  outDecimal?: number;
  signature?: string;
  fees?: {
    lamports: number;
    sol: number;
  };
  swapResponse?: JupiterSwapResult;
  error?: string;
}

export interface AccountNotification {
  context: {
    slot: number;
  };
  value: {
    lamports: number;
    data:
      | string
      | Buffer
      | {
          parsed: Record<string, string | number | boolean | null>;
          program: string;
          space: number;
        };
    owner: string;
    executable: boolean;
    rentEpoch: number;
  };
}

/**
 * WebSocket subscription handler.
 */
export type SubscriptionHandler = (notification: AccountNotification) => void | Promise<void>;

export interface CacheWrapper<T> {
  exp: number;
  data: T;
}

export interface Token2022Metadata {
  isMutable: boolean;
  updateAuthority?: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  additional?: Array<[string, string]>;
}

export interface TokenSupplyInfo {
  supply: bigint;
  decimals: number;
  human: string;
}

export interface BirdeyePriceResponse {
  success: boolean;
  data: {
    value: number;
    updateUnixTime: number;
    updateHumanTime: string;
  };
}

export interface BirdeyeWalletTokenItem {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  balance?: string;
  balanceUsd?: number;
  priceUsd?: string;
  valueUsd?: string;
  uiAmount?: string;
}

export interface BirdeyeWalletTokenListResponse {
  success: boolean;
  data?: {
    totalUsd: number | string;
    items: BirdeyeWalletTokenItem[];
  };
}

export interface SwapWalletEntry {
  keypair: Keypair;
  amount: number;
}

export interface BatchSwapResult {
  success: boolean;
  outAmount?: number;
  fees?: SwapFees;
  swapResponse?: JupiterSwapResult;
  error?: string;
}

export interface TokenAccountEntry {
  pubkey: PublicKey;
  account: {
    data: {
      program: string;
      parsed: {
        type: string;
        info: {
          mint: string;
          owner: string;
          state: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
            uiAmountString: string;
          };
          isNative?: boolean;
          extensions?: Array<Record<string, string | number | boolean>>;
        };
      };
    };
    owner: PublicKey;
    lamports: number;
  };
}

export interface TokenMetaCacheEntry {
  setAt: number;
  data: {
    symbol: string | null;
    supply: string | number | null;
    tokenProgram: string;
    decimals: number;
    isMutable: boolean | null;
  };
}

export interface ParsedTokenResult {
  mint: string;
  symbol: string | null;
  supply: string | number | null;
  tokenProgram: "Token-2022" | "Token";
  decimals: number;
  balanceUi: number;
  isMutable: boolean | null;
}
