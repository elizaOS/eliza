import type { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Interface representing an item with specific properties.
 * @typedef {Object} Item
 * @property {string} name - The name of the item.
 * @property {string} address - The address of the item.
 * @property {string} symbol - The symbol of the item.
 * @property {number} decimals - The number of decimals for the item.
 * @property {string} balance - The balance of the item.
 * @property {string} uiAmount - The UI amount of the item.
 * @property {string} priceUsd - The price of the item in USD.
 * @property {string} valueUsd - The value of the item in USD.
 * @property {string} [valueSol] - Optional value of the item in SOL.
 */
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

/**
 * Defines the interface for storing price information for various cryptocurrencies.
 *
 * @interface Prices
 * @property {Object} solana - Price information for Solana cryptocurrency.
 * @property {string} solana.usd - Price of Solana in USD.
 * @property {Object} bitcoin - Price information for Bitcoin cryptocurrency.
 * @property {string} bitcoin.usd - Price of Bitcoin in USD.
 * @property {Object} ethereum - Price information for Ethereum cryptocurrency.
 * @property {string} ethereum.usd - Price of Ethereum in USD.
 */
export interface Prices {
  solana: { usd: string };
  bitcoin: { usd: string };
  ethereum: { usd: string };
}

/**
 * Interface representing a wallet portfolio.
 * @typedef {Object} WalletPortfolio
 * @property {string} totalUsd - The total value in USD.
 * @property {string} [totalSol] - The total value in SOL (optional).
 * @property {Array<Item>} items - An array of items in the wallet portfolio.
 * @property {Prices} [prices] - Optional prices of the items.
 * @property {number} [lastUpdated] - Timestamp of when the portfolio was last updated (optional).
 */
export interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<Item>;
  prices?: Prices;
  lastUpdated?: number;
}

/**
 * Represents the structure of a Token Account Info object.
 * @typedef {object} TokenAccountInfo
 * @property {PublicKey} pubkey - The public key associated with the token account.
 * @property {object} account - Information about the token account.
 * @property {number} account.lamports - The amount of lamports in the account.
 * @property {object} account.data - Data associated with the account.
 * @property {object} account.data.parsed - Parsed information.
 * @property {object} account.data.parsed.info - Detailed information.
 * @property {string} account.data.parsed.info.mint - The mint associated with the token.
 * @property {string} account.data.parsed.info.owner - The owner of the token.
 * @property {object} account.data.parsed.info.tokenAmount - Token amount details.
 * @property {string} account.data.parsed.info.tokenAmount.amount - The amount of the token.
 * @property {number} account.data.parsed.info.tokenAmount.decimals - The decimals of the token.
 * @property {number} account.data.parsed.info.tokenAmount.uiAmount - The UI amount of the token.
 * @property {string} account.data.parsed.type - The type of parsed data.
 * @property {string} account.data.program - The program associated with the account.
 * @property {number} account.data.space - The space available in the account.
 * @property {string} account.owner - The owner of the account.
 * @property {boolean} account.executable - Indicates if the account is executable.
 * @property {number} account.rentEpoch - The rent epoch of the account.
 */
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

/**
 * API Response types for Solana plugin HTTP routes
 */

// Base response wrapper
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

// GET /wallet/address
export interface WalletAddressResponse {
  publicKey: string;
}

// GET /wallet/balance
export interface WalletBalanceResponse {
  publicKey: string;
  balance: number;
  symbol: string;
}

// GET /wallet/balance/:token
export interface TokenBalanceResponse {
  publicKey: string;
  token: string;
  balance: number;
  decimals: number;
}

// GET /wallet/portfolio
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

// GET /wallet/tokens
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

// ============================================
// Service types
// ============================================

/**
 * Mint balance information for a token.
 */
export interface MintBalance {
  amount: string;
  decimals: number;
  uiAmount: number;
}

/**
 * Parsed token account from Solana RPC.
 */
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
          extensions?: unknown[];
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

/**
 * Jupiter quote response.
 */
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

/**
 * Jupiter swap result.
 */
export interface JupiterSwapResult {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  error?: string;
}

/**
 * Swap execution result.
 */
export interface SwapResult {
  success: boolean;
  signature?: string;
  outAmount?: number;
  fees?: SwapFees;
  error?: string;
}

/**
 * Fees from a swap transaction.
 */
export interface SwapFees {
  totalFee: number;
  platformFee: number;
  networkFee: number;
}

/**
 * Exchange/swap provider interface.
 */
export interface ExchangeProvider {
  name: string;
  getQuote(params: SwapQuoteParams): Promise<JupiterQuote>;
  executeSwap(params: SwapExecuteParams): Promise<SwapResult>;
}

/**
 * Parameters for getting a swap quote.
 */
export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

/**
 * Parameters for executing a swap.
 */
export interface SwapExecuteParams {
  quote: JupiterQuote;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
}

/**
 * Jupiter service interface.
 */
export interface JupiterServiceInterface {
  getQuote(params: SwapQuoteParams): Promise<JupiterQuote>;
  swap(params: SwapExecuteParams): Promise<SwapResult>;
}

/**
 * Extended Jupiter service interface with additional methods used by SolanaService.
 * This extends the base interface with methods that may be provided by Jupiter plugin implementations.
 */
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

/**
 * Trading signal for swap execution.
 */
export interface TradingSignal {
  sourceTokenCA: string;
  targetTokenCA: string;
}

/**
 * Swap execution response for a single wallet.
 */
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

/**
 * WebSocket account notification.
 */
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
          parsed: unknown;
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

/**
 * Cache wrapper with expiration.
 */
export interface CacheWrapper<T> {
  exp: number;
  data: T;
}

/**
 * Token metadata parsed from Token-2022 TLV.
 */
export interface Token2022Metadata {
  isMutable: boolean;
  updateAuthority?: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  additional?: Array<[string, string]>;
}

/**
 * Token supply information.
 */
export interface TokenSupplyInfo {
  supply: bigint;
  decimals: number;
  human: string;
}

/**
 * Birdeye API token price response.
 */
export interface BirdeyePriceResponse {
  success: boolean;
  data: {
    value: number;
    updateUnixTime: number;
    updateHumanTime: string;
  };
}

/**
 * Birdeye API token item in wallet response.
 */
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

/**
 * Birdeye API wallet token list response.
 */
export interface BirdeyeWalletTokenListResponse {
  success: boolean;
  data?: {
    totalUsd: number | string;
    items: BirdeyeWalletTokenItem[];
  };
}

/**
 * Swap wallet entry for batch swaps.
 */
export interface SwapWalletEntry {
  keypair: Keypair;
  amount: number;
}

/**
 * Batch swap result.
 */
export interface BatchSwapResult {
  success: boolean;
  outAmount?: number;
  fees?: SwapFees;
  swapResponse?: JupiterSwapResult;
  error?: string;
}

/**
 * Token account structure from Solana's getParsedTokenAccountsByOwner
 */
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
          extensions?: unknown[];
        };
      };
    };
    owner: PublicKey;
    lamports: number;
  };
}

/**
 * Token metadata cache entry
 */
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

/**
 * Parsed token account result
 */
export interface ParsedTokenResult {
  mint: string;
  symbol: string | null;
  supply: string | number | null;
  tokenProgram: "Token-2022" | "Token";
  decimals: number;
  balanceUi: number;
  isMutable: boolean | null;
}
