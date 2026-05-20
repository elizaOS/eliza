/**
 * Agent Services
 *
 * Core services for agent lifecycle management, registry, and operations.
 *
 * @packageDocumentation
 */

export * from './AgentChatService';
export * from './AgentPnLService';
export * from './AgentService';
export * from './agent-lock-service';
export * from './agent-registry.service';
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
} from './interfaces';
export * from './npc-bootstrap.service';
export * from './TeamChatService';
export * from './team-chat-notifications';
