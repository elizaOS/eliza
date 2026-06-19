/**
 * Projections chart component displaying historical and projected cost trends.
 * Shows area chart with alerts for low balance and high burn rate.
 *
 * @param props - Projections chart configuration
 * @param props.data - Projections data including historical and projected values
 */

"use client";

import { formatUsd as formatCurrency } from "@elizaos/shared/utils/format";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@elizaos/ui";
import { format } from "date-fns";
import { Activity, AlertTriangle, Info, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { useT } from "@/providers/I18nProvider";
import type { ProjectionsDataDto } from "@/types/cloud-api";

interface ProjectionsChartProps {
  data: ProjectionsDataDto;
}

export function ProjectionsChart({ data }: ProjectionsChartProps) {
  const t = useT();
  const { projections, alerts, creditBalance } = data;

  const chartConfig = {
    historical: {
      label: t("cloud.projectionsChart.historical", {
        defaultValue: "Historical",
      }),
      color: "#FF5800",
    },
    projected: {
      label: t("cloud.projectionsChart.projected", {
        defaultValue: "Projected",
      }),
      color: "#F59E0B",
    },
  } as const;

  const chartData = useMemo(() => {
    return projections.map((point) => ({
      date: format(new Date(point.timestamp), "MMM d"),
      fullDate: format(new Date(point.timestamp), "MMM d, yyyy"),
      cost: point.totalCost,
      requests: point.totalRequests,
      isProjected: point.isProjected,
      confidence: point.confidence,
    }));
  }, [projections]);

  const todayIndex = chartData.findIndex((d) => !d.isProjected);
  const lastHistoricalDate =
    todayIndex >= 0
      ? chartData[chartData.length - todayIndex - 1]?.fullDate
      : "";

  const getAlertIcon = (type: "warning" | "danger" | "info") => {
    switch (type) {
      case "danger":
        return AlertTriangle;
      case "warning":
        return TrendingUp;
      case "info":
        return Info;
    }
  };

  const getAlertVariant = (type: "warning" | "danger" | "info") => {
    switch (type) {
      case "danger":
        return "destructive" as const;
      case "warning":
        return "default" as const;
      case "info":
        return "default" as const;
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-border/70 bg-background/60 shadow-sm">
        <CardHeader className="flex flex-col gap-3 p-6 pb-5">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base font-semibold">
              {t("cloud.projectionsChart.title", {
                defaultValue: "Usage projections",
              })}
            </CardTitle>
            <Badge
              variant="outline"
              className="rounded-full text-xs"
              title={t("cloud.projectionsChart.predictiveAnalytics", {
                defaultValue: "Predictive analytics",
              })}
            >
              <Activity className="mr-1 h-3 w-3" />
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="border-t border-border/60 p-6">
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div className="rounded-sm border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("cloud.projectionsChart.balance", {
                    defaultValue: "Balance",
                  })}
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {formatCurrency(creditBalance)}
                </p>
              </div>
              <div className="rounded-sm border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("cloud.projectionsChart.historicalPoints", {
                    defaultValue: "Historical points",
                  })}
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {chartData.filter((d) => !d.isProjected).length}
                </p>
              </div>
              <div className="rounded-sm border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("cloud.projectionsChart.projectedPoints", {
                    defaultValue: "Projected points",
                  })}
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {chartData.filter((d) => d.isProjected).length}
                </p>
              </div>
            </div>

            <ChartContainer
              config={chartConfig}
              className="h-[340px] w-full rounded-sm border border-border/70 bg-background/70 p-5 sm:p-6"
            >
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient
                    id="fill-historical"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="5%"
                      stopColor={chartConfig.historical.color}
                      stopOpacity={0.3}
                    />
                    <stop
                      offset="95%"
                      stopColor={chartConfig.historical.color}
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={70}
                  tickFormatter={(value) => {
                    if (value >= 1000) {
                      return `$${(value / 1000).toFixed(1)}k`;
                    }
                    return `$${value.toFixed(0)}`;
                  }}
                />
                <ChartTooltip
                  cursor={{ strokeDasharray: "4 4" }}
                  content={
                    <ChartTooltipContent
                      hideIndicator
                      formatter={(value) => {
                        const numeric = Number(value);
                        return formatCurrency(numeric);
                      }}
                      labelFormatter={(_, payload) => {
                        const source = payload?.[0];
                        if (
                          source &&
                          typeof source === "object" &&
                          "payload" in source
                        ) {
                          interface TooltipPayload {
                            payload?: {
                              fullDate?: string;
                              isProjected?: boolean;
                              confidence?: number;
                            };
                          }
                          const inner = source as TooltipPayload;
                          const fullDate = inner.payload?.fullDate ?? "";
                          const isProjected = inner.payload?.isProjected;
                          const confidence = inner.payload?.confidence;

                          if (isProjected && confidence) {
                            return t("cloud.projectionsChart.confidenceLabel", {
                              date: fullDate,
                              confidence,
                              defaultValue:
                                "{{date}} ({{confidence}}% confidence)",
                            });
                          }
                          return fullDate;
                        }
                        return "";
                      }}
                    />
                  }
                />

                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke={chartConfig.historical.color}
                  fill="url(#fill-historical)"
                  strokeWidth={2}
                  dot={false}
                  name={t("cloud.projectionsChart.cost", {
                    defaultValue: "Cost",
                  })}
                />

                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke={chartConfig.projected.color}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  connectNulls={false}
                />

                {lastHistoricalDate && (
                  <ReferenceLine
                    x={lastHistoricalDate}
                    stroke="#6B7280"
                    strokeDasharray="2 2"
                    label={{
                      value: t("cloud.projectionsChart.today", {
                        defaultValue: "Today",
                      }),
                      position: "top",
                    }}
                  />
                )}
              </AreaChart>
            </ChartContainer>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: chartConfig.historical.color }}
                />
                <span className="text-muted-foreground">
                  {t("cloud.projectionsChart.historicalData", {
                    defaultValue: "Historical data",
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full opacity-70"
                  style={{ backgroundColor: chartConfig.projected.color }}
                />
                <span className="text-muted-foreground">
                  {t("cloud.projectionsChart.projectedVariance", {
                    defaultValue: "Projected (with variance)",
                  })}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {alerts.length > 0 && (
        <Card className="border-border/70 bg-background/60 shadow-sm">
          <CardHeader className="p-6 pb-5">
            <CardTitle className="text-base font-semibold">
              {t("cloud.projectionsChart.projectionAlerts", {
                defaultValue: "Projection alerts",
              })}
            </CardTitle>
          </CardHeader>
          <CardContent className="border-t border-border/60 p-6">
            <div className="space-y-3">
              {alerts.map((alert, index) => {
                const Icon = getAlertIcon(alert.type);
                const severity =
                  alert.severity ??
                  (alert.type === "danger" ? "critical" : alert.type);
                return (
                  <Alert
                    key={alert.eventId ?? index}
                    data-alert-event-id={alert.eventId}
                    data-alert-severity={severity}
                    variant={getAlertVariant(alert.type)}
                  >
                    <Icon className="h-4 w-4" />
                    <AlertTitle>{alert.title}</AlertTitle>
                    <AlertDescription className="mt-2">
                      {alert.message}
                      {alert.projectedValue !== undefined && (
                        <span className="ml-2 font-medium">
                          ({formatCurrency(alert.projectedValue)})
                        </span>
                      )}
                    </AlertDescription>
                  </Alert>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
