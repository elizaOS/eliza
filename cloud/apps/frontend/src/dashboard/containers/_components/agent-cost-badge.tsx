/**
 * Compact cost indicator shown next to agent status in the table.
 * Shows the hourly rate and monthly estimate for a given agent state.
 */

"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@elizaos/cloud-ui";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { formatHourlyRate, formatMonthlyEstimate } from "@/lib/constants/agent-pricing-display";

interface AgentCostBadgeProps {
  status: string;
}

export function AgentCostBadge({ status }: AgentCostBadgeProps) {
  const isRunning = status === "running" || status === "provisioning";
  const isIdle = status === "stopped" || status === "disconnected";

  // Only show cost for active or idle agents
  if (!isRunning && !isIdle) return null;

  const rate = isRunning ? AGENT_PRICING.RUNNING_HOURLY_RATE : AGENT_PRICING.IDLE_HOURLY_RATE;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-[10px] text-white/30 font-mono tabular-nums cursor-help">
          <span
            className={`inline-block size-1 rounded-full ${isRunning ? "bg-emerald-500/60" : "bg-blue-500/40"}`}
          />
          {formatHourlyRate(rate)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="bg-neutral-900 border-white/10 text-xs">
        <p className="font-medium text-white mb-0.5">{isRunning ? "Active" : "Idle"} agent</p>
        <p className="text-white/60">
          {formatHourlyRate(rate)} · {formatMonthlyEstimate(rate)}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
