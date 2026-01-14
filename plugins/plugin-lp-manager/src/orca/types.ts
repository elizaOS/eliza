import { PublicKey } from '@solana/web3.js';

export interface LPPosition {
  positionId: string;
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  liquidity: bigint;
  lowerTick: number;
  upperTick: number;
  inRange: boolean;
}

export interface PoolStats {
  address: string;
  tvl: number;
  volume24h: number;
  fee24h: number;
  apy: number;
  price: number;
  priceRange: {
    min24h: number;
    max24h: number;
  };
}

export interface RebalanceParams {
  position: LPPosition;
  currentPrice: number;
  targetWidth: number;
  slippage: number;
}

export interface TradingConfig {
  intervals: {
    priceCheck: number;
    positionSync: number;
    performanceMonitor: number;
  };
  thresholds: {
    minTvl: number;
    minVolume: number;
    minApy: number;
  };
  riskLimits: {
    maxPositionSize: number;
    maxPriceImpact: number;
    minLiquidity: number;
  };
  rebalanceSettings: {
    threshold: number;
    targetWidth: number;
    minInterval: number;
  };
}

export interface PositionMetrics {
  fees24h: number;
  apy: number;
  impermanentLoss: number;
  totalValue: number;
  tokenAAmount: number;
  tokenBAmount: number;
}

export const ServiceTypes = {
  LP_TRADING: 'lp_trader',
} as const;
