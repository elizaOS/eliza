/**
 * @feed/sim — Standalone simulation engine with CLI, config, and auto-import scanning.
 */

export type { PromptDefinition } from '@feed/engine/prompts/define-prompt';
// Augmentation interfaces (declare module '@feed/sim' { ... })
export type {
  FeedConfig,
  FeedHooks,
  FeedServices,
  FeedSharedData,
} from './augments';
// Bridge (legacy)
export {
  createLegacyGameTickSystem,
  type LegacyBridgeOptions,
} from './bridge/legacy-game-tick';
// Composables (unctx)
export {
  tryUseTick,
  useDB,
  useEngine,
  useHooks,
  useLLM,
  useMetrics,
  useServices,
  useShared,
  useTick,
} from './composables';
// Config
export {
  type FeedRuntimeConfig,
  defineFeedConfig,
  loadFeedConfig,
  watchFeedConfig,
} from './config';
export {
  type CreateEngineContextOptions,
  createEngineContext,
  createTickContext,
  DefaultTickSharedData,
} from './context';
// Engine
export { FeedEngine } from './engine';
// Errors
export {
  CircularDependencyError,
  FrameworkError,
  ServiceNotFoundError,
  SystemNotFoundError,
} from './errors';
export { DefaultLLMOrchestrator } from './llm-orchestrator';
export { DefaultTickMetrics } from './metrics';
// System scanner
export { type ScanResult, scanSystems } from './scanner';
// Implementations
export { DefaultServiceContainer } from './service-container';
// System definers
/** @deprecated Use `defineSystem()` instead. */
export {
  AbstractFeedSystem,
  defineSystem,
  type SystemDefinition,
} from './system';
// Types
export {
  type FeedSystem,
  type EngineConfig,
  type EngineContext,
  type LLMExecuteOptions,
  type LLMOrchestrator,
  type RuntimeHookable,
  type RuntimeHooks,
  type ServiceContainer,
  type SystemTickResult,
  type TickContext,
  type TickMetrics,
  TickPhase,
  type TickSharedData,
} from './types';
