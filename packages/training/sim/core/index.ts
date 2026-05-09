/**
 * @babylon/sim — Standalone simulation engine with CLI, config, and auto-import scanning.
 */

export type { PromptDefinition } from "@babylon/engine";
// Augmentation interfaces (declare module '@babylon/sim' { ... })
export type {
  BabylonConfig,
  BabylonHooks,
  BabylonServices,
  BabylonSharedData,
} from "./augments";
// Bridge (legacy)
export {
  createLegacyGameTickSystem,
  type LegacyBridgeOptions,
} from "./bridge/legacy-game-tick";
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
} from "./composables";
// Config
export {
  type BabylonRuntimeConfig,
  defineBabylonConfig,
  loadBabylonConfig,
  watchBabylonConfig,
} from "./config";
export {
  type CreateEngineContextOptions,
  createEngineContext,
  createTickContext,
  DefaultTickSharedData,
} from "./context";
// Engine
export { BabylonEngine } from "./engine";
// Errors
export {
  CircularDependencyError,
  FrameworkError,
  ServiceNotFoundError,
  SystemNotFoundError,
} from "./errors";
export { DefaultLLMOrchestrator } from "./llm-orchestrator";
export { DefaultTickMetrics } from "./metrics";
// System scanner
export { type ScanResult, scanSystems } from "./scanner";
// Implementations
export { DefaultServiceContainer } from "./service-container";
// System definers
export {
  defineSystem,
  type SystemDefinition,
} from "./system";
// Types
export {
  type BabylonSystem,
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
} from "./types";
