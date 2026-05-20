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

// Trajectory capture
export { TrajectoryRecorder, trajectoryRecorder } from './TrajectoryRecorder';

// Reward computation
export {
  computeDeterministicRewardJudgment,
  upsertRewardJudgment,
} from './reward-judgments';

// Reward backprop / market outcomes
export {
  RewardBackpropagationService,
  rewardBackpropagationService,
} from './RewardBackpropagationService';
export { MarketOutcomesTracker } from './MarketOutcomesTracker';

// Model lifecycle
export type { ModelArtifact } from './ModelFetcher';
export { getLatestRLModel } from './ModelFetcher';
export type { DeploymentOptions, DeploymentResult } from './ModelDeployer';
export { ModelDeployer, modelDeployer } from './ModelDeployer';

// RL model config
export type {
  ArchetypeModelConfig,
  ModelTier,
  ModelTierConfig,
  MultiModelConfig,
  QuantizationMode,
  RLModelConfig,
} from './RLModelConfig';
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
} from './RLModelConfig';
export { logRLConfigOnStartup } from './logRLConfig';

// Automation pipeline
export type { AutomationConfig } from './AutomationPipeline';
export { AutomationPipeline, automationPipeline } from './AutomationPipeline';

// Trajectory data archival
export { TrainingDataArchiver } from './storage/TrainingDataArchiver';

// Shared types
export type { TrajectoryStep } from './types';
