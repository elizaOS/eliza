// Consolidated Services

// Original Services (kept for backward compatibility during migration)
export { BalancedTrustScoreCalculator } from "./balancedTrustScoreCalculator";
export { HistoricalPriceService } from "./historicalPriceService";
export type {
	EnrichedTradingCall,
	HistoricalPriceData,
	PricePoint,
	TokenResolution,
	TradingCall,
	TrustScore,
} from "./PriceDataService";
export { PriceDataService } from "./PriceDataService";
export { PriceEnrichmentService } from "./priceEnrichmentService";
// Re-export types from consolidated services
export type {
	ActorArchetypeV2,
	ActorConfig,
	SimulatedActorV2,
	SimulatedCallData,
	SimulatedCallV2,
	SimulationConfig,
	SimulationResult,
	SimulationToken,
	TokenPrice,
	TokenScenario,
} from "./SimulationService";
export { SimulationService } from "./SimulationService";
export { SimulationActorsServiceV2 } from "./simulationActorsV2";
export { SimulationRunner } from "./simulationRunner";
export type {
	BalancedTrustScoreParams,
	OptimizationResult,
	TrustScoreParameters,
	TrustScoreResult,
} from "./TrustScoreService";
export { TrustScoreService } from "./TrustScoreService";
export { TokenSimulationService } from "./tokenSimulationService";
export { TrustScoreOptimizer } from "./trustScoreOptimizer";

import type { IAgentRuntime } from "@elizaos/core";
import { PriceDataService } from "./PriceDataService";
// Service instances for convenience
import { SimulationService } from "./SimulationService";
import { TrustScoreService } from "./TrustScoreService";

export function createServices(runtime?: IAgentRuntime) {
	return {
		simulation: new SimulationService(),
		priceData: runtime ? new PriceDataService(runtime) : null,
		trustScore: new TrustScoreService(),
	};
}
