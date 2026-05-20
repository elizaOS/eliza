/**
 * Feed Plugin Service Exports
 *
 * Re-exports autonomous services that use the Feed A2A plugin
 */

export {
  AutonomousA2AService,
  autonomousA2AService,
} from '../../autonomous/AutonomousA2AService';
export {
  disconnectAgentA2AClient,
  enhanceRuntimeWithFeed,
  hasActiveA2AConnection,
  initializeAgentA2AClient,
} from './integration';
