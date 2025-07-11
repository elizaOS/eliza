import {
  init_env,
  ftGetTokenMetadata,
  estimateSwap,
  instantSwap,
  fetchAllPools,
  type TokenMetadata,
} from '@ref-finance/ref-sdk';
import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import BigNumber from 'bignumber.js';
import { BaseNearService } from './base/BaseService';
import { WalletService } from './WalletService';
import { TransactionService } from './TransactionService';
import { NearPluginError, NearErrorCode, handleNearError } from '../core/errors';
import type { SwapParams, SwapQuote, SwapRoute, TransactionResult } from '../core/types';
import {
  GAS_LIMITS,
  DEFAULTS,
  FT_MINIMUM_STORAGE_BALANCE_LARGE,
  ONE_YOCTO_NEAR,
} from '../core/constants';

export class SwapService extends BaseNearService {
  capabilityDescription = 'Handles token swaps on Ref Finance';

  private walletService!: WalletService;
  private transactionService!: TransactionService;
  private initialized = false;

  async onInitialize(): Promise<void> {
    // Get required services
    this.walletService = this.runtime.getService('near-wallet' as any) as WalletService;
    this.transactionService = this.runtime.getService(
      'near-transaction' as any
    ) as TransactionService;

    if (!this.walletService || !this.transactionService) {
      throw new NearPluginError(NearErrorCode.INVALID_CONFIG, 'Required services not available');
    }

    // Initialize Ref SDK
    const network = this.walletService.getNetwork();
    init_env(network);
    this.initialized = true;

    elizaLogger.info(`SwapService initialized for ${network}`);
  }

  /**
   * Get a quote for a token swap
   */
  async getQuote(params: SwapParams): Promise<SwapQuote> {
    try {
      if (!this.initialized) {
        throw new NearPluginError(NearErrorCode.INVALID_CONFIG, 'SwapService not initialized');
      }

      // Get token metadata
      const [tokenIn, tokenOut] = await Promise.all([
        ftGetTokenMetadata(params.inputTokenId),
        ftGetTokenMetadata(params.outputTokenId),
      ]);

      // Get pools
      const { simplePools } = await fetchAllPools();

      // Estimate swap
      const swapTodos = await estimateSwap({
        tokenIn,
        tokenOut,
        amountIn: params.amount,
        simplePools,
        options: {
          enableSmartRouting: true,
        },
      });

      if (!swapTodos || swapTodos.length === 0) {
        throw new NearPluginError(NearErrorCode.NO_SWAP_ROUTE, 'No valid swap route found');
      }

      // Calculate output amount and price impact
      const outputAmount = this.calculateOutputAmount(swapTodos);
      const priceImpact = this.calculatePriceImpact(params.amount, outputAmount, tokenIn, tokenOut);

      const slippage =
        params.slippageTolerance ||
        Number(this.runtime.getSetting('NEAR_SLIPPAGE')) ||
        DEFAULTS.SLIPPAGE;

      const minimumReceived = new BigNumber(outputAmount).times(1 - slippage).toFixed(0);

      const route: SwapRoute = {
        inputToken: {
          id: tokenIn.id,
          symbol: tokenIn.symbol,
          name: tokenIn.name,
          decimals: tokenIn.decimals,
          icon: tokenIn.icon,
        },
        outputToken: {
          id: tokenOut.id,
          symbol: tokenOut.symbol,
          name: tokenOut.name,
          decimals: tokenOut.decimals,
          icon: tokenOut.icon,
        },
        inputAmount: params.amount,
        outputAmount,
        priceImpact,
        route: this.extractRoute(swapTodos),
        fee: this.calculateTotalFee(swapTodos),
      };

      return {
        route,
        slippage,
        minimumReceived,
        priceImpact,
        fee: route.fee,
        expires: Date.now() + 60000, // Quote valid for 1 minute
      };
    } catch (error) {
      throw handleNearError(error);
    }
  }

