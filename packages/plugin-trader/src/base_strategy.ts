import type { Plugin } from '@elizaos/core';

/*
interface RiskLimits {
  maxPositionSize: number;
  maxDrawdown: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}

interface TradingConfig {
  intervals: {
    priceCheck: number;
    walletSync: number;
    performanceMonitor: number;
  };
  thresholds: {
    minLiquidity: number;
    minVolume: number;
    minScore: number;
  };
  riskLimits: RiskLimits;
  slippageSettings: {
    baseSlippage: number; // Base slippage in percentage (e.g., 0.5 for 0.5%)
    maxSlippage: number; // Maximum slippage allowed in percentage
    liquidityMultiplier: number; // Multiplier for liquidity-based adjustment
    volumeMultiplier: number; // Multiplier for volume-based adjustment
  };
}

export const DEFAULT_CONFIG = {
  intervals: {
    priceCheck: 60000,
    walletSync: 600000,
    performanceMonitor: 3600000,
  },
  thresholds: {
    minLiquidity: 50000,
    minVolume: 100000,
    minScore: 60,
  },
  riskLimits: {
    maxPositionSize: 0.2,
    maxDrawdown: 0.1, // not sure, look up with GPT
    stopLossPercentage: 0.05,
    takeProfitPercentage: 0.2,
  },
  slippageSettings: {
    baseSlippage: 0.5,
    maxSlippage: 1.0,
    liquidityMultiplier: 1.0,
    volumeMultiplier: 1.0,
  },
};

export const SAFETY_LIMITS = {
  MINIMUM_TRADE: 0.1,
  MAX_SLIPPAGE: 0.05,
  MIN_LIQUIDITY: 50000,
  MIN_VOLUME: 10000,
  MAX_PRICE_CHANGE: 30,
};

*/

class strategy {
  // strategy config
  //   I think this should just be all code
  //   though a structure allows user scaling
  // scoring weight
  // pull from trust_marketplace: t/f, a weight, a min/max, ?
  // score:
  // rsi: oversold bonus
  // rsi: overbought penalty
  // macd: strong uptrend bonus
  // macd: strong downrend penalty
  // ema: bonus/penalty
  // vol: profile bonus
  // volatility: bonus/penalty
  // social: bonus/penalty (what does this mean? social score 0-100?)
  // market metrics scoring (mcap, volume, liquidity)
}

// meta it, maybe we just need a structure to describe a config

class strategy_wallet_config {
  // per chain (every chain should have a base trading token)
  // dynamic slippage (adjusts based on what the quote recommends)
  // preferred exchanges
  // buy slippage min/max (adjust for last x minutes vol? burst min/max?)
  // sell slippage min/max
  // min/max trade
  // min liquid
  // min vol
  // max price change
  // custom config
  // copy: wallet scaling factor
  // stopLoss % / takeProfit %
}
