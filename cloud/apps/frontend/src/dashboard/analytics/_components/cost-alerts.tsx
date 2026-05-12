/**
 * Cost alerts component displaying cost-related warnings and information.
 * Shows alerts for low balance, burn rate increases, and high projected costs.
 *
 * @param props - Cost alerts configuration
 * @param props.costTrending - Cost trending data
 * @param props.creditBalance - Current credit balance
 */

import { AlertTriangle, Info, TrendingDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CostAlertsProps {
  costTrending: {
    currentDailyBurn: number;
    burnChangePercent: number;
    daysUntilBalanceZero: number | null;
    projectedMonthlyBurn: number;
  };
  creditBalance: number;
}

export function CostAlerts({ costTrending, creditBalance }: CostAlertsProps) {
  const alerts: Array<{
    type: "warning" | "error" | "info";
    title: string;
    description: string;
  }> = [];

  if (costTrending.daysUntilBalanceZero !== null && costTrending.daysUntilBalanceZero < 7) {
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

  const numericBalance = Number(creditBalance);

  if (costTrending.projectedMonthlyBurn > numericBalance * 0.8) {
    alerts.push({
      type: "warning",
      title: "High Projected Monthly Cost",
      description: `At current burn rate, you'll spend $${costTrending.projectedMonthlyBurn.toFixed(2)} this month, which is ${((costTrending.projectedMonthlyBurn / numericBalance) * 100).toFixed(0)}% of your current balance.`,
    });
  }

  if (alerts.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-600/30 bg-emerald-500/10 p-5 text-sm text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/20 dark:text-emerald-100">
        <div className="flex items-start gap-4">
          <TrendingDown className="h-5 w-5 shrink-0" />
          <div className="space-y-2">
            <p className="font-semibold">All good</p>
            <p className="text-sm text-emerald-900/80 dark:text-emerald-50/80">
              Usage is tracking within healthy thresholds. You&apos;re trending below the projected
              monthly spend.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const toneClasses: Record<"warning" | "error" | "info", string> = {
    warning:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-100",
    error:
      "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/20 dark:text-rose-100",
    info: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/20 dark:text-sky-100",
  };

  const iconMap: Record<"warning" | "error" | "info", ReactNode> = {
    warning: <AlertTriangle className="h-5 w-5 shrink-0" />,
    error: <AlertTriangle className="h-5 w-5 shrink-0" />,
    info: <Info className="h-5 w-5 shrink-0" />,
  };

  return (
    <div className="grid gap-4">
      {alerts.map((alert, index) => (
        <div
          key={`${alert.title}-${index}`}
          className={cn(
            "rounded-xl border bg-background/80 p-5 text-sm shadow-sm",
            toneClasses[alert.type],
          )}
        >
          <div className="flex items-start gap-4">
            {iconMap[alert.type]}
            <div className="space-y-2">
              <p className="font-semibold leading-tight">{alert.title}</p>
              <p className="text-sm text-muted-foreground">{alert.description}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
