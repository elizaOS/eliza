import type { Plugin } from "@elizaos/core";

/**
 * Trajectory Logger Plugin
 *
 * Collects complete agent interaction trajectories for RL training.
 * Records LLM calls, provider access, actions, environment state, and computes rewards.
 *
 * @remarks TrajectoryLoggerService is exported but not registered as a service
 * since it doesn't implement the core Service interface. Use the exported helpers directly.
 */
export const trajectoryLoggerPlugin: Plugin = {
  name: "@elizaos/plugin-trajectory-logger",
  description:
    "Collects complete agent interaction trajectory data for RL training. Records LLM calls, provider access, actions, environment state, and computes rewards.",
  dependencies: [],
  services: [],
};

export default trajectoryLoggerPlugin;

// ==========================================
// PRIMARY: Action-Level Instrumentation
// Use these for most cases!
// ==========================================
export * from "./action-interceptor";
// ==========================================
// TRAJECTORY FORMAT CONVERSION
// ==========================================
export * from "./art-format";
// ==========================================
// DATA EXPORT
// ==========================================
export * from "./export";

// ==========================================
// PRIMARY: Game-Knowledge Rewards
// ==========================================
export * from "./game-rewards";
// ==========================================
// ADVANCED: Manual Instrumentation
// ==========================================
export * from "./integration";
// ==========================================
// OPTIONAL: Heuristic Rewards
// ==========================================
export * from "./reward-service";
export { TrajectoryLoggerService } from "./TrajectoryLoggerService";
// ==========================================
// CORE TYPES
// ==========================================
export * from "./types";
