/**
 * XMRT-Eliza Autonomous Systems
 * Export all autonomous system components
 */

export { AutonomousMemoryManager } from './memory-manager';
export { AutonomousCoordinationManager } from './coordination-manager';
export { AutonomousOrchestrator } from './autonomous-orchestrator';

export type {
  MemoryEntry,
  LearningPattern,
} from './memory-manager';

export type {
  AgentStatus,
  CoordinationTask,
  SwarmDecision,
} from './coordination-manager';

export type {
  AutonomousConfig,
  SystemHealth,
  AutonomousMetrics,
} from './autonomous-orchestrator';

/**
 * Factory function to create a fully configured autonomous system
 */
export function createAutonomousSystem(config: {
  agentId: string;
  redisHost?: string;
  redisPort?: number;
  learningRate?: number;
  coordinationInterval?: number;
  privacyMode?: boolean;
  meshnetEnabled?: boolean;
  offlineCapable?: boolean;
}) {
  const autonomousConfig = {
    agentId: config.agentId,
    redisConfig: {
      host: config.redisHost || process.env.REDIS_HOST || 'localhost',
      port: config.redisPort || parseInt(process.env.REDIS_PORT || '6379'),
    },
    learningRate: config.learningRate || 0.1,
    coordinationInterval: config.coordinationInterval || 15000,
    privacyMode: config.privacyMode || true,
    meshnetEnabled: config.meshnetEnabled || true,
    offlineCapable: config.offlineCapable || true,
  };

  return new AutonomousOrchestrator(autonomousConfig);
}

