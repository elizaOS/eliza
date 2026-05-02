/**
 * LP Manager Example
 *
 * Autonomous liquidity position management for Solana and EVM DEXes.
 */

export { LpManagerAgent, loadConfigFromEnv } from "./agent";
export { character } from "./character";
export { LpMonitoringService } from "./services/LpMonitoringService";
export type {
  AgentStatus,
  LpAgentConfig,
  LpMonitoringConfig,
  LpMonitoringStatus,
  OpportunitySummary,
  PositionSummary,
} from "./types";
