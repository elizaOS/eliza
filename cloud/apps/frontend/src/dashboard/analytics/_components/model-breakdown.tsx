/**
 * Model breakdown component displaying cost and usage by AI model.
 * Shows expandable list with cost, requests, and token usage per model.
 *
 * @param props - Model breakdown configuration
 * @param props.models - Array of model usage data
 */

"use client";

import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@elizaos/cloud-ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { EnhancedAnalyticsDataDto } from "@/types/cloud-api";

interface ModelBreakdownProps {
  models: EnhancedAnalyticsDataDto["modelBreakdown"];
}

const numberFormatter = new Intl.NumberFormat();

const formatCurrency = (amount: number) => {
  return `${amount.toFixed(2)}`;
};

const formatTokens = (tokens: number) => {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
};

export function ModelBreakdown({ models }: ModelBreakdownProps) {
  const [expanded, setExpanded] = useState(false);
  const displayLimit = 5;
  const displayedModels = expanded ? models : models.slice(0, displayLimit);
  const hasMore = models.length > displayLimit;

  if (models.length === 0) {
    return (
      <Card className="border-border/70 bg-background/60 shadow-sm">
        <CardHeader className="p-6 pb-5">
          <CardTitle className="text-base font-semibold">Model breakdown</CardTitle>
          <p className="text-sm text-muted-foreground">
            No model data available for the selected period.
          </p>
        </CardHeader>
      </Card>
    );
  }

  const totalCost = models.reduce((sum: number, m: (typeof models)[0]) => sum + m.totalCost, 0);
  const totalRequests = models.reduce(
    (sum: number, m: (typeof models)[0]) => sum + m.totalRequests,
    0,
  );

  return (
    <Card className="border-border/70 bg-background/60 shadow-sm">
      <CardHeader className="flex flex-col gap-3 p-6 pb-5">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base font-semibold">Model breakdown</CardTitle>
          <Badge variant="outline" className="rounded-full text-xs">
            {models.length} model{models.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Detailed usage statistics and cost analysis per model with efficiency metrics.
        </p>
      </CardHeader>
      <CardContent className="border-t border-border/60 p-6">
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="pb-3 text-left font-medium text-muted-foreground">Model</th>
                  <th className="pb-3 text-left font-medium text-muted-foreground">Provider</th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">Requests</th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">Cost</th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">Tokens</th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">Success</th>
                </tr>
              </thead>
              <tbody>
                {displayedModels.map((model: (typeof models)[0]) => (
                  <tr
                    key={`${model.model}-${model.provider}`}
                    className="border-b border-border/30 last:border-0"
                  >
                    <td className="py-3 font-medium text-foreground">{model.model}</td>
                    <td className="py-3 text-muted-foreground">{model.provider}</td>
                    <td className="py-3 text-right tabular-nums text-foreground">
                      {numberFormatter.format(model.totalRequests)}
                    </td>
                    <td className="py-3 text-right tabular-nums text-foreground">
                      ${formatCurrency(model.totalCost)}
                    </td>
                    <td className="py-3 text-right tabular-nums text-muted-foreground">
                      {formatTokens(model.totalTokens)}
                    </td>
                    <td className="py-3 text-right tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {(model.successRate * 100).toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExpanded(!expanded)}
                className="gap-2"
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-4 w-4" />
                    Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4" />
                    Show {models.length - displayLimit} more
                  </>
                )}
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 rounded-lg border border-border/60 bg-muted/30 p-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Total requests</p>
              <p className="text-lg font-semibold text-foreground">
                {numberFormatter.format(totalRequests)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Total cost</p>
              <p className="text-lg font-semibold text-foreground">${formatCurrency(totalCost)}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
