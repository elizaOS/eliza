/**
 * Authoritative continuous-hosting presentation for managed agents. Billing
 * and API routes consume the same tier/status vocabulary; clients receive the
 * resulting DTOs and never infer billability from lifecycle labels.
 */

import type { AgentBillingStatus } from "../../db/schemas/agent-sandboxes";
import { AGENT_PRICING } from "../constants/agent-pricing";
import type {
  AgentExecutionTier,
  AgentHostingCostDto,
  AgentHostingSummaryDto,
  AgentSandboxStatus,
} from "../types/cloud-api";

function monthlyEstimate(hourlyRate: number): number {
  return Math.round(hourlyRate * 24 * 30 * 100) / 100;
}

export interface AgentHostingState {
  executionTier: AgentExecutionTier;
  status: AgentSandboxStatus;
  billingStatus: AgentBillingStatus;
  lastBackupAt: Date | string | null;
}

export function deriveAgentHostingCost({
  executionTier,
  status,
  billingStatus,
  lastBackupAt,
}: AgentHostingState): AgentHostingCostDto {
  if (executionTier === "shared") {
    return {
      rateClass: "shared-usage",
      hourlyRateUsd: 0,
      monthlyEstimateUsd: 0,
    };
  }

  const billingActive = ["active", "warning", "shutdown_pending"].includes(billingStatus);

  if (status === "running" && billingActive) {
    return {
      rateClass: "running",
      hourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
      monthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE),
    };
  }

  if (status === "stopped" && lastBackupAt !== null && billingActive) {
    return {
      rateClass: "idle",
      hourlyRateUsd: AGENT_PRICING.IDLE_HOURLY_RATE,
      monthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE),
    };
  }

  if (status === "sleeping") {
    return {
      rateClass: "deactivated",
      hourlyRateUsd: 0,
      monthlyEstimateUsd: 0,
    };
  }

  return {
    rateClass: "unavailable",
    hourlyRateUsd: null,
    monthlyEstimateUsd: null,
  };
}

export function summarizeAgentHosting(
  costs: readonly AgentHostingCostDto[],
  creditBalanceUsd: number,
): AgentHostingSummaryDto {
  let sharedCount = 0;
  let dedicatedRunningCount = 0;
  let dedicatedIdleCount = 0;
  let hourlyHostingCostUsd = 0;

  for (const cost of costs) {
    if (cost.rateClass === "shared-usage") {
      sharedCount += 1;
    } else if (cost.rateClass === "running") {
      dedicatedRunningCount += 1;
    } else if (cost.rateClass === "idle") {
      dedicatedIdleCount += 1;
    }

    if (cost.hourlyRateUsd !== null) {
      hourlyHostingCostUsd += cost.hourlyRateUsd;
    }
  }

  const hasAgents = costs.length > 0;
  const hasDedicatedHosting = hourlyHostingCostUsd > 0;

  return {
    sharedCount,
    dedicatedRunningCount,
    dedicatedIdleCount,
    hasAgents,
    hasDedicatedHosting,
    hourlyHostingCostUsd,
    monthlyHostingCostUsd: monthlyEstimate(hourlyHostingCostUsd),
    creditBalanceUsd,
    hoursRemaining:
      hourlyHostingCostUsd > 0 ? Math.floor(creditBalanceUsd / hourlyHostingCostUsd) : null,
    lowBalance: hasDedicatedHosting && creditBalanceUsd < AGENT_PRICING.LOW_CREDIT_WARNING,
    dedicatedRunningHourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
    dedicatedRunningMonthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE),
    dedicatedIdleHourlyRateUsd: AGENT_PRICING.IDLE_HOURLY_RATE,
    dedicatedIdleMonthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE),
    minimumDepositUsd: AGENT_PRICING.MINIMUM_DEPOSIT,
    lowCreditWarningUsd: AGENT_PRICING.LOW_CREDIT_WARNING,
  };
}