  /**
   * Execute a token swap
   */
  async executeSwap(params: SwapParams): Promise<TransactionResult> {
    try {
      // Get quote first
      const quote = await this.getQuote(params);

      // Validate slippage
      if (quote.priceImpact > DEFAULTS.MAX_SLIPPAGE) {
        throw new NearPluginError(
          NearErrorCode.SLIPPAGE_EXCEEDED,
          `Price impact too high: ${(quote.priceImpact * 100).toFixed(2)}%`,
          { priceImpact: quote.priceImpact },
          true
        );
      }

      // Get account
      const account = await this.walletService.getAccount();
      const accountId = this.walletService.getAddress();

      // Get token metadata again for swap
      const [tokenIn, tokenOut] = await Promise.all([
        ftGetTokenMetadata(params.inputTokenId),
        ftGetTokenMetadata(params.outputTokenId),
      ]);

      // Get pools
      const { simplePools } = await fetchAllPools();

      // Get swap todos
      const swapTodos = await estimateSwap({
        tokenIn,
        tokenOut,
        amountIn: params.amount,
        simplePools,
        options: {
          enableSmartRouting: true,
        },
      });

      // Generate transactions
      const transactions = await instantSwap({
        tokenIn,
        tokenOut,
        amountIn: params.amount,
        swapTodos,
        slippageTolerance: params.slippageTolerance || quote.slippage,
        AccountId: accountId,
      });

      // Check storage deposits
      const storageChecks = await Promise.all([
        this.checkStorageBalance(account, params.inputTokenId),
        this.checkStorageBalance(account, params.outputTokenId),
      ]);

      // Add storage deposits if needed
      if (!storageChecks[0]) {
        transactions.unshift({
          receiverId: params.inputTokenId,
          functionCalls: [
            {
              methodName: 'storage_deposit',
              args: {
                account_id: accountId,
                registration_only: true,
              },
              gas: GAS_LIMITS.STORAGE_DEPOSIT,
              amount: FT_MINIMUM_STORAGE_BALANCE_LARGE,
            },
          ],
        });
      }

      if (!storageChecks[1]) {
        transactions.unshift({
          receiverId: params.outputTokenId,
          functionCalls: [
            {
              methodName: 'storage_deposit',
              args: {
                account_id: accountId,
                registration_only: true,
              },
              gas: GAS_LIMITS.STORAGE_DEPOSIT,
              amount: FT_MINIMUM_STORAGE_BALANCE_LARGE,
            },
          ],
        });
      }

      // Execute transactions
      elizaLogger.info(`Swapping ${params.amount} ${tokenIn.symbol} for ${tokenOut.symbol}`);

      const results = [];
      for (const tx of transactions) {
        for (const functionCall of tx.functionCalls) {
          const result = await account.functionCall({
            contractId: tx.receiverId,
            methodName: functionCall.methodName,
            args: functionCall.args,
            gas: BigInt(functionCall.gas || '100000000000000'),
            attachedDeposit: BigInt(
              functionCall.amount === ONE_YOCTO_NEAR ? '1' : functionCall.amount || '0'
            ),
          });
          results.push(result);
        }
      }

      // Return the last transaction result (the actual swap)
      const swapResult = results[results.length - 1];
      const txHash = swapResult.transaction.hash;

      return {
        transactionHash: txHash,
        blockHash: (swapResult.transaction_outcome as any).block_hash || '',
        outcome: swapResult,
        explorerUrl: this.walletService.getExplorerUrl(txHash),
        success: true,
      };
    } catch (error) {
      throw handleNearError(error);
    }
  }

  /**
   * Check storage balance for a token
   */
  private async checkStorageBalance(account: any, contractId: string): Promise<boolean> {
    try {
      const balance = (await account.viewFunction({
        contractId,
        methodName: 'storage_balance_of',
        args: { account_id: account.accountId },
      })) as { total: string } | null;

      return balance !== null && balance.total !== '0';
    } catch (error) {
      elizaLogger.debug(`Error checking storage balance: ${error}`);
      return false;
    }
  }

  /**
   * Calculate output amount from swap todos
   */
  private calculateOutputAmount(swapTodos: any[]): string {
    if (!swapTodos || swapTodos.length === 0) {
      return '0';
    }

    // Get the final output amount from the last swap
    const lastSwap = swapTodos[swapTodos.length - 1];
    return lastSwap.estimate || '0';
  }

  /**
   * Calculate price impact
   */
  private calculatePriceImpact(
    inputAmount: string,
    outputAmount: string,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata
  ): number {
    // Simplified price impact calculation
    // In production, this would use pool reserves and proper calculations
    const inputValue = new BigNumber(inputAmount).div(new BigNumber(10).pow(tokenIn.decimals));
    const outputValue = new BigNumber(outputAmount).div(new BigNumber(10).pow(tokenOut.decimals));

    // For now, estimate based on amount size
    // Large trades have higher impact
    const impactFactor = inputValue.toNumber() / 1000; // Per 1000 units
    return Math.min(impactFactor * 0.001, 0.1); // Max 10% impact
  }

  /**
   * Extract route from swap todos
   */
  private extractRoute(swapTodos: any[]): string[] {
    const route: string[] = [];

    for (const todo of swapTodos) {
      if (todo.inputToken) {
        route.push(todo.inputToken);
      }
      if (todo.outputToken) {
        route.push(todo.outputToken);
      }
    }

    // Remove duplicates while preserving order
    return [...new Set(route)];
  }

  /**
   * Calculate total fee from swap todos
   */
  private calculateTotalFee(swapTodos: any[]): number {
    // Ref Finance typically charges 0.3% per swap
    return swapTodos.length * 0.003;
  }

  async checkHealth(): Promise<void> {
    // Check if we can fetch pools
    try {
      await fetchAllPools();
    } catch (error) {
      throw new NearPluginError(NearErrorCode.RPC_ERROR, 'Failed to fetch pools', error);
    }
  }

  protected async onCleanup(): Promise<void> {
    // No cleanup needed
  }

  static async start(runtime: IAgentRuntime): Promise<SwapService> {
    const service = new SwapService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}
