/**
 * Classifies continuous hosting cost from the agent's authoritative execution
 * tier and lifecycle state. Shared runtime stays usage-metered but never enters
 * dedicated container hosting projections.
 */

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import type {
  AgentExecutionTier,
  AgentSandboxStatus,
} from "@elizaos/cloud-shared/lib/types/cloud-api";

export interface AgentHostingInput {
  executionTier: AgentExecutionTier | undefined;
  status: AgentSandboxStatus | string;
}

export type AgentHostingCost =
  | {
      rateClass: "shared-usage" | "deactivated";
      hourlyRate: 0;
    }
  | {
      rateClass: "running" | "provisioning" | "idle";
      hourlyRate: number;
    }
  | {
      rateClass: "unavailable";
      hourlyRate: null;
    };

export interface AgentHostingSummary {
  sharedCount: number;
  dedicatedRunningCount: number;
  dedicatedIdleCount: number;
}

/**
 * Shared tier wins over lifecycle state because it has no dedicated container.
 * Unknown tiers retain the existing dedicated presentation instead of silently
 * granting a zero-cost classification to an incomplete API response.
 */
export function getAgentHostingCost({
  executionTier,
  status,
}: AgentHostingInput): AgentHostingCost {
  if (executionTier === "shared") {
    return {
      rateClass: "shared-usage",
      hourlyRate: 0,
    };
  }

  if (status === "running") {
    return {
      rateClass: "running",
      hourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
    };
  }

  if (status === "provisioning") {
    return {
      rateClass: "provisioning",
      hourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
    };
  }

  if (status === "stopped" || status === "disconnected") {
    return {
      rateClass: "idle",
      hourlyRate: AGENT_PRICING.IDLE_HOURLY_RATE,
    };
  }

  if (status === "sleeping") {
    return {
      rateClass: "deactivated",
      hourlyRate: 0,
    };
  }

  return {
    rateClass: "unavailable",
    hourlyRate: null,
  };
}

/** Summarizes only continuous hosting; metered model usage is separate. */
export function summarizeAgentHosting(
  agents: readonly AgentHostingInput[],
): AgentHostingSummary {
  let sharedCount = 0;
  let dedicatedRunningCount = 0;
  let dedicatedIdleCount = 0;

  for (const agent of agents) {
    const cost = getAgentHostingCost(agent);

    if (cost.rateClass === "shared-usage") {
      sharedCount += 1;
    } else if (cost.rateClass === "running") {
      dedicatedRunningCount += 1;
    } else if (cost.rateClass === "idle") {
      dedicatedIdleCount += 1;
    }
  }

  return { sharedCount, dedicatedRunningCount, dedicatedIdleCount };
}
