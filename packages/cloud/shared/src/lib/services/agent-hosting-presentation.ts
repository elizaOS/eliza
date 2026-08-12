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
      pricingState: "known",
      rateClass: "shared-usage",
      hourlyRateUsd: 0,
      monthlyEstimateUsd: 0,
    };
  }

  const billingActive = ["active", "warning", "shutdown_pending"].includes(billingStatus);

  if (status === "running" && billingActive) {
    return {
      pricingState: "known",
      rateClass: "running",
      hourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
      monthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE),
    };
  }

  if (status === "stopped" && lastBackupAt !== null && billingActive) {
    return {
      pricingState: "known",
      rateClass: "idle",
      hourlyRateUsd: AGENT_PRICING.IDLE_HOURLY_RATE,
      monthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE),
    };
  }

  if (status === "sleeping") {
    return {
      pricingState: "known",
      rateClass: "deactivated",
      hourlyRateUsd: 0,
      monthlyEstimateUsd: 0,
    };
  }

  return {
    pricingState: "unavailable",
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
  let dedicatedDeactivatedCount = 0;
  let unavailableDedicatedCount = 0;
  let knownHourlyHostingCostUsd = 0;

  for (const cost of costs) {
    if (cost.rateClass === "shared-usage") {
      sharedCount += 1;
    } else if (cost.rateClass === "running") {
      dedicatedRunningCount += 1;
    } else if (cost.rateClass === "idle") {
      dedicatedIdleCount += 1;
    } else if (cost.rateClass === "deactivated") {
      dedicatedDeactivatedCount += 1;
    } else {
      unavailableDedicatedCount += 1;
    }

    if (cost.pricingState === "known") {
      knownHourlyHostingCostUsd += cost.hourlyRateUsd;
    }
  }

  const hasAgents = costs.length > 0;
  const hasDedicatedHosting = sharedCount < costs.length;
  const common = {
    sharedCount,
    dedicatedRunningCount,
    dedicatedIdleCount,
    dedicatedDeactivatedCount,
    hasAgents,
    hasDedicatedHosting,
    creditBalanceUsd,
    dedicatedRunningHourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
    dedicatedRunningMonthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE),
    dedicatedIdleHourlyRateUsd: AGENT_PRICING.IDLE_HOURLY_RATE,
    dedicatedIdleMonthlyEstimateUsd: monthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE),
    minimumDepositUsd: AGENT_PRICING.MINIMUM_DEPOSIT,
    lowCreditWarningUsd: AGENT_PRICING.LOW_CREDIT_WARNING,
  };

  if (unavailableDedicatedCount > 0) {
    return {
      ...common,
      pricingState: "incomplete",
      unavailableDedicatedCount,
      hourlyHostingCostUsd: null,
      monthlyHostingCostUsd: null,
      hoursRemaining: null,
      lowBalance: null,
    };
  }

  return {
    ...common,
    pricingState: "complete",
    unavailableDedicatedCount: 0,
    hourlyHostingCostUsd: knownHourlyHostingCostUsd,
    monthlyHostingCostUsd: monthlyEstimate(knownHourlyHostingCostUsd),
    hoursRemaining:
      knownHourlyHostingCostUsd > 0
        ? Math.floor(creditBalanceUsd / knownHourlyHostingCostUsd)
        : null,
    lowBalance:
      knownHourlyHostingCostUsd > 0 && creditBalanceUsd < AGENT_PRICING.LOW_CREDIT_WARNING,
  };
}
