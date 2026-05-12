/**
 * Provider breakdown component displaying cost and usage by AI provider.
 * Shows cost distribution with progress bars and percentage breakdowns.
 *
 * @param props - Provider breakdown configuration
 * @param props.providers - Array of provider usage data
 */

"use client";

import { Badge, Card, CardContent, CardHeader, CardTitle, Progress } from "@elizaos/cloud-ui";
import type { EnhancedAnalyticsDataDto } from "@/types/cloud-api";

interface ProviderBreakdownProps {
  providers: EnhancedAnalyticsDataDto["providerBreakdown"];
}

const numberFormatter = new Intl.NumberFormat();

const formatCurrency = (amount: number) => {
  return `${amount.toFixed(2)}`;
};

export function ProviderBreakdown({ providers }: ProviderBreakdownProps) {
  if (providers.length === 0) {
    return (
      <Card className="border-border/70 bg-background/60 shadow-sm">
        <CardHeader className="p-6 pb-5">
          <CardTitle className="text-base font-semibold">Provider breakdown</CardTitle>
          <p className="text-sm text-muted-foreground">
            No provider data available for the selected period.
          </p>
        </CardHeader>
      </Card>
    );
  }

  const totalCost = providers.reduce(
    (sum: number, p: (typeof providers)[0]) => sum + p.totalCost,
    0,
  );

  return (
    <Card className="border-border/70 bg-background/60 shadow-sm">
      <CardHeader className="flex flex-col gap-3 p-6 pb-5">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base font-semibold">Provider breakdown</CardTitle>
          <Badge variant="outline" className="rounded-full text-xs">
            {providers.length} provider{providers.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Usage distribution across AI providers with cost allocation and success metrics.
        </p>
      </CardHeader>
      <CardContent className="border-t border-border/60 p-6">
        <div className="space-y-6">
          {providers.map((provider: (typeof providers)[0], index: number) => (
            <div key={provider.provider} className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{provider.provider}</span>
                    <Badge variant="outline" className="rounded-full bg-background/80 text-xs">
                      {provider.percentage.toFixed(1)}%
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{numberFormatter.format(provider.totalRequests)} requests</span>
                    <span>${formatCurrency(provider.totalCost)} spent</span>
                    <span>{numberFormatter.format(provider.totalTokens)} tokens</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {(provider.successRate * 100).toFixed(1)}% success
                    </span>
                  </div>
                </div>
              </div>
              <Progress value={provider.percentage} className="h-2" />
              {index < providers.length - 1 && <div className="border-b border-border/50" />}
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-lg border border-border/60 bg-muted/30 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-muted-foreground">Total across all providers</span>
            <span className="font-semibold text-foreground">${formatCurrency(totalCost)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
