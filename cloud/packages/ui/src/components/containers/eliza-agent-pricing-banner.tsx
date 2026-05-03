/**
 * Pricing banner shown at the top of the agents page.
 * Displays current usage rates and estimated costs based on active agents.
 */

"use client";

import { Badge, BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Clock, DollarSign, TrendingDown, Zap } from "lucide-react";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import {
  estimateHoursRemaining,
  formatDuration,
  formatHourlyRate,
  formatMonthlyEstimate,
  formatUSD,
  MONTHLY_IDLE_COST,
  MONTHLY_RUNNING_COST,
} from "@/lib/constants/agent-pricing-display";

interface ElizaAgentPricingBannerProps {
  runningCount: number;
  idleCount: number;
  creditBalance: number;
}

export function ElizaAgentPricingBanner({
  runningCount,
  idleCount,
  creditBalance,
}: ElizaAgentPricingBannerProps) {
  const totalMonthlyCost = runningCount * MONTHLY_RUNNING_COST + idleCount * MONTHLY_IDLE_COST;

  const hoursRemaining = estimateHoursRemaining(creditBalance, runningCount, idleCount);

  const isLowBalance = creditBalance < AGENT_PRICING.LOW_CREDIT_WARNING;
  const hasAgents = runningCount + idleCount > 0;

  return (
    <BrandCard className="relative overflow-hidden">
      <CornerBrackets size="sm" className="opacity-30" />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 bg-[#FF5800]/10 border border-[#FF5800]/20">
              <DollarSign className="h-3.5 w-3.5 text-[#FF5800]" />
            </div>
            <p className="text-sm font-medium text-white">Usage & Rates</p>
          </div>
          {isLowBalance && hasAgents && (
            <Badge
              variant="outline"
              className="bg-amber-500/10 border-amber-500/30 text-amber-400 text-[10px] px-2"
            >
              Low balance
            </Badge>
          )}
        </div>

        {/* Rate cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/5 border border-white/10">
          {/* Running rate */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-emerald-400" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Running</p>
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
              <TrendingDown className="h-3 w-3 text-blue-400" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Idle</p>
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
              <DollarSign className="h-3 w-3 text-[#FF5800]" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Your Cost</p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {hasAgents ? `${formatUSD(totalMonthlyCost)}/mo` : "—"}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              {hasAgents ? `${runningCount} running · ${idleCount} idle` : "No agents"}
            </p>
          </div>

          {/* Time remaining */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 text-white/50" />
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Remaining</p>
            </div>
            <p
              className={`text-base font-mono font-semibold tabular-nums ${
                isLowBalance && hasAgents ? "text-amber-400" : "text-white"
              }`}
            >
              {hoursRemaining !== null ? formatDuration(hoursRemaining) : "—"}
            </p>
            <p className="text-[10px] text-white/30 font-mono">
              Balance: {formatUSD(creditBalance)}
            </p>
          </div>
        </div>

        {/* Minimum deposit note */}
        <p className="text-[10px] text-white/25 mt-3 font-mono">
          Min. {formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT)} · Suspends at{" "}
          {formatUSD(AGENT_PRICING.LOW_CREDIT_WARNING)}
        </p>
      </div>
    </BrandCard>
  );
}
