export const tradeAnalysisTemplate = `
You are a trading assistant focused on managing SOL wallet balances and trade sizes. Your primary goal is to suggest appropriate trade amounts while maintaining safe reserves.

<api_data>
{{api_data}}
</api_data>

<market_data>
{{marketData}}
</market_data>

Core Rules:
1. ALWAYS keep minimum 0.002 SOL in wallet for gas fees
2. Minimum trade size is 5% * {{walletBalance}}
3. Maximum trade size is 25% * {{walletBalance}} for high volatility tokens
4. See api_data for token recommendation and market data for technical analysis
5. suggestedAmount must not exceed walletBalance
6. Skip trades if wallet balance is too low or market conditions unfavorable

Market Analysis Factors:
1. Volume Analysis:
   - 24h volume trend
   - Volume/Market Cap ratio
   - Unusual volume spikes
2. Price Action:
   - RSI levels
   - MACD crossovers
   - Support/Resistance levels
3. Market Structure:
   - Liquidity depth
   - Holder distribution
   - Recent large transactions
4. Risk Assessment:
   - Volatility metrics
   - Market correlation
   - Smart money flow

Analyze the following data:
<wallet_data>
{{walletBalance}}
</wallet_data>

Provide a JSON response with the following format:
{
  "shouldTrade": boolean,
  "recommendedAction": "buy" | "sell" | "hold" | "SKIP",
  "suggestedAmount": number,
  "confidence": "low" | "medium" | "high",
  "reason": string,
  "riskScore": number,  // 1-10 scale
  "technicalFactors": {
    "trend": "bullish" | "bearish" | "neutral",
    "momentum": number,  // -100 to 100
    "volumeProfile": "increasing" | "decreasing" | "stable",
    "liquidityScore": number  // 1-10 scale
  }
}`;

import { ServiceTypes } from '../types';
import { type IAgentRuntime, logger } from '@elizaos/core';

// FIXME: change runtime to just pass the dataService in
export async function assessMarketCondition(
  runtime: IAgentRuntime
): Promise<'bullish' | 'neutral' | 'bearish'> {
  try {
    // might be best to move this out of this function
    const tradeService = runtime.getService(ServiceTypes.DEGEN_TRADING);
    const solData = await tradeService.dataService.getTokenMarketData(
      'So11111111111111111111111111111111111111112' // SOL address
    );

    if (!solData.priceHistory || solData.priceHistory.length < 24) {
      return 'neutral';
    }

    const currentPrice = solData.price;
    const previousPrice = solData.priceHistory[0];
    const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;

    if (priceChange > 5) return 'bullish';
    if (priceChange < -5) return 'bearish';
    return 'neutral';
  } catch (error) {
    console.log('Error assessing market condition:', error);
    return 'neutral';
  }
}

export function calculateVolatility(priceHistory: number[]): number {
  if (priceHistory.length < 2) return 0;

  const returns = [];
  for (let i = 1; i < priceHistory.length; i++) {
    returns.push(Math.log(priceHistory[i] / priceHistory[i - 1]));
  }

  const mean = returns.reduce((a, b) => a + b) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

// buy is different than sell
export function calculateDynamicSlippage(amount: string, quoteData: any): number {
  const baseSlippage = 0.45;
  const priceImpact = parseFloat(quoteData?.priceImpactPct || '0');
  const amountNum = Number(amount);
  const decimals = quoteData?.inputDecimals || 6;

  const amountReadable = amountNum / Math.pow(10, decimals);

  let dynamicSlippage = baseSlippage;

  if (priceImpact > 1) {
    dynamicSlippage += priceImpact * 0.5;
  }

  if (amountReadable > 10000) {
    dynamicSlippage *= 1.5;
  }

  return Math.min(dynamicSlippage, 2.5);
}

// +sell assessMarketCondition
// +sell calculateVolatility
// sell getExpectedAmount => trade?
// sell calculateDynamicSlippage
// buy validateTokenForTrading
// buy calculateOptimalBuyAmount
// buy calculateDynamicSlippage
// +buy calculateVolatility
// +buy assessMarketCondition
// buy fetchTokenMetadata
// buy analyzeTradingAmount
