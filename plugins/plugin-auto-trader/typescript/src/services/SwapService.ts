import { type IAgentRuntime, logger, parseJSONObjectFromText, Service } from "@elizaos/core";
import {
  Connection,
  Keypair,
  PublicKey,
  type TransactionConfirmationStatus,
  VersionedTransaction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import bs58 from "bs58";

/**
 * Well-known token addresses on Solana
 */
export const KNOWN_TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
} as const;

/**
 * Swap quote from Jupiter API
 */
export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  marketInfos: Array<{
    id: string;
    label: string;
    inputMint: string;
    outputMint: string;
    notEnoughLiquidity: boolean;
    inAmount: string;
    outAmount: string;
    lpFee: { amount: string; mint: string; pct: number };
    platformFee: { amount: string; mint: string; pct: number };
  }>;
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
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
}

/**
 * Parameters for executing a swap
 */
export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  priorityFeeMicroLamports?: number;
}

/**
 * Result of a swap execution
 */
export interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount: string;
  outputAmount: string;
  inputMint: string;
  outputMint: string;
  priceImpact: string;
  explorerUrl?: string;
  error?: string;
}

/**
 * Wallet balance information
 */
export interface WalletBalance {
  solBalance: number;
  tokens: Array<{
    mint: string;
    balance: string;
    decimals: number;
    uiAmount: number;
  }>;
}

/**
 * Configuration for transaction confirmation
 */
const CONFIRMATION_CONFIG = {
  MAX_ATTEMPTS: 12,
  getDelayForAttempt: (attempt: number): number => Math.min(2000 * 1.5 ** attempt, 20000),
};

/**
 * SwapService - Handles token swaps on Solana using Jupiter aggregator
 *
 * This service provides:
 * - Token swap execution via Jupiter
 * - Wallet balance queries
 * - Transaction confirmation with retry logic
 * - Dynamic slippage calculation
 */
export class SwapService extends Service {
  public static readonly serviceType = "SwapService";
  public readonly capabilityDescription =
    "Executes token swaps on Solana via Jupiter DEX aggregator";

  private connection: Connection | null = null;
  private walletKeypair: Keypair | null = null;

  private readonly JUPITER_QUOTE_API = "https://public.jupiterapi.com/quote";
  private readonly JUPITER_SWAP_API = "https://public.jupiterapi.com/swap";

  private decimalsCache = new Map<string, number>([
    [KNOWN_TOKENS.SOL, 9],
    [KNOWN_TOKENS.USDC, 6],
    [KNOWN_TOKENS.USDT, 6],
  ]);

  public static async start(runtime: IAgentRuntime): Promise<SwapService> {
    logger.info(`[${SwapService.serviceType}] Starting...`);
    const instance = new SwapService(runtime);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    logger.info(`[${SwapService.serviceType}] Initializing swap service...`);

    const rpcUrlSetting = this.runtime.getSetting("SOLANA_RPC_URL");
    const rpcUrl =
      typeof rpcUrlSetting === "string" ? rpcUrlSetting : "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");

    const privateKeyString = this.runtime.getSetting("SOLANA_PRIVATE_KEY");
    if (privateKeyString && typeof privateKeyString === "string") {
      const privateKeyBytes = bs58.decode(privateKeyString);
      this.walletKeypair = Keypair.fromSecretKey(privateKeyBytes);
      logger.info(
        `[${SwapService.serviceType}] Wallet configured: ${this.walletKeypair.publicKey.toBase58()}`,
      );
    } else {
      logger.warn(
        `[${SwapService.serviceType}] No wallet private key configured - swaps will fail`,
      );
    }

