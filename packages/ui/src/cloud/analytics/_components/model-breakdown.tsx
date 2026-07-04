/**
 * Model breakdown: cost / usage per AI model, expandable table.
 */

"use client";

import type { EnhancedAnalyticsDataDto } from "@elizaos/cloud-shared/types";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { toSuccessRatePercent } from "../lib/format";

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
  const t = useCloudT();
  const [expanded, setExpanded] = useState(false);
  const displayLimit = 5;
  const displayedModels = expanded ? models : models.slice(0, displayLimit);
  const hasMore = models.length > displayLimit;

  if (models.length === 0) {
    return (
      <Card className="border-border/70 bg-background/85">
        <CardHeader className="p-6 pb-5">
          <CardTitle className="text-base font-semibold">
            {t("cloud.analytics.modelBreakdown.title", {
              defaultValue: "Model breakdown",
            })}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("cloud.analytics.modelBreakdown.noData", {
              defaultValue: "No model data available for the selected period.",
            })}
          </p>
        </CardHeader>
      </Card>
    );
  }

  const totalCost = models.reduce(
    (sum: number, m: (typeof models)[0]) => sum + m.totalCost,
    0,
  );
  const totalRequests = models.reduce(
    (sum: number, m: (typeof models)[0]) => sum + m.totalRequests,
    0,
  );

  return (
    <Card className="border-border/70 bg-background/85">
      <CardHeader className="flex flex-col gap-3 p-6 pb-5">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base font-semibold">
            {t("cloud.analytics.modelBreakdown.title", {
              defaultValue: "Model breakdown",
            })}
          </CardTitle>
          <Badge variant="outline" className="rounded-full text-xs">
            {t("cloud.analytics.modelBreakdown.count", {
              defaultValue: "{{n}} model{{plural}}",
              n: models.length,
              plural: models.length !== 1 ? "s" : "",
            })}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("cloud.analytics.modelBreakdown.subtitle", {
            defaultValue:
              "Detailed usage statistics and cost analysis per model with efficiency metrics.",
          })}
        </p>
      </CardHeader>
      <CardContent className="min-w-0 border-t border-border/60 p-4 sm:p-6">
        <div className="min-w-0 space-y-4">
          <div className="max-w-full overflow-x-auto">
            <table className="min-w-[640px] w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="pb-3 text-left font-medium text-muted-foreground">
                    {t("cloud.analytics.modelBreakdown.col.model", {
                      defaultValue: "Model",
                    })}
                  </th>
                  <th className="pb-3 text-left font-medium text-muted-foreground">
                    {t("cloud.analytics.modelBreakdown.col.provider", {
                      defaultValue: "Provider",
                    })}
                  </th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">
                    {t("cloud.analytics.modelBreakdown.col.requests", {
                      defaultValue: "Requests",
                    })}
                  </th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">
                    {t("cloud.analytics.modelBreakdown.col.cost", {
                      defaultValue: "Cost",
                    })}
                  </th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">
                    {t("cloud.analytics.modelBreakdown.col.tokens", {
                      defaultValue: "Tokens",
                    })}
                  </th>
                  <th className="pb-3 text-right font-medium text-muted-foreground">
                    {t("cloud.analytics.modelBreakdown.col.success", {
                      defaultValue: "Success",
                    })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedModels.map((model: (typeof models)[0]) => (
                  <tr
                    key={`${model.model}-${model.provider}`}
                    className="border-b border-border/30 last:border-0"
                  >
                    <td className="py-3 font-medium text-foreground">
                      {model.model}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {model.provider}
                    </td>
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
                      <span className="text-green-600 dark:text-green-400">
                        {toSuccessRatePercent(model.successRate).toFixed(1)}%
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
                    {t("cloud.analytics.modelBreakdown.showLess", {
                      defaultValue: "Show less",
                    })}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4" />
                    {t("cloud.analytics.modelBreakdown.showMore", {
                      defaultValue: "Show {{n}} more",
                      n: models.length - displayLimit,
                    })}
                  </>
                )}
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 rounded-sm border border-border/60 bg-muted/30 p-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("cloud.analytics.modelBreakdown.totalRequests", {
                  defaultValue: "Total requests",
                })}
              </p>
              <p className="text-lg font-semibold text-foreground">
                {numberFormatter.format(totalRequests)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("cloud.analytics.modelBreakdown.totalCost", {
                  defaultValue: "Total cost",
                })}
              </p>
              <p className="text-lg font-semibold text-foreground">
                ${formatCurrency(totalCost)}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
