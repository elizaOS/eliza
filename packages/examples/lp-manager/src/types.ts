/**
 * LP Manager Types
 */

export type {
  LpMonitoringConfig,
  LpMonitoringStatus,
} from "./services/LpMonitoringService";

export interface LpAgentConfig {
  userId: string;
  solanaPrivateKey?: string;
  solanaRpcUrl?: string;
  evmPrivateKey?: string;
  evmRpcUrls?: {
    ethereum?: string;
    base?: string;
    arbitrum?: string;
    bsc?: string;
    polygon?: string;
    optimism?: string;
  };
  checkIntervalMs?: number;
  minGainThresholdPercent?: number;
  maxSlippageBps?: number;
  autoRebalanceEnabled?: boolean;
  concentratedRepositionThreshold?: number;
  maxPositionSizeUsd?: number;
  minPoolTvlUsd?: number;
  maxIlRiskPercent?: number;
  solanaDexes?: string | string[];
  evmDexes?: string | string[];
}

export interface PositionSummary {
  poolId: string;
  dex: string;
  chain: "solana" | "evm";
  chainId?: number;
  tokenA: string;
  tokenB: string;
  valueUsd: number;
  currentApr: number;
  isConcentrated: boolean;
  inRange: boolean;
  priceDistancePercent: number | null;
  warnings: string[];
  rebalancable: boolean;
  rebalanceBlockedReason?: string;
  volume24h?: number;
}

export interface OpportunitySummary {
  index: number;
  fromPool: string | null;
  fromDex: string | null;
  toPool: string;
  toDex: string;
  currentApr: number;
  newApr: number;
  netGainPercent: number;
  estimatedCostUsd: number;
  shouldExecute: boolean;
  reason: string;
  riskScore: number;
  opportunityScore: number;
  isHighAprOpportunity: boolean;
  aprQuality: "sustainable" | "moderate" | "unsustainable";
}

export interface AgentStatus {
  isRunning: boolean;
  isMonitoring: boolean;
  userId: string;
  lastCheckAt: Date | null;
  nextCheckAt: Date | null;
  positions: PositionSummary[];
  opportunities: OpportunitySummary[];
  recentRebalances: Array<{
    timestamp: Date;
    success: boolean;
    fromPool: string;
    toPool: string;
    previousApr: number;
    newApr: number;
    error?: string;
  }>;
  totalValueUsd: number;
  averageApr: number;
}
