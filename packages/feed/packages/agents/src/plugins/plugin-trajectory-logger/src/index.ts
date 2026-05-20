import { type Plugin } from '@elizaos/core';
import { TrajectoryLoggerService } from './TrajectoryLoggerService';

/**
 * Trajectory Logger Plugin
 *
 * Collects complete agent interaction trajectories for RL training.
 * Records LLM calls, provider access, actions, environment state, and computes rewards.
 *
 * Registers the runtime service so Babylon can retrieve a single
 * plugin-owned trajectory logger instance per runtime.
 */
export const trajectoryLoggerPlugin: Plugin = {
  name: '@elizaos/plugin-trajectory-logger',
  description:
    'Collects complete agent interaction trajectories for RL training. Records LLM calls, provider access, actions, environment state, and computes rewards from game knowledge.',
  dependencies: [],
  services: [TrajectoryLoggerService],
};

export default trajectoryLoggerPlugin;

// ==========================================
// PRIMARY: Action-Level Instrumentation
// Use these for most cases!
// ==========================================
export * from './action-interceptor';
export { TrajectoryLoggerService } from './TrajectoryLoggerService';
// ==========================================
// CORE TYPES
// ==========================================
export * from './types';
// Exports:
// - wrapActionWithLogging()
// - wrapPluginActions()
// - logLLMCallFromAction()
// - logProviderFromAction()

// Game-Knowledge Rewards: REMOVED (was dead stubs).
// Canonical reward computation is in @babylon/training: reward-judgments.ts

// ==========================================
// TRAJECTORY FORMAT CONVERSION
// Converts rich trajectories to training-compatible message format
// ==========================================
export * from './art-format';
// Exports:
// - toARTMessages() - Convert to message array
// - toARTTrajectory() - Convert to training format
// - groupTrajectories() - Group by scenario
// - prepareForRULER() - Format for LLM judge
// - validateARTCompatibility() - Check convertibility

// ==========================================
// DATA EXPORT
// ==========================================
export * from './export';
// Exports:
// - exportToHuggingFace()
// - exportGroupedByScenario()
// - exportForTrainingFormat()
// - exportGroupedForGRPO() - Groups for RULER ranking

// ==========================================
// ADVANCED: Manual Instrumentation
// Only use if you need custom control beyond actions
// ==========================================
export * from './integration';
// Exports:
// - startAutonomousTick()
// - endAutonomousTick()
// - loggedLLMCall()
// - logProviderAccess()
// - withTrajectoryLogging()

// ==========================================
// REWARD SCORING
// Deterministic judge is auto-called in endTrajectory().
// For manual scoring, import from @babylon/training directly:
//   import { computeDeterministicRewardJudgment } from '@babylon/training/training/reward-judgments'
// ==========================================
