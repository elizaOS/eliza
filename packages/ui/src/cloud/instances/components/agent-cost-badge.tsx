/**
 * Compact cost indicator shown next to agent status in the table.
 * Shows the hourly rate and monthly estimate for a given agent state.
 */

"use client";

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import {
  formatHourlyRate,
  formatMonthlyEstimate,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@elizaos/ui/cloud-ui";
import { useT } from "../lib/i18n";

interface AgentCostBadgeProps {
  status: string;
}

export function AgentCostBadge({ status }: AgentCostBadgeProps) {
  const t = useT();
  const isRunning = status === "running" || status === "provisioning";
  const isIdle = status === "stopped" || status === "disconnected";

  if (!isRunning && !isIdle) return null;

  const rate = isRunning
    ? AGENT_PRICING.RUNNING_HOURLY_RATE
    : AGENT_PRICING.IDLE_HOURLY_RATE;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-[10px] text-white/30 font-mono tabular-nums cursor-help">
          <span
            className={`inline-block size-1 rounded-full ${isRunning ? "bg-green-500/60" : "bg-white/40"}`}
          />
          {formatHourlyRate(rate)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="bg-neutral-900 border-white/10 text-xs">
        <p className="font-medium text-white mb-0.5">
          {isRunning
            ? t("cloud.containers.costBadge.active", { defaultValue: "Active" })
            : t("cloud.containers.costBadge.idle", {
                defaultValue: "Idle",
              })}{" "}
          {t("cloud.containers.costBadge.agent", { defaultValue: "agent" })}
        </p>
        <p className="text-white/60">
          {formatHourlyRate(rate)} · {formatMonthlyEstimate(rate)}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
