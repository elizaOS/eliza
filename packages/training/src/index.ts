/**
 * ElizaOS Training Package
 *
 * A reusable RL training pipeline for agent trajectories including:
 * - Benchmarking and evaluation
 * - Automated training orchestration
 * - HuggingFace publishing helpers
 * - Archetype-aware scoring utilities
 *
 * ## Setup
 *
 * Before using training operations, register a data adapter:
 *
 * ```ts
 * import { setTrainingDataAdapter } from '@elizaos/training';
 * setTrainingDataAdapter(myDrizzleAdapter);
 * ```
 *
 * @packageDocumentation
 */

export type {
  BenchmarkResultRecord,
  ILlmLogAdapter,
  IMarketDataAdapter,
  ITrainingDataAdapter,
  JsonValue,
  LlmCallLogRecord,
  TrainedModelRecord,
  TrainingBatchRecord,
  TrajectoryRecord,
  UserRecord,
  UUID,
} from "./adapter";
// Data adapter (must be registered before DB-dependent operations)
export {
  getLlmLogAdapter,
  getMarketDataAdapter,
  getTrainingDataAdapter,
  isDataAdapterRegistered,
  resetAdapters,
  setLlmLogAdapter,
  setMarketDataAdapter,
  setTrainingDataAdapter,
} from "./adapter";

// Archetypes
export * from "./archetypes";
// Re-export all sub-modules
export * from "./benchmark";
export type {
  CreateAgentParams,
  ExportGroupedForGRPOFn,
  ExportToHuggingFaceFn,
  IAgentRuntimeLike,
  IAgentRuntimeManager,
  IAgentService,
  IAutonomousCoordinator,
  ILLMCaller,
  ITaskInteractor,
  ToTrainingMessagesFn,
  TrainingMessage,
  TrajectoryForTraining,
  TrajectoryStepForTraining,
  UserLike,
} from "./dependencies";
// Dependencies configuration
export {
  areAgentDependenciesConfigured,
  areDependenciesConfigured,
  configureTrainingDependencies,
  getAgentRuntimeManager,
  getAgentService,
  getAutonomousCoordinator,
  getExportGroupedForGRPO,
  getExportToHuggingFace,
  getLLMCaller,
  getToTrainingMessages,
} from "./dependencies";
// Generation
export * from "./generation";
export * from "./huggingface";
// Training initialization
export {
  initializeTrainingPackage,
  isTrainingInitialized,
  resetTrainingInitialization,
} from "./init-training";
// Metrics (re-export for backwards compatibility, prefer import from './metrics')
export * from "./metrics";
export * from "./rubrics";
export * from "./scoring";
export * from "./training";
export {
  benchmarkAndMaybeDeployModel,
  checkTrainingReadiness,
  deployModelVersion,
  getAutomationPipelineStatus,
  getNextTrainingModelSelection,
  monitorTrainingJob,
  rollbackModelVersion,
  triggerTraining,
} from "./training/pipeline";
// Utilities
export * from "./utils";
