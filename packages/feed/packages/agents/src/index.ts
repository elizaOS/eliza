/**
 * @feed/agents - Feed Agent System
 *
 * This package provides the core agent infrastructure for Feed:
 * - Agent services (creation, management, points)
 * - Autonomous behaviors (trading, posting, commenting, messaging)
 * - Plugin system for extending agent capabilities
 */

// Autonomous services
export * from './autonomous';
// Communication
export * from './communication/CommunicationHub';
export * from './communication/EventBus';
// Errors
export * from './errors';
// External agent adapter
export {
  type AgentResponse,
  AuthMethod,
  ExternalAgentAdapter,
  type ExternalAgentConnection,
  type ExternalAgentMessage,
  getExternalAgentAdapter,
  type Protocol,
} from './external/ExternalAgentAdapter';
// LLM integrations
export * from './llm';
// Plugins - Feed plugin is the main export
export {
  feedPlugin,
  initializeAgentA2AClient,
  initializeFeedPlugin,
} from './plugins/feed';
export type { FeedRuntime } from './plugins/feed/types';
// Plugin utilities
export { groqPlugin } from './plugins/groq';
export * from './plugins/plugin-agent-core/src';
export * from './plugins/plugin-autonomy/src';
export * from './plugins/plugin-experience/src';
// Plugin sub-exports for trajectory logging, autonomy, experience
export * from './plugins/plugin-trajectory-logger/src';
// Runtime
export * from './runtime/AgentRuntimeManager';
// Services
export * from './services';
// Shared utilities
export {
  getAgentConfig,
  getAutonomousFeatures,
  hasAnyAutonomousFeature,
  isAutonomousCommentingEnabled,
  isAutonomousDMsEnabled,
  isAutonomousGroupChatsEnabled,
  isAutonomousPostingEnabled,
  isAutonomousTradingEnabled,
} from './shared/agent-config';
// Keep Solana registry helpers off the root barrel so non-Solana routes do not
// pull Solana SDK dependencies into shared serverless bundles.
// Templates loader
export * from './templates-loader';
// Training utilities (RL model fetching, config)
export * from './training';
// Core types
export * from './types';
export * from './types/agent-template';
export * from './types/goals';
// Utils
export * from './utils/createTestAgent';
export * from './utils/prompt-builder';
