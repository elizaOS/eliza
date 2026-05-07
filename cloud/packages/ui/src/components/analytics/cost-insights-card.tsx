/**
 * Cost insights card component displaying cost trends and projections.
 * Shows burn rate, projected monthly spend, runway, and cost alerts.
 *
 * @param props - Cost insights card configuration
 * @param props.costTrending - Cost trending data including projections
 * @param props.creditBalance - Current credit balance
 */

import { Badge, BrandCard, Progress } from "@elizaos/cloud-ui";
import type { AnalyticsDataDto } from "@/types/cloud-api";
import { CostAlerts } from "@/packages/ui/src/components/analytics/cost-alerts";

interface CostInsightsCardProps {
  costTrending: AnalyticsDataDto["costTrending"];
  creditBalance: number;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function CostInsightsCard({ costTrending, creditBalance }: CostInsightsCardProps) {
  const numericBalance = Number(creditBalance);
  const projectedSpendPercent =
    numericBalance > 0
      ? Math.min(100, (costTrending.projectedMonthlyBurn / numericBalance) * 100)
      : 0;

  const runwayLabel =
    costTrending.daysUntilBalanceZero === null
      ? "Stable"
      : costTrending.daysUntilBalanceZero <= 1
        ? "< 1 day"
        : `${costTrending.daysUntilBalanceZero}d`;

  return (
    <BrandCard
      corners={false}
      className="border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent shadow-md dark:from-amber-500/10"
    >
      <div className="flex flex-col gap-2 p-6 pb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-white">Cost outlook</h3>
          <Badge
            variant="outline"
            className="border-amber-500/20 bg-amber-500/10 text-xs font-medium text-amber-300"
          >
            {costTrending.burnChangePercent > 0 ? "+" : ""}
            {costTrending.burnChangePercent.toFixed(1)}%
          </Badge>
        </div>
      </div>
      <div className="flex flex-col gap-5 p-6 pt-2">
        <div className="grid gap-4">
          <div className="grid gap-2 border border-amber-500/20 bg-black/35 p-4">
            <p className="text-xs uppercase tracking-wide text-white/50">Daily burn</p>
            <p className="text-2xl font-semibold text-white">
              {currencyFormatter.format(costTrending.currentDailyBurn)}
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs uppercase tracking-wide text-white/50">
              <span>Monthly projection</span>
              <span>{currencyFormatter.format(costTrending.projectedMonthlyBurn)}</span>
            </div>
            <Progress value={projectedSpendPercent} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="border border-amber-500/20 bg-black/35 p-3">
              <p className="text-xs uppercase tracking-wide text-white/50">Runway</p>
              <p className="text-lg font-semibold text-white">{runwayLabel}</p>
            </div>
            <div className="border border-amber-500/20 bg-black/35 p-3">
              <p className="text-xs uppercase tracking-wide text-white/50">Balance</p>
              <p className="text-lg font-semibold text-white">
                {currencyFormatter.format(creditBalance)}
              </p>
            </div>
          </div>
        </div>

        <CostAlerts costTrending={costTrending} creditBalance={creditBalance} />
      </div>
    </BrandCard>
  );
}
