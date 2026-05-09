/**
 * Agent-specific pricing info card for the billing page.
 * Shows agent hosting rates, credit pack value comparison, and estimated runway.
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Clock, TrendingDown, Zap } from "lucide-react";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import {
  formatUSD,
  MONTHLY_IDLE_COST,
  MONTHLY_RUNNING_COST,
} from "@/lib/constants/agent-pricing-display";

interface AgentPricingInfoProps {
  currentCredits: number;
  /** Number of running agents (for runway calc). */
  runningAgents?: number;
  /** Number of idle agents (for runway calc). */
  idleAgents?: number;
}

export function AgentPricingInfo({
  currentCredits,
  runningAgents = 0,
  idleAgents = 0,
}: AgentPricingInfoProps) {
  const hourlyBurn =
    runningAgents * AGENT_PRICING.RUNNING_HOURLY_RATE + idleAgents * AGENT_PRICING.IDLE_HOURLY_RATE;

  const hasActiveAgents = runningAgents + idleAgents > 0;

  // Calculate runway
  const hoursLeft = hourlyBurn > 0 ? Math.floor(currentCredits / hourlyBurn) : null;
  const daysLeft = hoursLeft !== null ? Math.floor(hoursLeft / 24) : null;

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-30" />

      <div className="relative z-10 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-[#FF5800]" />
          <h3 className="text-sm font-mono text-white/80 uppercase tracking-wider">
            Agent Hosting Rates
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Running rate */}
          <div className="flex items-start gap-3 p-3 border border-white/5 bg-white/[0.02]">
            <div className="flex items-center justify-center w-8 h-8 bg-emerald-500/10 border border-emerald-500/20 shrink-0">
              <Zap className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-white/40 mb-0.5">Running agent</p>
              <p className="text-sm font-mono font-semibold text-white">
                {formatUSD(AGENT_PRICING.RUNNING_HOURLY_RATE)}/hr
              </p>
              <p className="text-[10px] text-white/30 font-mono">
                ~{formatUSD(MONTHLY_RUNNING_COST)}/mo
              </p>
            </div>
          </div>

          {/* Idle rate */}
          <div className="flex items-start gap-3 p-3 border border-white/5 bg-white/[0.02]">
            <div className="flex items-center justify-center w-8 h-8 bg-blue-500/10 border border-blue-500/20 shrink-0">
              <TrendingDown className="h-4 w-4 text-blue-400" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-white/40 mb-0.5">Idle agent</p>
              <p className="text-sm font-mono font-semibold text-white">
                {formatUSD(AGENT_PRICING.IDLE_HOURLY_RATE)}/hr
              </p>
              <p className="text-[10px] text-white/30 font-mono">
                ~{formatUSD(MONTHLY_IDLE_COST)}/mo
              </p>
            </div>
          </div>

          {/* Runway */}
          <div className="flex items-start gap-3 p-3 border border-white/5 bg-white/[0.02]">
            <div className="flex items-center justify-center w-8 h-8 bg-white/5 border border-white/10 shrink-0">
              <Clock className="h-4 w-4 text-white/50" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-white/40 mb-0.5">Your runway</p>
              {hasActiveAgents && daysLeft !== null ? (
                <>
                  <p
                    className={`text-sm font-mono font-semibold ${daysLeft < 3 ? "text-amber-400" : "text-white"}`}
                  >
                    {daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? "s" : ""}` : `${hoursLeft}h`}
                  </p>
                  <p className="text-[10px] text-white/30 font-mono">
                    {runningAgents} running · {idleAgents} idle
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-mono font-semibold text-white/40">—</p>
                  <p className="text-[10px] text-white/30 font-mono">No active agents</p>
                </>
              )}
            </div>
          </div>
        </div>

        <p className="text-[10px] text-white/20 font-mono">
          Min. {formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT)} · Never expires · Suspends at{" "}
          {formatUSD(AGENT_PRICING.LOW_CREDIT_WARNING)} · {AGENT_PRICING.GRACE_PERIOD_HOURS}h grace
        </p>
      </div>
    </BrandCard>
  );
}
