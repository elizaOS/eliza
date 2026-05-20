/**
 * Agent Plugins
 *
 * Plugin system for extending agent capabilities including A2A integration,
 * LLM providers, trajectory logging, autonomy, and experience tracking.
 *
 * @packageDocumentation
 */

export {
  babylonPlugin,
  default as defaultBabylonPlugin,
  initializeBabylonPlugin,
} from './babylon';
export type { BabylonRuntime } from './babylon/types';
export { groqPlugin } from './groq';
export * from './plugin-agent-core/src';
export * from './plugin-autonomy/src';
export * from './plugin-experience/src';
export * from './plugin-trajectory-logger/src';
// Note: plugin-user-core has action names that overlap with plugin-agent-core
// Export only the plugin and unique exports to avoid TS2308 ambiguity errors
export {
  // Coordinator-specific providers (prefixed to avoid conflicts)
  checkUserPnlAction,
  coordinatorActionStateProvider,
  coordinatorActionsProvider,
  coordinatorContextProvider,
  coordinatorRecentMessagesProvider,
  coordinatorTeamMembersProvider,
  userCorePlugin,
} from './plugin-user-core/src';
