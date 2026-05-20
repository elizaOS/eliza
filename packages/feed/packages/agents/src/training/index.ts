/**
 * Training Module
 *
 * Trajectory capture, reward computation, model deployment, and the
 * automation pipeline. The Python RL trainer lives in
 * `packages/training/scripts/rl/` and reads JSONL exports from
 * `~/.milady/state/trajectories/`.
 *
 * @packageDocumentation
 */

// Automation pipeline
export type { AutomationConfig } from "./AutomationPipeline";
export { AutomationPipeline, automationPipeline } from "./AutomationPipeline";
export { logRLConfigOnStartup } from "./logRLConfig";
export { MarketOutcomesTracker } from "./MarketOutcomesTracker";
export type { DeploymentOptions, DeploymentResult } from "./ModelDeployer";
export { ModelDeployer, modelDeployer } from "./ModelDeployer";
// Model lifecycle
export type { ModelArtifact } from "./ModelFetcher";
export { getLatestRLModel } from "./ModelFetcher";
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
// Reward computation
export {
  computeDeterministicRewardJudgment,
  upsertRewardJudgment,
} from "./reward-judgments";
// Trajectory data archival
export { TrainingDataArchiver } from "./storage/TrainingDataArchiver";
// Trajectory capture
export { TrajectoryRecorder, trajectoryRecorder } from "./TrajectoryRecorder";

// Shared types
export type { TrajectoryStep } from "./types";
