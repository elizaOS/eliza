import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';

export class JupiterService extends Service {
  private isRunning = false;
  private connection: Connection | null = null;
  private keypair: Keypair | null = null;
  private registry: Record<number, any> = {};

  static serviceType = 'JUPITER_SERVICE';
  capabilityDescription = 'Provides Jupiter DEX integration for token swaps';

  // Configuration constants
  private readonly CONFIRMATION_CONFIG = {
    MAX_ATTEMPTS: 12,
    INITIAL_TIMEOUT: 2000,
    MAX_TIMEOUT: 20000,
    getDelayForAttempt: (attempt: number) => Math.min(2000 * 1.5 ** attempt, 20000),
  };

  constructor(public runtime: IAgentRuntime) {
    super(runtime);
    this.registry = {};
    console.log('JUPITER_SERVICE cstr');
  }

  // return Jupiter Provider handle
  async registerProvider(provider: any) {
    // add to registry
    const id = Object.values(this.registry).length + 1;
    console.log('registered', provider.name, 'as Jupiter provider #' + id);
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
        `https://public.jupiterapi.com/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&platformFeeBps=200`
      );

      if (!quoteResponse.ok) {
        const error = await quoteResponse.text();
        logger.warn('Quote request failed:', {
          status: quoteResponse.status,
          error,
        });
        throw new Error(`Failed to get quote: ${error}`);
      }

      const quoteData = await quoteResponse.json();
      return quoteData;
    } catch (error) {
      logger.error('Error getting Jupiter quote:', error);
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
      const swapResponse = await fetch('https://public.jupiterapi.com/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      logger.error('Error executing Jupiter swap:', error);
      throw error;
    }
  }

  async confirmTransaction(connection: Connection, signature: string): Promise<boolean> {
    for (let i = 0; i < this.CONFIRMATION_CONFIG.MAX_ATTEMPTS; i++) {
      try {
        const status = await connection.getSignatureStatus(signature);
        if (
          status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized'
        ) {
          return true;
        }

        const delay = this.CONFIRMATION_CONFIG.getDelayForAttempt(i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        logger.warn(`Confirmation check ${i + 1} failed:`, error);

        if (i === this.CONFIRMATION_CONFIG.MAX_ATTEMPTS - 1) {
          throw new Error('Could not confirm transaction status');
        }

        const delay = this.CONFIRMATION_CONFIG.getDelayForAttempt(i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  static async start(runtime: IAgentRuntime) {
    console.log('JUPITER_SERVICE trying to start');
    const service = new JupiterService(runtime);
    await service.start();
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(this.serviceType) as JupiterService;
    if (!service) {
      throw new Error(this.serviceType + ' service not found');
    }
    await service.stop();
  }

  private async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Jupiter service is already running');
      return;
    }
    console.log('JUPITER_SERVICE starting');

    try {
      logger.info('Starting Jupiter service...');
      this.isRunning = true;
      logger.info('Jupiter service started successfully');
    } catch (error) {
      logger.error('Error starting Jupiter service:', error);
      throw error;
    }
  }

  private async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Jupiter service is not running');
      return;
    }

    try {
      logger.info('Stopping Jupiter service...');
      this.isRunning = false;
      logger.info('Jupiter service stopped successfully');
    } catch (error) {
      logger.error('Error stopping Jupiter service:', error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}
