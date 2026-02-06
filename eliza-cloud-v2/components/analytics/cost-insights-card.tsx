/**
 * Cost insights card component displaying cost trends and projections.
 * Shows burn rate, projected monthly spend, runway, and cost alerts.
 *
 * @param props - Cost insights card configuration
 * @param props.costTrending - Cost trending data including projections
 * @param props.creditBalance - Current credit balance
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { AnalyticsData } from "@/lib/actions/analytics";
import { CostAlerts } from "@/components/analytics/cost-alerts";

interface CostInsightsCardProps {
  costTrending: AnalyticsData["costTrending"];
  creditBalance: number;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function CostInsightsCard({
  costTrending,
  creditBalance,
}: CostInsightsCardProps) {
  const numericBalance = Number(creditBalance);
  const projectedSpendPercent =
    numericBalance > 0
      ? Math.min(
          100,
          (costTrending.projectedMonthlyBurn / numericBalance) * 100,
        )
      : 0;

  const runwayLabel =
    costTrending.daysUntilBalanceZero === null
      ? "Stable"
      : costTrending.daysUntilBalanceZero <= 1
        ? "< 1 day"
        : `${costTrending.daysUntilBalanceZero}d`;

  return (
    <Card className="border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent shadow-md dark:from-amber-500/10">
      <CardHeader className="gap-2 p-6 pb-4">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base font-semibold">
            Cost outlook
          </CardTitle>
          <Badge
            variant="outline"
            className="border-transparent bg-amber-500/10 text-xs font-medium text-amber-600 dark:text-amber-200"
          >
            {costTrending.burnChangePercent > 0 ? "+" : ""}
            {costTrending.burnChangePercent.toFixed(1)}%
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-6 pt-2">
        <div className="grid gap-4">
          <div className="grid gap-2 rounded-xl border border-amber-500/20 bg-background/70 p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground/80">
              Daily burn
            </p>
            <p className="text-2xl font-semibold text-foreground">
              {currencyFormatter.format(costTrending.currentDailyBurn)}
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground/80">
              <span>Monthly projection</span>
              <span>
                {currencyFormatter.format(costTrending.projectedMonthlyBurn)}
              </span>
            </div>
            <Progress value={projectedSpendPercent} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-amber-500/20 bg-background/70 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground/80">
                Runway
              </p>
              <p className="text-lg font-semibold text-foreground">
                {runwayLabel}
              </p>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-background/70 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground/80">
                Balance
              </p>
              <p className="text-lg font-semibold text-foreground">
                {currencyFormatter.format(creditBalance)}
              </p>
            </div>
          </div>
        </div>

        <CostAlerts costTrending={costTrending} creditBalance={creditBalance} />
      </CardContent>
    </Card>
  );
}
