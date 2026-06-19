import { AlertTriangle, Info, TrendingDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import type { AnalyticsCostTrendingDto } from "../../types/cloud-api";

type CostAlertsTrending = AnalyticsCostTrendingDto;

interface CostAlertsProps {
  costTrending: CostAlertsTrending;
  creditBalance: number;
}

export function CostAlerts({ costTrending }: CostAlertsProps) {
  const alerts: Array<{
    type: "warning" | "error" | "info";
    title: string;
    description: string;
  }> = [];

  if (
    costTrending.daysUntilBalanceZero !== null &&
    costTrending.daysUntilBalanceZero < 7
  ) {
    alerts.push({
      type: "error",
      title: "Low Balance",
      description: `Your organization will run out of balance in ${costTrending.daysUntilBalanceZero} days at current burn rate. Consider adding funds.`,
    });
  }

  if (costTrending.burnChangePercent > 50) {
    alerts.push({
      type: "warning",
      title: "Burn Rate Increased",
      description: `Your daily burn rate increased by ${costTrending.burnChangePercent.toFixed(0)}% compared to yesterday. Monitor usage closely.`,
    });
  }

  if (costTrending.burnAlertThresholdExceeded) {
    alerts.push({
      type: "warning",
      title: "High Projected Monthly Cost",
      description: `At current burn rate, you'll spend $${costTrending.projectedMonthlyBurn.toFixed(2)} this month, which is ${costTrending.monthlyBurnPercent.toFixed(0)}% of your current balance.`,
    });
  }

  if (alerts.length === 0) {
    return (
      <div className="rounded-sm border border-white/10 bg-white/[0.04] p-5 text-sm text-white">
        <div className="flex items-start gap-4">
          <TrendingDown className="h-5 w-5 shrink-0" />
          <div className="space-y-2">
            <p className="font-semibold">All good</p>
            <p className="text-sm text-white/70">
              Usage is tracking within healthy thresholds.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const toneClasses: Record<"warning" | "error" | "info", string> = {
    warning: "border-[#FF5800]/40 bg-[#FF5800]/10 text-white",
    error: "border-[#FF5800] bg-[#FF5800] text-black",
    info: "border-[#0B35F1]/40 bg-[#0B35F1]/10 text-white",
  };

  const iconMap: Record<"warning" | "error" | "info", ReactNode> = {
    warning: <AlertTriangle className="h-5 w-5 shrink-0" />,
    error: <AlertTriangle className="h-5 w-5 shrink-0" />,
    info: <Info className="h-5 w-5 shrink-0" />,
  };

  return (
    <div className="grid gap-4">
      {alerts.map((alert) => (
        <div
          key={alert.title}
          className={cn(
            "rounded-sm border bg-background/80 p-5 text-sm ",
            toneClasses[alert.type],
          )}
        >
          <div className="flex items-start gap-4">
            {iconMap[alert.type]}
            <div className="space-y-2">
              <p className="font-semibold leading-tight">{alert.title}</p>
              <p className="text-sm text-muted-foreground">
                {alert.description}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export type { CostAlertsProps, CostAlertsTrending };
