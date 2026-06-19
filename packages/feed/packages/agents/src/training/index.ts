/**
 * Training Module
 *
 * Trajectory capture, reward computation, model deployment, and the
 * automation pipeline. The Python RL trainer lives in
 * `packages/training/scripts/rl/` and reads JSONL exports from
 * `~/.eliza/state/trajectories/`.
 *
 * @packageDocumentation
 */

// Automation pipeline
export type { AutomationConfig } from "./AutomationPipeline";
export { AutomationPipeline, automationPipeline } from "./AutomationPipeline";
export type { BenchmarkResults, ComparisonResults } from "./BenchmarkService";
export { BenchmarkService, benchmarkService } from "./BenchmarkService";
export {
  HuggingFaceIntegration,
  huggingFaceIntegration,
} from "./HuggingFaceIntegration";
export { logRLConfigOnStartup } from "./logRLConfig";
export { MarketOutcomesTracker } from "./MarketOutcomesTracker";
export type { DeploymentOptions, DeploymentResult } from "./ModelDeployer";
export { ModelDeployer, modelDeployer } from "./ModelDeployer";
// Model lifecycle
export type { ModelArtifact } from "./ModelFetcher";
export { getLatestRLModel } from "./ModelFetcher";
export {
  ModelSelectionService,
  modelSelectionService,
} from "./ModelSelectionService";
// Reward backprop / market outcomes
export {
  RewardBackpropagationService,
  rewardBackpropagationService,
} from "./RewardBackpropagationService";
// RL model config
export type {
  ArchetypeModelConfig,
  ModelTier,
  ModelTierConfig,
  MultiModelConfig,
  QuantizationMode,
  RLModelConfig,
} from "./RLModelConfig";
export {
  clearArchetypeModels,
  getAllArchetypeModels,
  getAvailableModelTiers,
  getModelForArchetype,
  getModelForTier,
  getModelTierForVram,
  getMultiModelConfig,
  getQuantizedModelName,
  getRLModelConfig,
  getVramRequirement,
  hasArchetypeModel,
  isRLModelAvailable,
  isTierAvailable,
  logRLModelConfig,
} from "./RLModelConfig";
export {
  RulerScoringService,
  rulerScoringService,
} from "./RulerScoringService";
// Reward computation
export {
  computeDeterministicRewardJudgment,
  upsertRewardJudgment,
} from "./reward-judgments";
// Shared types
export type {
  BenchmarkGameSnapshot,
  SimulationConfig,
  SimulationResult,
} from "./SimulationBenchmark";
export {
  MetricsVisualizer,
  SimulationA2AInterface,
  SimulationEngine,
} from "./SimulationBenchmark";
export {
  ModelStorageService,
  modelStorage,
} from "./storage/ModelStorageService";
// Trajectory data archival
export { TrainingDataArchiver } from "./storage/TrainingDataArchiver";
// Trajectory capture
export { TrajectoryRecorder, trajectoryRecorder } from "./TrajectoryRecorder";
export type { TrajectoryStep } from "./types";
