/**
 * Pricing banner shown at the top of the Instances page.
 * Displays current usage rates and estimated costs based on active agents.
 */

"use client";

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import {
  estimateHoursRemaining,
  formatDuration,
  formatHourlyRate,
  formatMonthlyEstimate,
  formatUSD,
  MONTHLY_IDLE_COST,
  MONTHLY_RUNNING_COST,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import { Badge, BrandCard, CornerBrackets } from "@elizaos/ui/cloud-ui";
import { Clock, DollarSign, TrendingDown, Zap } from "lucide-react";
import type { AgentHostingSummary } from "../lib/agent-hosting-cost";
import { useT } from "../lib/i18n";

interface ElizaAgentPricingBannerProps {
  hostingSummary: AgentHostingSummary;
  /** null = balance unavailable (e.g. still loading); renders as "—". */
  creditBalance: number | null;
}

export function ElizaAgentPricingBanner({
  hostingSummary,
  creditBalance,
}: ElizaAgentPricingBannerProps) {
  const t = useT();
  const { sharedCount, dedicatedRunningCount, dedicatedIdleCount } =
    hostingSummary;
  const totalMonthlyCost =
    dedicatedRunningCount * MONTHLY_RUNNING_COST +
    dedicatedIdleCount * MONTHLY_IDLE_COST;

  const hoursRemaining =
    creditBalance !== null
      ? estimateHoursRemaining(
          creditBalance,
          dedicatedRunningCount,
          dedicatedIdleCount,
        )
      : null;

  const hasDedicatedHosting = dedicatedRunningCount + dedicatedIdleCount > 0;
  const isLowBalance =
    hasDedicatedHosting &&
    creditBalance !== null &&
    creditBalance < AGENT_PRICING.LOW_CREDIT_WARNING;
  const hasAgents =
    sharedCount + dedicatedRunningCount + dedicatedIdleCount > 0;

  return (
    <BrandCard className="relative overflow-hidden">
      <CornerBrackets size="sm" className="opacity-30" />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 bg-white/5 border border-white/10">
              <DollarSign className="h-3.5 w-3.5 text-white/70" />
            </div>
            <p className="text-sm font-medium text-white">
              {t("cloud.containers.pricingBanner.usageRates", {
                defaultValue: "Usage & Rates",
              })}
            </p>
          </div>
          {isLowBalance && hasAgents && (
            <Badge
              variant="outline"
              className="bg-red-500/10 border-red-500/30 text-red-400 text-[10px] px-2"
            >
              {t("cloud.containers.pricingBanner.lowBalance", {
                defaultValue: "Low balance",
              })}
            </Badge>
          )}
        </div>

        {/* Rate cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/5 border border-white/10">
          {/* Running rate */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-green-400" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.dedicatedRunning", {
                  defaultValue: "Dedicated running",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              {formatMonthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE)}
            </p>
          </div>

          {/* Idle rate */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <TrendingDown className="h-3 w-3 text-white/60" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.dedicatedIdle", {
                  defaultValue: "Dedicated idle",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {formatHourlyRate(AGENT_PRICING.IDLE_HOURLY_RATE)}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              {formatMonthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE)}
            </p>
          </div>

          {/* Current burn */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <DollarSign className="h-3 w-3 text-white/70" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.yourCost", {
                  defaultValue: "Your Cost",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {hasAgents ? `${formatUSD(totalMonthlyCost)}/mo hosting` : "—"}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              {hasAgents
                ? t("cloud.containers.pricingBanner.hostingSummary", {
                    defaultValue:
                      "{{shared}} shared · {{run}} dedicated running · {{idle}} dedicated idle",
                    shared: sharedCount,
                    run: dedicatedRunningCount,
                    idle: dedicatedIdleCount,
                  })
                : t("cloud.containers.pricingBanner.noAgents", {
                    defaultValue: "No agents",
                  })}
            </p>
          </div>

          {/* Time remaining */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 text-white/50" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.remaining", {
                  defaultValue: "Remaining",
                })}
              </p>
            </div>
            <p
              className={`text-base font-mono font-semibold tabular-nums ${
                isLowBalance ? "text-red-400" : "text-white"
              }`}
            >
              {hoursRemaining !== null ? formatDuration(hoursRemaining) : "—"}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              {t("cloud.containers.pricingBanner.balance", {
                defaultValue: "Balance",
              })}
              : {creditBalance !== null ? formatUSD(creditBalance) : "—"}
            </p>
          </div>
        </div>

        <div className="space-y-1 mt-3">
          {sharedCount > 0 && (
            <p className="text-[10px] text-white/35 font-mono">
              {t("cloud.containers.pricingBanner.sharedUsage", {
                defaultValue:
                  "Shared runtime has no continuous hosting charge; model usage is billed separately based on usage.",
              })}
            </p>
          )}
          {hasDedicatedHosting && (
            <p className="text-[10px] text-white/25 font-mono">
              {t("cloud.containers.pricingBanner.minSuspend", {
                defaultValue: "Min. {{min}} · Suspends at {{warn}}",
                min: formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT),
                warn: formatUSD(AGENT_PRICING.LOW_CREDIT_WARNING),
              })}
            </p>
          )}
        </div>
      </div>
    </BrandCard>
  );
}