    logger.info(`[${SwapService.serviceType}] Initialized successfully`);
  }

  public async stop(): Promise<void> {
    logger.info(`[${SwapService.serviceType}] Stopped`);
  }

  /**
   * Check if the service is ready to execute swaps
   */
  public isReady(): boolean {
    return this.connection !== null && this.walletKeypair !== null;
  }

  /**
   * Get the wallet public key
   */
  public getWalletAddress(): string | null {
    return this.walletKeypair?.publicKey.toBase58() ?? null;
  }

  /**
   * Get token decimals from chain or cache
   */
  private async getTokenDecimals(mint: string): Promise<number> {
    if (this.decimalsCache.has(mint)) {
      return this.decimalsCache.get(mint)!;
    }

    if (!this.connection) {
      return 9;
    }

    const mintPubkey = new PublicKey(mint);
    const info = await this.connection.getParsedAccountInfo(mintPubkey);

    if (info.value?.data && "parsed" in info.value.data) {
      const decimals = info.value.data.parsed.info.decimals as number;
      this.decimalsCache.set(mint, decimals);
      return decimals;
    }

    return 9;
  }

  /**
   * Convert token amount to smallest unit (lamports equivalent)
   */
  private async amountToSmallestUnit(mint: string, amount: number): Promise<string> {
    const decimals = await this.getTokenDecimals(mint);
    const smallest = new BigNumber(amount).multipliedBy(new BigNumber(10).pow(decimals));
    return smallest.integerValue(BigNumber.ROUND_FLOOR).toString();
  }

  /**
   * Convert smallest unit back to token amount
   */
  private async smallestUnitToAmount(mint: string, smallest: string): Promise<string> {
    const decimals = await this.getTokenDecimals(mint);
    return new BigNumber(smallest).dividedBy(new BigNumber(10).pow(decimals)).toString();
  }

  /**
   * Calculate dynamic slippage based on trade size and market conditions
   */
  private calculateDynamicSlippage(amount: string, quoteData: SwapQuote): number {
    const baseSlippage = 100; // 1% base
    const priceImpact = Number.parseFloat(quoteData.priceImpactPct || "0");
    const amountNum = Number(amount);

    let dynamicSlippage = baseSlippage;

    // Increase slippage for high price impact
    if (priceImpact > 1) {
      dynamicSlippage += Math.floor(priceImpact * 50);
    }

    // Increase slippage for large amounts
    if (amountNum > 10000) {
      dynamicSlippage = Math.floor(dynamicSlippage * 1.5);
    }

    // Cap at 2.5%
    return Math.min(dynamicSlippage, 250);
  }

  /**
   * Get a swap quote from Jupiter
   */
  public async getQuote(params: SwapParams): Promise<SwapQuote | null> {
    try {
      const amountSmallest = await this.amountToSmallestUnit(params.inputMint, params.amount);
      const slippageBps = params.slippageBps ?? 100;

      const queryParams = new URLSearchParams({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: amountSmallest,
        slippageBps: slippageBps.toString(),
      });

      logger.info(
        `[SwapService] Quote: ${params.amount} ${params.inputMint.slice(0, 8)}... → ${params.outputMint.slice(0, 8)}...`,
      );

      const response = await fetch(`${this.JUPITER_QUOTE_API}?${queryParams.toString()}`);

      if (!response.ok) {
        const errorText = await response.text();
        const parsedError = parseJSONObjectFromText(errorText);

        if (parsedError?.errorCode === "TOKEN_NOT_TRADABLE") {
          logger.error(
            `[${SwapService.serviceType}] Token not tradable: ${String(parsedError.error ?? "unknown error")}`,
          );
          return null;
        }

        logger.error(
          `[${SwapService.serviceType}] Quote request failed: status=${response.status} error=${errorText}`,
        );
        return null;
      }

      const quote = (await response.json()) as SwapQuote;

      const outputAmount = await this.smallestUnitToAmount(params.outputMint, quote.outAmount);
      logger.info(
        `[SwapService] Quote: ${params.amount} → ${outputAmount} (${quote.priceImpactPct}% impact, ${quote.routePlan.length} routes)`,
      );
      return quote;
    } catch (error) {
      logger.error(
        `[${SwapService.serviceType}] Quote fetch error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Execute a swap using Jupiter
   */
  public async executeSwap(params: SwapParams): Promise<SwapResult> {
    const errorResult = (error: string): SwapResult => ({
      success: false,
      inputAmount: params.amount.toString(),
      outputAmount: "0",
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      priceImpact: "0",
      error,
    });

    if (!this.isReady()) {
      return errorResult("Swap service not ready - wallet not configured");
    }

    try {
      const quote = await this.getQuote(params);
      if (!quote) {
        return errorResult("Failed to get quote from Jupiter");
      }

      const dynamicSlippage = this.calculateDynamicSlippage(quote.inAmount, quote);
      logger.info(`[${SwapService.serviceType}] Using dynamic slippage: ${dynamicSlippage} bps`);

      // Get swap transaction from Jupiter
      const swapResponse = await fetch(this.JUPITER_SWAP_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: {
            ...quote,
            slippageBps: dynamicSlippage,
          },
          userPublicKey: this.walletKeypair?.publicKey.toString(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: params.priorityFeeMicroLamports ?? 5000000,
          dynamicComputeUnitLimit: true,
        }),
      });

      if (!swapResponse.ok) {
        const errorText = await swapResponse.text();
        logger.error(
          `[${SwapService.serviceType}] Swap request failed: status=${swapResponse.status} error=${errorText}`,
        );
        return {
          ...errorResult(`Jupiter swap request failed: ${errorText}`),
          outputAmount: await this.smallestUnitToAmount(params.outputMint, quote.outAmount),
          priceImpact: quote.priceImpactPct,
        };
      }

      const swapData = (await swapResponse.json()) as {
        swapTransaction: string;
      };

      if (!swapData?.swapTransaction) {
        logger.error(`[${SwapService.serviceType}] No swap transaction returned`);
        return {
          ...errorResult("No swap transaction returned from Jupiter"),
          outputAmount: await this.smallestUnitToAmount(params.outputMint, quote.outAmount),
          priceImpact: quote.priceImpactPct,
        };
      }

      // Deserialize and sign the transaction
      const transactionBuf = Buffer.from(swapData.swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(transactionBuf);

      // Get fresh blockhash
      const latestBlockhash = await this.connection?.getLatestBlockhash("processed");
      if (!latestBlockhash) {
        throw new Error("Failed to get latest blockhash");
      }
      transaction.message.recentBlockhash = latestBlockhash.blockhash;

      // Sign the transaction
      transaction.sign([this.walletKeypair!]);

      // Send the transaction
      const signature = await this.connection?.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
        preflightCommitment: "processed",
      });

      if (!signature) {
        throw new Error("Failed to send transaction - no signature returned");
      }

      logger.info(
        `[SwapService] Tx sent: ${signature.slice(0, 16)}... (https://solscan.io/tx/${signature})`,
      );

      // Confirm the transaction
      const confirmed = await this.confirmTransaction(signature);

      if (!confirmed) {
        return {
          success: false,
          signature,
          inputAmount: params.amount.toString(),
          outputAmount: await this.smallestUnitToAmount(params.outputMint, quote.outAmount),
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          priceImpact: quote.priceImpactPct,
          explorerUrl: `https://solscan.io/tx/${signature}`,
          error: "Transaction confirmation failed",
        };
      }

      logger.info(
        `[SwapService] Swap complete: ${params.amount} → ${await this.smallestUnitToAmount(params.outputMint, quote.outAmount)}`,
      );

      return {
        success: true,
        signature,
        inputAmount: params.amount.toString(),
        outputAmount: await this.smallestUnitToAmount(params.outputMint, quote.outAmount),
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        priceImpact: quote.priceImpactPct,
        explorerUrl: `https://solscan.io/tx/${signature}`,
      };
    } catch (error) {
      logger.error(
        `[${SwapService.serviceType}] Swap execution error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return errorResult(error instanceof Error ? error.message : "Unknown swap error");
    }
  }

  /**
   * Confirm a transaction with exponential backoff
   */
  private async confirmTransaction(signature: string): Promise<boolean> {
    for (let attempt = 0; attempt < CONFIRMATION_CONFIG.MAX_ATTEMPTS; attempt++) {
      const status = await this.connection?.getSignatureStatus(signature);
      if (!status) continue;

      const confirmationStatus = status.value?.confirmationStatus as
        | TransactionConfirmationStatus
        | undefined;
      if (confirmationStatus === "confirmed" || confirmationStatus === "finalized") {
        logger.info(
          `[SwapService] Confirmed: ${signature.slice(0, 16)}... (${confirmationStatus})`,
        );
        return true;
      }

      const delay = CONFIRMATION_CONFIG.getDelayForAttempt(attempt);
      logger.debug(
        `[${SwapService.serviceType}] Waiting ${delay}ms for confirmation (attempt ${attempt + 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    logger.error(`[${SwapService.serviceType}] Transaction confirmation timed out:`, signature);
    return false;
  }

  /**
   * Get wallet balances including SOL and all SPL tokens
   */
  public async getWalletBalances(): Promise<WalletBalance> {
    if (!this.isReady() || !this.walletKeypair?.publicKey) {
      return { solBalance: 0, tokens: [] };
    }

    const solBalance = await this.connection?.getBalance(this.walletKeypair.publicKey);
    const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

    const tokenAccounts = await this.connection?.getParsedTokenAccountsByOwner(
      this.walletKeypair.publicKey,
      { programId: tokenProgramId },
    );

    if (!tokenAccounts) {
      return { solBalance: (solBalance ?? 0) / 1e9, tokens: [] };
    }

    const tokens = tokenAccounts.value.map((account) => {
      const parsed = account.account.data.parsed.info;
      return {
        mint: parsed.mint as string,
        balance: parsed.tokenAmount.amount as string,
        decimals: parsed.tokenAmount.decimals as number,
        uiAmount: parsed.tokenAmount.uiAmount as number,
      };
    });

    return {
      solBalance: (solBalance ?? 0) / 1e9,
      tokens,
    };
  }

  /**
   * Get balance of a specific token
   */
  public async getTokenBalance(mint: string): Promise<number> {
    const balances = await this.getWalletBalances();

    if (mint === KNOWN_TOKENS.SOL) {
      return balances.solBalance;
    }

    const token = balances.tokens.find((t) => t.mint.toLowerCase() === mint.toLowerCase());
    return token?.uiAmount ?? 0;
  }

  /**
   * Execute a buy (SOL -> Token)
   */
  public async buy(
    tokenMint: string,
    solAmount: number,
    slippageBps?: number,
  ): Promise<SwapResult> {
    return this.executeSwap({
      inputMint: KNOWN_TOKENS.SOL,
      outputMint: tokenMint,
      amount: solAmount,
      slippageBps,
    });
  }

  /**
   * Execute a sell (Token -> SOL)
   */
  public async sell(
    tokenMint: string,
    tokenAmount: number,
    slippageBps?: number,
  ): Promise<SwapResult> {
    return this.executeSwap({
      inputMint: tokenMint,
      outputMint: KNOWN_TOKENS.SOL,
      amount: tokenAmount,
      slippageBps,
    });
  }
}
