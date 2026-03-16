import { Service, logger, type IAgentRuntime } from "@elizaos/core";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import {
  Clmm,
  ClmmPoolInfo,
  Position,
  PositionInfo,
} from "@raydium-io/raydium-sdk";

export class RaydiumService extends Service {
  private isRunning = false;
  private connection: Connection | null = null;
  private keypair: Keypair | null = null;
  private registry: Record<number, any> = {};

  static serviceType = "RAYDIUM_SERVICE";
  capabilityDescription = "Provides Raydium DEX integration for token swaps";

  // Configuration constants
  private readonly CONFIRMATION_CONFIG = {
    MAX_ATTEMPTS: 12,
    INITIAL_TIMEOUT: 2000,
    MAX_TIMEOUT: 20000,
    getDelayForAttempt: (attempt: number) =>
      Math.min(2000 * 1.5 ** attempt, 20000),
  };

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.registry = {};
    console.log("RAYDIUM_SERVICE cstr");
  }

  // return Raydium Provider handle
  async registerProvider(provider: any) {
    // add to registry
    const id = Object.values(this.registry).length + 1;
    console.log("registered", provider.name, "as Raydium provider #" + id);
    this.registry[id] = provider;
    return id;
  }

  async getQuote({
    inputMint,
    outputMint,
    amount,
    slippageBps,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
  }) {
    try {
      const quoteResponse = await fetch(
        `https://api.raydium.io/v2/main/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      );

      if (!quoteResponse.ok) {
        const error = await quoteResponse.text();
        logger.warn("Quote request failed:", {
          status: quoteResponse.status,
          error,
        });
        throw new Error(`Failed to get quote: ${error}`);
      }

      const quoteData = await quoteResponse.json();
      return quoteData;
    } catch (error) {
      logger.error("Error getting Raydium quote:", error);
      throw error;
    }
  }

  async executeSwap({
    quoteResponse,
    userPublicKey,
    slippageBps,
  }: {
    quoteResponse: any;
    userPublicKey: string;
    slippageBps: number;
  }) {
    try {
      const swapResponse = await fetch("https://api.raydium.io/v2/main/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: {
            ...quoteResponse,
            slippageBps,
          },
          userPublicKey,
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: 5000000,
          dynamicComputeUnitLimit: true,
        }),
      });

      if (!swapResponse.ok) {
        const error = await swapResponse.text();
        throw new Error(`Failed to get swap transaction: ${error}`);
      }

      return await swapResponse.json();
    } catch (error) {
      logger.error("Error executing Raydium swap:", error);
      throw error;
    }
  }

  async confirmTransaction(
    connection: Connection,
    signature: string
  ): Promise<boolean> {
    for (let i = 0; i < this.CONFIRMATION_CONFIG.MAX_ATTEMPTS; i++) {
      try {
        const status = await connection.getSignatureStatus(signature);
        if (
          status.value?.confirmationStatus === "confirmed" ||
          status.value?.confirmationStatus === "finalized"
        ) {
          return true;
        }

        const delay = this.CONFIRMATION_CONFIG.getDelayForAttempt(i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        logger.warn(`Confirmation check ${i + 1} failed:`, error);

        if (i === this.CONFIRMATION_CONFIG.MAX_ATTEMPTS - 1) {
          throw new Error("Could not confirm transaction status");
        }

        const delay = this.CONFIRMATION_CONFIG.getDelayForAttempt(i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  // Get token price in USDC
  async getTokenPrice(
    tokenMint: string,
    quoteMint: string = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inputDecimals: number = 6
  ): Promise<number> {
    try {
      const baseAmount = 10 ** inputDecimals;
      const quote = await this.getQuote({
        inputMint: tokenMint,
        outputMint: quoteMint,
        amount: baseAmount, // Dynamic amount based on token decimals
        slippageBps: 50,
      });
      return Number(quote.outAmount) / 10 ** inputDecimals; // Convert using same decimals
    } catch (error) {
      logger.error("Failed to get token price:", error);
      return 0;
    }
  }

  // Get best swap route
  async getBestRoute({
    inputMint,
    outputMint,
    amount,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }) {
    try {
      const quote = await this.getQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps: 50,
      });
      return quote.routePlan;
    } catch (error) {
      logger.error("Failed to get best route:", error);
      throw error;
    }
  }

  async getPriceImpact({
    inputMint,
    outputMint,
    amount,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<number> {
    try {
      const quote = await this.getQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps: 50,
      });
      return Number(quote.priceImpactPct);
    } catch (error) {
      logger.error("Failed to get price impact:", error);
      throw error;
    }
  }

  async getMinimumReceived({
    inputMint,
    outputMint,
    amount,
    slippageBps,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
  }): Promise<number> {
    try {
      const quote = await this.getQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps,
      });
      // Calculate minimum received based on slippage
      const minReceived = Number(quote.outAmount) * (1 - slippageBps / 10000);
      return minReceived;
    } catch (error) {
      logger.error("Failed to calculate minimum received:", error);
      throw error;
    }
  }

  async estimateGasFees({
    inputMint,
    outputMint,
    amount,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<{ lamports: number; sol: number }> {
    try {
      const quote = await this.getQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps: 50,
      });
      const estimatedFee = quote.otherAmountThreshold || 5000; // Default to 5000 lamports if not provided
      return {
        lamports: estimatedFee,
        sol: estimatedFee / 1e9, // Convert lamports to SOL
      };
    } catch (error) {
      logger.error("Failed to estimate gas fees:", error);
      throw error;
    }
  }

  async findBestSlippage({
    inputMint,
    outputMint,
    amount,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<number> {
    try {
      const quote = await this.getQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps: 50,
      });

      // Calculate optimal slippage based on liquidity and price impact
      const priceImpact = Number(quote.priceImpactPct);
      let recommendedSlippage: number;

      if (priceImpact < 0.5) {
        recommendedSlippage = 50; // 0.5%
      } else if (priceImpact < 1) {
        recommendedSlippage = 100; // 1%
      } else {
        recommendedSlippage = 200; // 2%
      }

      return recommendedSlippage;
    } catch (error) {
      logger.error("Failed to find best slippage:", error);
      throw error;
    }
  }

  async getTokenPair({
    inputMint,
    outputMint,
  }: {
    inputMint: string;
    outputMint: string;
  }): Promise<{
    inputToken: any;
    outputToken: any;
    liquidity: number;
    volume24h: number;
  }> {
    try {
      // Fetch token pair information from Jupiter API
      const response = await fetch(
        `https://api.raydium.io/v2/main/pairs/${inputMint}/${outputMint}`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch token pair data");
      }

      return await response.json();
    } catch (error) {
      logger.error("Failed to get token pair information:", error);
      throw error;
    }
  }

  async getHistoricalPrices({
    inputMint,
    outputMint,
    timeframe = "24h", // Options: 1h, 24h, 7d, 30d
  }: {
    inputMint: string;
    outputMint: string;
    timeframe?: string;
  }): Promise<Array<{ timestamp: number; price: number }>> {
    try {
      // Fetch historical price data from Jupiter API
      const response = await fetch(
        `https://api.raydium.io/v2/main/prices/${inputMint}/${outputMint}?timeframe=${timeframe}`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch historical prices");
      }

      return await response.json();
    } catch (error) {
      logger.error("Failed to get historical prices:", error);
      throw error;
    }
  }

  async findArbitragePaths({
    startingMint,
    amount,
    maxHops = 3,
  }: {
    startingMint: string;
    amount: number;
    maxHops?: number;
  }): Promise<
    Array<{
      path: string[];
      expectedReturn: number;
      priceImpact: number;
    }>
  > {
    try {
      // Common tokens to check for arbitrage
      const commonTokens = [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        "So11111111111111111111111111111111111111112", // SOL
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
      ];

      const paths: Array<{
        path: string[];
        expectedReturn: number;
        priceImpact: number;
      }> = [];

      // Find potential arbitrage paths
      for (const token1 of commonTokens) {
        if (token1 === startingMint) continue;

        const quote1 = await this.getQuote({
          inputMint: startingMint,
          outputMint: token1,
          amount,
          slippageBps: 50,
        });

        for (const token2 of commonTokens) {
          if (token2 === token1 || token2 === startingMint) continue;

          const quote2 = await this.getQuote({
            inputMint: token1,
            outputMint: token2,
            amount: Number(quote1.outAmount),
            slippageBps: 50,
          });

          const finalQuote = await this.getQuote({
            inputMint: token2,
            outputMint: startingMint,
            amount: Number(quote2.outAmount),
            slippageBps: 50,
          });

          const expectedReturn = Number(finalQuote.outAmount) - amount;
          const totalPriceImpact =
            Number(quote1.priceImpactPct) +
            Number(quote2.priceImpactPct) +
            Number(finalQuote.priceImpactPct);

          if (expectedReturn > 0) {
            paths.push({
              path: [startingMint, token1, token2, startingMint],
              expectedReturn,
              priceImpact: totalPriceImpact,
            });
          }
        }
      }

      // Sort by expected return (highest first)
      return paths.sort((a, b) => b.expectedReturn - a.expectedReturn);
    } catch (error) {
      logger.error("Failed to find arbitrage paths:", error);
      throw error;
    }
  }

  async getPositions(
    connection: Connection,
    ownerAddress: PublicKey
  ): Promise<PositionInfo[]> {
    try {
      const positions = await Position.getPositionsByOwner(
        connection,
        ownerAddress
      );
      return positions;
    } catch (error) {
      logger.error("Error fetching positions:", error);
      throw error;
    }
  }

  async createPosition(
    connection: Connection,
    pool: ClmmPoolInfo,
    owner: PublicKey,
    lowerTick: number,
    upperTick: number,
    tokenAmountA: bigint,
    tokenAmountB: bigint
  ) {
    try {
      const positionInfo = await Position.create({
        connection,
        poolId: pool.id,
        ownerInfo: {
          wallet: owner,
          tokenAccountA: pool.tokenAccountA,
          tokenAccountB: pool.tokenAccountB,
        },
        tickLower: lowerTick,
        tickUpper: upperTick,
        tokenAmountA,
        tokenAmountB,
      });

      return positionInfo;
    } catch (error) {
      logger.error("Error creating position:", error);
      throw error;
    }
  }

  async closePosition(
    connection: Connection,
    positionInfo: PositionInfo,
    owner: PublicKey
  ) {
    try {
      const closePositionTx = await Position.close({
        connection,
        positionId: positionInfo.id,
        owner,
      });

      return closePositionTx;
    } catch (error) {
      logger.error("Error closing position:", error);
      throw error;
    }
  }

  async updatePosition(
    connection: Connection,
    positionInfo: PositionInfo,
    owner: PublicKey,
    liquidityDelta: bigint
  ) {
    try {
      const updatePositionTx = await Position.update({
        connection,
        positionId: positionInfo.id,
        owner,
        liquidityDelta,
      });

      return updatePositionTx;
    } catch (error) {
      logger.error("Error updating position:", error);
      throw error;
    }
  }

  static async start(runtime: IAgentRuntime) {
    console.log("RAYDIUM_SERVICE trying to start");
    const service = new RaydiumService(runtime);
    await service.start();
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(this.serviceType) as RaydiumService;
    if (!service) {
      throw new Error(this.serviceType + " service not found");
    }
    await service.stop();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Raydium service is already running");
      return;
    }
    console.log("RAYDIUM_SERVICE starting");

    try {
      logger.info("Starting Raydium service...");
      this.isRunning = true;
      logger.info("Raydium service started successfully");
    } catch (error) {
      logger.error("Error starting Raydium service:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("Raydium service is not running");
      return;
    }

    try {
      logger.info("Stopping Raydium service...");
      this.isRunning = false;
      logger.info("Raydium service stopped successfully");
    } catch (error) {
      logger.error("Error stopping Raydium service:", error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}
