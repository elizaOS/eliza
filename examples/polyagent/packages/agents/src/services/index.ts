/**
 * Agent Services
 *
 * Core services for agent lifecycle management, registry, and trading operations.
 *
 * @packageDocumentation
 */

export * from "./AgentPnLService";
export * from "./AgentService";
export * from "./agent-lock-service";
export * from "./agent-registry.service";
export {
  getService,
  getServiceContainer,
  type IAgentRegistry,
  type ICharacterMappingService,
  type IDbContext,
  type IPredictionPricing,
  type IRedisClient,
  type IServiceContainer,
  type ITrajectoryRecorder,
  type IWalletService,
  setServiceContainer,
} from "./interfaces";
