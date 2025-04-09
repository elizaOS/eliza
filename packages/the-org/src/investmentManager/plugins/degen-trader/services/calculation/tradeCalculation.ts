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
      let slippage = this.tradingConfig.slippageSettings.baseSlippage;

      const liquidityPercentage = (tradeAmount / tokenData.liquidity) * 100;
      if (liquidityPercentage > 0.1) {
        const liquidityFactor =
          liquidityPercentage ** 1.5 * this.tradingConfig.slippageSettings.liquidityMultiplier;
        slippage += liquidityFactor * 0.01;
      }

      const volumeToMcapRatio = tokenData.volume24h / tokenData.marketCap;
      if (volumeToMcapRatio > 0.05) {
        const volumeDiscount =
          Math.min(volumeToMcapRatio * 5, 0.5) *
          this.tradingConfig.slippageSettings.volumeMultiplier;
        slippage = Math.max(
          slippage - volumeDiscount,
          this.tradingConfig.slippageSettings.baseSlippage * 0.5
        );
      }

      const finalSlippage = Math.min(slippage, this.tradingConfig.slippageSettings.maxSlippage);
      return Math.floor(finalSlippage * 100);
    } catch (error) {
      logger.error('Error calculating dynamic slippage:', error);
      return 100;
    }
  }
}
