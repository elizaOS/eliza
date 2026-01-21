import type { Plugin } from "@elizaos/core";

/**
 * Trajectory Logger Plugin
 *
 * Collects complete agent interaction trajectories for RL training.
 * Records LLM calls, provider access, actions, environment state, and computes rewards.
 *
 * @remarks TrajectoryLoggerService is exported but not registered as a service
 * since it doesn't fully implement the Service interface. Use the exported functions directly.
 */
export const trajectoryLoggerPlugin: Plugin = {
  name: "@elizaos/plugin-trajectory-logger",
  description:
    "Collects complete agent interaction trajectories for RL training. Records LLM calls, provider access, actions, environment state, and computes rewards from game knowledge.",
  dependencies: [],
  services: [],
};

export default trajectoryLoggerPlugin;

// ==========================================
// PRIMARY: Action-Level Instrumentation
// Use these for most cases!
// ==========================================
export * from "./action-interceptor";
export { TrajectoryLoggerService } from "./TrajectoryLoggerService";
// ==========================================
// CORE TYPES
// ==========================================
export * from "./types";
// Exports:
// - wrapActionWithLogging()
// - wrapPluginActions()
// - logLLMCallFromAction()
// - logProviderFromAction()

// ==========================================
// PRIMARY: Game-Knowledge Rewards
// Use this if you have perfect game information!
// ==========================================
export * from "./game-rewards";
// Exports:
// - computeTrajectoryReward()
// - computeStepReward()
// - buildGameStateFromDB()
// - recomputeTrajectoryRewards()

// ==========================================
// TRAJECTORY FORMAT CONVERSION
// Converts rich trajectories to training-compatible message format
// ==========================================
export * from "./art-format";
// Exports:
// - toARTMessages() - Convert to message array
// - toARTTrajectory() - Convert to training format
// - groupTrajectories() - Group by scenario
// - prepareForRULER() - Format for LLM judge
// - validateARTCompatibility() - Check convertibility

// ==========================================
// DATA EXPORT
// ==========================================
export * from "./export";
// Exports:
// - exportToHuggingFace()
// - exportGroupedByScenario()
// - exportForTrainingFormat()
// - exportGroupedForGRPO() - Groups for RULER ranking

// ==========================================
// ADVANCED: Manual Instrumentation
// Only use if you need custom control beyond actions
// ==========================================
export * from "./integration";
// Exports:
// - startAutonomousTick()
// - endAutonomousTick()
// - loggedLLMCall()
// - logProviderAccess()
// - withTrajectoryLogging()

// ==========================================
// OPTIONAL: AI Judge Rewards
// Only use if you DON'T have game knowledge
// (game-rewards.ts is usually better!)
// ==========================================
export * from "./reward-service";
// Exports:
// - RewardService
// - createRewardService()
// - scoreTrajectory()
// - scoreTrajectoryGroup() (RULER)
