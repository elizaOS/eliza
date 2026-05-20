/**
 * Babylon Plugin Integration Service - A2A SDK
 *
 * Integrates the Babylon A2A plugin with the agent runtime manager
 * using @a2a-js/sdk
 *
 * This file re-exports the SDK implementation to maintain
 * backward compatibility with existing code.
 */

// Re-export from A2A SDK integration
export {
  BabylonA2AClient,
  disconnectAgentA2AClient,
  enhanceRuntimeWithBabylon,
  hasActiveA2AConnection,
  initializeAgentA2AClient,
} from './integration-a2a-sdk';
