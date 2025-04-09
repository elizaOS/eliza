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
    maxDrawdown: 0.1,
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
