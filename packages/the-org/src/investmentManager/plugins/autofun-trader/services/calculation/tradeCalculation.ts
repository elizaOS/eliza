import { BaseTradeService } from '../base/BaseTradeService';
import { BuySignalMessage } from '../../types';
import { calculateVolatility, assessMarketCondition } from '../../utils/analyzeTrade';
import { logger } from '@elizaos/core';

export class TradeCalculationService extends BaseTradeService {
  async calculateOptimalBuyAmount({
    tokenAddress,
    walletBalance,
    signal,
  }: {
    tokenAddress: string;
    walletBalance: number;
    signal: BuySignalMessage;
  }): Promise<number> {
    try {
      const tokenData = await this.dataService.getTokenMarketData(tokenAddress);
      const maxPosition = walletBalance * this.tradingConfig.riskLimits.maxPositionSize;

      let adjustedAmount = maxPosition;
      if (tokenData.priceHistory) {
        const volatility = calculateVolatility(tokenData.priceHistory);
        const volatilityFactor = Math.max(0.5, 1 - volatility);
        adjustedAmount *= volatilityFactor;
      }

      const marketCondition = await assessMarketCondition(this.runtime);
      if (marketCondition === 'bearish') {
        adjustedAmount *= 0.5;
      }

      const maxLiquidityImpact = tokenData.liquidity * 0.02;
      const finalAmount = Math.min(adjustedAmount, maxLiquidityImpact);

      const minTradeSize = 0.05;
      return Math.max(minTradeSize, finalAmount);
    } catch (error) {
      logger.error('Error calculating optimal buy amount:', error);
      return 0;
    }
  }
  async calculateDynamicSlippage(
    tokenAddress: string,
    tradeAmount: number,
    isSell: boolean
  ): Promise<number> {
    try {
      const tokenData = await this.dataService.getTokenMarketData(tokenAddress);
      // Base slippage in basis points (1 = 0.01%)
      let slippageBps = 50; // 0.5% base slippage

      // Calculate liquidity impact
      const liquidityPercentage = (tradeAmount / tokenData.liquidity) * 100;
      if (liquidityPercentage > 0.1) {
        // Add additional slippage based on liquidity impact
        const liquidityFactor = Math.min(
          Math.floor(liquidityPercentage * 10), // 10 bps per 1% of liquidity
          200 // Cap at 2% (200 bps)
        );
        slippageBps += liquidityFactor;
      }

      // Volume-based adjustment
      const volumeToMcapRatio = tokenData.volume24h / tokenData.marketCap;
      if (volumeToMcapRatio > 0.05) {
        // Reduce slippage for high volume tokens
        const volumeDiscount = Math.min(
          Math.floor(volumeToMcapRatio * 100),
          25 // Maximum 25 bps reduction
        );
        slippageBps = Math.max(slippageBps - volumeDiscount, 25); // Minimum 0.25% (25 bps)
      }

      // If it's a sell order, add a small buffer
      if (isSell) {
        slippageBps += 25; // Additional 0.25% for sells
      }

      // Cap maximum slippage at 3% (300 bps) instead of 5%
      const maxSlippageBps = 300;

      // Ensure we return a valid integer between 25 and 300
      return Math.max(Math.min(Math.floor(slippageBps), maxSlippageBps), 25);
    } catch (error) {
      logger.error('Error calculating dynamic slippage:', error);
      return 100; // Default to 1% slippage on error
    }
  }
}
