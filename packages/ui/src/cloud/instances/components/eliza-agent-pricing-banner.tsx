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
import { useT } from "../lib/i18n";

interface ElizaAgentPricingBannerProps {
  runningCount: number;
  idleCount: number;
  /** null = balance unavailable (e.g. still loading); renders as "—". */
  creditBalance: number | null;
}

export function ElizaAgentPricingBanner({
  runningCount,
  idleCount,
  creditBalance,
}: ElizaAgentPricingBannerProps) {
  const t = useT();
  const totalMonthlyCost =
    runningCount * MONTHLY_RUNNING_COST + idleCount * MONTHLY_IDLE_COST;

  const hoursRemaining =
    creditBalance !== null
      ? estimateHoursRemaining(creditBalance, runningCount, idleCount)
      : null;

  const isLowBalance =
    creditBalance !== null && creditBalance < AGENT_PRICING.LOW_CREDIT_WARNING;
  const hasAgents = runningCount + idleCount > 0;

  return (
    <BrandCard className="relative overflow-hidden">
      <CornerBrackets size="sm" className="opacity-30" />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 bg-[var(--accent)]/10 border border-[var(--accent)]/20">
              <DollarSign className="h-3.5 w-3.5 text-[var(--accent)]" />
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
              className="bg-orange-500/10 border-orange-500/30 text-orange-400 text-[10px] px-2"
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
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                {t("cloud.containers.pricingBanner.running", {
                  defaultValue: "Running",
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
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                {t("cloud.containers.pricingBanner.idle", {
                  defaultValue: "Idle",
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
              <DollarSign className="h-3 w-3 text-[var(--accent)]" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                {t("cloud.containers.pricingBanner.yourCost", {
                  defaultValue: "Your Cost",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {hasAgents ? `${formatUSD(totalMonthlyCost)}/mo` : "—"}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              {hasAgents
                ? t("cloud.containers.pricingBanner.runningIdleSummary", {
                    defaultValue: "{{run}} running · {{idle}} idle",
                    run: runningCount,
                    idle: idleCount,
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
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                {t("cloud.containers.pricingBanner.remaining", {
                  defaultValue: "Remaining",
                })}
              </p>
            </div>
            <p
              className={`text-base font-mono font-semibold tabular-nums ${
                isLowBalance && hasAgents ? "text-orange-400" : "text-white"
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

        {/* Minimum deposit note */}
        <p className="text-[10px] text-white/25 mt-3 font-mono">
          {t("cloud.containers.pricingBanner.minSuspend", {
            defaultValue: "Min. {{min}} · Suspends at {{warn}}",
            min: formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT),
            warn: formatUSD(AGENT_PRICING.LOW_CREDIT_WARNING),
          })}
        </p>
      </div>
    </BrandCard>
  );
}
