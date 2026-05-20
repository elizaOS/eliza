/**
 * Plugin Agent Core Types
 *
 * Types for the agent core plugin including action results and state management.
 */

import type { ServiceTypeRegistry } from "@elizaos/core";

// Re-export ActionTraceResult from autonomous
export type { ActionTraceResult } from "../../../autonomous/templates/multi-step-decision";

/**
 * Chat-specific multi-step decision (extends base with response field)
 */
export interface ChatMultiStepDecision {
  thought: string;
  action: string;
  parameters: Record<string, unknown>;
  response: string;
  isFinish: boolean;
}

/**
 * Autonomy feature types that can be toggled
 */
export type AutonomyFeature =
  | "trading"
  | "posting"
  | "commenting"
  | "dms"
  | "groupChats"
  | "all";

/**
 * Toggle autonomy action parameters
 */
export interface ToggleAutonomyParams {
  feature: AutonomyFeature;
  enabled: boolean;
}

/**
 * Autonomy status response
 */
export interface AutonomyStatus {
  autonomousTrading: boolean;
  autonomousPosting: boolean;
  autonomousCommenting: boolean;
  autonomousDMs: boolean;
  autonomousGroupChats: boolean;
}

// Extend the core service types
declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    AGENT_CORE: "AGENT_CORE";
  }
}

export const AgentCoreServiceType = {
  AGENT_CORE: "AGENT_CORE" as const,
} satisfies Partial<ServiceTypeRegistry>;
