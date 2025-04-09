import { type AgentRuntime, logger } from '@elizaos/core';
import { executeTrade } from '../../utils/wallet';
import { WalletService } from '../walletService';
import { DataService } from '../dataService';
import { AnalyticsService } from '../analyticsService';

export class TradeExecutionService {
  constructor(
    private runtime: AgentRuntime,
    private walletService: WalletService,
    private dataService: DataService,
    private analyticsService: AnalyticsService
  ) {}

  async initialize(): Promise<void> {
    logger.info('Initializing trade execution service');
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  async executeBuyTrade({
    tokenAddress,
    amount,
    slippage,
  }: {
    tokenAddress: string;
    amount: number;
    slippage: number;
  }): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    outAmount?: string;
  }> {
    try {
      const result = await executeTrade(this.runtime, {
        tokenAddress,
        amount,
        slippage,
        dex: 'raydium',
        action: 'BUY',
      });

      if (result.success) {
        await this.analyticsService.trackTradeExecution({
          type: 'buy',
          tokenAddress,
          amount: amount.toString(),
          signature: result.signature!,
        });
      }

      return result;
    } catch (error) {
      logger.error('Buy trade execution failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async executeSellTrade({
    tokenAddress,
    amount,
    slippage,
  }: {
    tokenAddress: string;
    amount: number;
    slippage: number;
  }): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    receivedAmount?: string;
  }> {
    try {
      const result = await executeTrade(this.runtime, {
        tokenAddress,
        amount,
        slippage,
        dex: 'raydium',
        action: 'SELL',
      });

      if (result.success) {
        await this.analyticsService.trackTradeExecution({
          type: 'sell',
          tokenAddress,
          amount: amount.toString(),
          signature: result.signature!,
        });
      }

      return result;
    } catch (error) {
      logger.error('Sell trade execution failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async calculateExpectedAmount(
    tokenAddress: string,
    amount: number,
    isSell: boolean
  ): Promise<string> {
    try {
      const marketData = await this.dataService.getTokenMarketData(tokenAddress);
      const expectedAmount = isSell ? amount * marketData.price : amount / marketData.price;

      return expectedAmount.toString();
    } catch (error) {
      logger.error('Error calculating expected amount:', error);
      return '0';
    }
  }
}
