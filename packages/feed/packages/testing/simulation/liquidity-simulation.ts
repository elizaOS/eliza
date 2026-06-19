/**
 * Shared contracts for liquidity simulation outputs.
 *
 * The simulation runner can evolve independently, but reports and dashboards
 * consume this stable result shape.
 */

export interface LiquidityScenarioConfig {
  name: string;
  description: string;
}

export interface TickMetrics {
  tick: number;
  timestamp: number;
  perpLongOI: number;
  perpShortOI: number;
  perpImbalance: number;
  perpFundingRate: number;
  perpSpotPrice: number;
  predictionTotalLiquidity: number;
  predictionAvgSpread: number;
  predictionVolume: number;
  overallHealthScore: number;
}

export interface SimulationResult {
  id: string;
  metrics: Record<string, number>;
  config: LiquidityScenarioConfig;
  tickMetrics: TickMetrics[];
  durationTicks: number;
  simulatedTimeSeconds: number;
  initialHealthScore: number;
  finalHealthScore: number;
  lowestHealthScore: number;
  avgHealthScore: number;
  finalPerpState: {
    longOI: number;
    shortOI: number;
    imbalance: number;
    imbalancePercent: number;
    fundingRate: number;
    spotPrice: number;
    totalFundingPaid: number;
    avgFundingRateAPR: number;
  };
  finalPredictionState: {
    activeMarkets: number;
    totalLiquidity: number;
    avgSpread: number;
    volume: number;
    totalVolume: number;
    npcNetPnL: number;
    userNetPnL: number;
  };
  eventsTriggered: string[];
  findings: string[];
  recommendations: string[];
}
