/**
 * Compact cost indicator shown next to agent status in the table.
 * Shows the hourly rate and monthly estimate for a given agent state.
 * Sleeping (deactivated) agents render an explicit $0.00/hr: the hourly
 * billing cron only charges running/stopped-with-backup rows, so "no badge"
 * would hide the very fact deactivation exists to communicate.
 */

"use client";

import type { AgentExecutionTier } from "@elizaos/cloud-sdk";
import {
  AGENT_PRICING,
  formatHourlyRate,
  formatMonthlyEstimate,
} from "@elizaos/cloud-sdk/browser-contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@elizaos/ui/cloud-ui";
import { useT } from "../lib/i18n";

interface AgentCostBadgeProps {
  status: string;
  executionTier: AgentExecutionTier;
}

function formatBadgeHourlyRate(rate: number, isIdle: boolean) {
  if (isIdle && rate > 0 && rate < 0.01) return "<$0.01/hr";
  return formatHourlyRate(rate);
}

export function AgentCostBadge({ status, executionTier }: AgentCostBadgeProps) {
  const t = useT();
  const isShared = executionTier === "shared";
  const isRunning = status === "running" || status === "provisioning";
  const isIdle = status === "stopped" || status === "disconnected";
  const isSleeping = status === "sleeping";

  if (!isShared && !isRunning && !isIdle && !isSleeping) return null;

  const rate = isRunning
    ? AGENT_PRICING.RUNNING_HOURLY_RATE
    : isIdle
      ? AGENT_PRICING.IDLE_HOURLY_RATE
      : 0;
  const hourlyRateLabel = isShared
    ? t("cloud.agents.detail.sharedFree", { defaultValue: "Free" })
    : formatBadgeHourlyRate(rate, isIdle);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-[10px] text-white/30 font-mono tabular-nums cursor-help">
          <span
            className={`inline-block size-1 rounded-full ${isRunning ? "bg-green-500/60" : "bg-white/40"}`}
          />
          {hourlyRateLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent className="bg-neutral-900 border-white/10 text-xs">
        {isShared ? (
          <>
            <p className="font-medium text-white mb-0.5">
              {t("cloud.agents.detail.sharedAgent", {
                defaultValue: "Shared Agent",
              })}
            </p>
            <p className="text-white/60">
              {t("cloud.agents.detail.sharedIncluded", {
                defaultValue: "Included at no hourly cost",
              })}
            </p>
          </>
        ) : isSleeping ? (
          <>
            <p className="font-medium text-white mb-0.5">
              {t("cloud.containers.costBadge.deactivated", {
                defaultValue: "Deactivated agent",
              })}
            </p>
            <p className="text-white/60">
              {t("cloud.containers.costBadge.deactivatedDetail", {
                defaultValue:
                  "Not running — no hourly cost. Your agent data is retained.",
              })}
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-white mb-0.5">
              {isRunning
                ? t("cloud.containers.costBadge.active", {
                    defaultValue: "Active",
                  })
                : t("cloud.containers.costBadge.idle", {
                    defaultValue: "Idle",
                  })}{" "}
              {t("cloud.containers.costBadge.agent", { defaultValue: "agent" })}
            </p>
            <p className="text-white/60">
              {hourlyRateLabel} · {formatMonthlyEstimate(rate)}
            </p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
