import { type IAgentRuntime, logger } from '@elizaos/core';
import { getTokenBalance } from '../utils/wallet';
import { DataService } from './dataService';
import { TradeExecutionService } from './execution/tradeExecutionService';
import { WalletService } from './walletService';
import { AnalyticsService } from './analyticsService';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIG } from '../config/config';

export class MonitoringService extends TradeExecutionService {
  private isInitialized = false;
  private monitoringIntervals: NodeJS.Timeout[] = [];
  private tradingConfig = DEFAULT_CONFIG;

  constructor(
    runtime: IAgentRuntime,
    dataService: DataService,
    walletService: WalletService,
    analyticsService: AnalyticsService
  ) {
    super(runtime, walletService, dataService, analyticsService);
  }

  // Implement TradeExecutionService interface methods
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
    // Monitoring service doesn't execute trades directly
    return {
      success: false,
      error: 'Monitoring service does not execute trades directly',
    };
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
    // Monitoring service doesn't execute trades directly
    return {
      success: false,
      error: 'Monitoring service does not execute trades directly',
    };
  }

  async calculateExpectedAmount(
    tokenAddress: string,
    amount: number,
    isSell: boolean
  ): Promise<string> {
    // Delegate to data service for calculations
    const marketData = await this.dataService.getTokenMarketData(tokenAddress);
    const expectedAmount = isSell ? amount * marketData.price : amount / marketData.price;
    return expectedAmount.toString();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Monitoring service already initialized');
      return;
    }

    logger.info('Initializing monitoring service...');

    // Start monitoring intervals
    this.startMonitoringIntervals();

    this.isInitialized = true;
    logger.info('Monitoring service initialized successfully');
  }

  async stop(): Promise<void> {
    logger.info('Stopping monitoring service...');

    // Clear all monitoring intervals
    this.monitoringIntervals.forEach((interval) => clearInterval(interval));
    this.monitoringIntervals = [];

    this.isInitialized = false;
    logger.info('Monitoring service stopped successfully');
  }

  private startMonitoringIntervals(): void {
    // Add monitoring intervals here
    const priceMonitorInterval = setInterval(() => {
      this.monitorPrices().catch((error) => console.log('Price monitoring error:', error));
    }, 60000); // Every minute

    this.monitoringIntervals.push(priceMonitorInterval);
  }

  async monitorToken(options: {
    tokenAddress: string;
    initialPrice?: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    amount?: string;
  }): Promise<any> {
    try {
      const { tokenAddress } = options;
      const currentBalance = await getTokenBalance(this.runtime, tokenAddress);

      if (!currentBalance || BigInt(currentBalance.toString()) <= BigInt(0)) {
        console.log('No position to monitor', { tokenAddress });
        return;
      }

      const marketData = await this.dataService.getTokenMarketData(tokenAddress);
      if (!marketData.price) {
        logger.warn('Unable to get current price for token', { tokenAddress });
        return;
      }

      const priceChangePercent = options.initialPrice
        ? ((marketData.price - options.initialPrice) / options.initialPrice) * 100
        : 0;

      // Check stop loss
      if (options.stopLossPrice && marketData.price <= options.stopLossPrice) {
        logger.warn('Stop loss triggered', {
          tokenAddress,
          currentPrice: marketData.price,
          stopLossPrice: options.stopLossPrice,
        });

        await this.createSellSignal(tokenAddress, currentBalance.toString(), 'Stop loss triggered');
        return;
      }

      // Check take profit
      if (options.takeProfitPrice && marketData.price >= options.takeProfitPrice) {
        logger.info('Take profit triggered', {
          tokenAddress,
          currentPrice: marketData.price,
          takeProfitPrice: options.takeProfitPrice,
        });

        const halfPosition = BigInt(currentBalance.toString()) / BigInt(2);
        await this.createSellSignal(
          tokenAddress,
          halfPosition.toString(),
          'Take profit - selling half position'
        );

        await this.setTrailingStop(tokenAddress, marketData.price, halfPosition.toString());
      }

      return {
        tokenAddress,
        currentPrice: marketData.price,
        priceChangePercent,
      };
    } catch (error) {
      console.log('Error monitoring token:', error);
      return { error: true, message: String(error) };
    }
  }

  private async createSellSignal(
    tokenAddress: string,
    amount: string,
    reason: string
  ): Promise<void> {
    try {
      const signal = {
        tokenAddress,
        amount,
        positionId: uuidv4(),
        reason,
      };

      await this.runtime.createTask({
        id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
        roomId: this.runtime.agentId,
        name: 'SELL_SIGNAL',
        description: `Sell signal for ${tokenAddress}`,
        tags: ['queue', 'sell'],
        metadata: signal,
      });

      logger.info('Sell signal created', { tokenAddress, amount, reason });
    } catch (error) {
      console.log('Error creating sell signal:', error);
    }
  }

  private async setTrailingStop(
    tokenAddress: string,
    activationPrice: number,
    amount: string
  ): Promise<void> {
    try {
      const trailingStopData = {
        tokenAddress,
        highestPrice: activationPrice,
        activationPrice,
        trailingStopPercentage: 5, // 5% trailing stop
        amount,
        createdAt: new Date().toISOString(),
      };

      await this.runtime.setCache(`trailing_stop:${tokenAddress}`, trailingStopData);

      await this.runtime.createTask({
        id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
        roomId: this.runtime.agentId,
        name: 'MONITOR_TRAILING_STOP',
        description: `Monitor trailing stop for ${tokenAddress}`,
        tags: ['queue', 'repeat'],
        metadata: {
          tokenAddress,
          updatedAt: Date.now(),
          updateInterval: 60000,
        },
      });

      logger.info('Trailing stop set', trailingStopData);
    } catch (error) {
      console.log('Error setting trailing stop:', error);
    }
  }

  private async monitorPrices(): Promise<void> {
    try {
      const positions = await this.dataService.getPositions();

      for (const [tokenAddress, position] of Object.entries(positions)) {
        const marketData = await this.dataService.getTokenMarketData(tokenAddress);

        // Check for significant price movements
        if (marketData.price > 0) {
          // Monitor for stop loss/take profit conditions
          await this.checkPriceThresholds(tokenAddress, marketData.price, position);
        }
      }
    } catch (error) {
      console.log('Error monitoring prices:', error);
    }
  }

  private async checkPriceThresholds(
    tokenAddress: string,
    currentPrice: number,
    position: any
  ): Promise<void> {
    try {
      const stopLossPrice =
        position.entryPrice * (1 - this.tradingConfig.riskLimits.stopLossPercentage);
      const takeProfitPrice =
        position.entryPrice * (1 + this.tradingConfig.riskLimits.takeProfitPercentage);

      if (currentPrice <= stopLossPrice) {
        await this.createSellSignal(
          tokenAddress,
          position.amount.toString(),
          'Stop loss triggered'
        );
      } else if (currentPrice >= takeProfitPrice) {
        const halfPosition = BigInt(position.amount.toString()) / BigInt(2);
        await this.createSellSignal(
          tokenAddress,
          halfPosition.toString(),
          'Take profit - selling half position'
        );
      }
    } catch (error) {
      logger.warn('Error checking price thresholds:', error);
    }
  }
}
