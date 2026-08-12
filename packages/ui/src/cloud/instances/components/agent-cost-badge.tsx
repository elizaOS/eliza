/**
 * Compact cost indicator shown next to agent status in the table.
 * Shows the hourly rate and monthly estimate for a given agent state.
 * Sleeping (deactivated) agents render an explicit $0.00/hr: the hourly
 * billing cron only charges running/stopped-with-backup rows, so "no badge"
 * would hide the very fact deactivation exists to communicate.
 */

"use client";

import {
  formatHourlyRate,
  formatUSD,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import type { AgentHostingCostDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@elizaos/ui/cloud-ui";
import { useT } from "../lib/i18n";

interface AgentCostBadgeProps {
  status: string;
  hostingCost: AgentHostingCostDto;
}

function formatBadgeHourlyRate(rate: number, isIdle: boolean) {
  if (isIdle && rate > 0 && rate < 0.01) return "<$0.01/hr";
  return formatHourlyRate(rate);
}

export function AgentCostBadge({ status, hostingCost }: AgentCostBadgeProps) {
  const t = useT();
  const isShared = hostingCost.rateClass === "shared-usage";
  const isRunning = hostingCost.rateClass === "running";
  const isIdle = hostingCost.rateClass === "idle";
  const isSleeping = hostingCost.rateClass === "deactivated";
  const isActiveState = status === "running" || status === "provisioning";

  if (
    hostingCost.rateClass === "unavailable" ||
    hostingCost.hourlyRateUsd === null ||
    hostingCost.monthlyEstimateUsd === null
  )
    return null;

  const rate = hostingCost.hourlyRateUsd;
  const hourlyRateLabel = isShared
    ? t("cloud.containers.costBadge.usageBased", {
        defaultValue: "Usage-based",
      })
    : formatBadgeHourlyRate(rate, isIdle);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-[10px] text-white/30 font-mono tabular-nums cursor-help">
          <span
            className={`inline-block size-1 rounded-full ${isActiveState ? "bg-green-500/60" : "bg-white/40"}`}
          />
          {hourlyRateLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent className="bg-neutral-900 border-white/10 text-xs">
        {isShared ? (
          <>
            <p className="font-medium text-white mb-0.5">
              {t("cloud.containers.costBadge.sharedRuntime", {
                defaultValue: "Shared runtime",
              })}
            </p>
            <p className="text-white/60">
              {t("cloud.containers.costBadge.sharedRuntimeDetail", {
                defaultValue:
                  "No continuous hosting charge. Model usage is billed separately based on usage.",
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
                  "Not running — no hourly cost. Data is kept in an encrypted backup.",
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
              {hourlyRateLabel} · ~{formatUSD(hostingCost.monthlyEstimateUsd)}
              /mo
            </p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
