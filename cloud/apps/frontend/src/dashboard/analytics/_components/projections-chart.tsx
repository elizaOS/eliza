/**
 * Projections chart component displaying historical and projected cost trends.
 * Shows area chart with alerts for low balance and high burn rate.
 *
 * @param props - Projections chart configuration
 * @param props.data - Projections data including historical and projected values
 */

"use client";

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
} from "@elizaos/cloud-ui";
import { format } from "date-fns";
import { Activity, AlertTriangle, Info, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import type { ProjectionsDataDto } from "@/types/cloud-api";

interface ProjectionsChartProps {
  data: ProjectionsDataDto;
}

const chartConfig = {
  historical: {
    label: "Historical",
    color: "#3B82F6",
  },
  projected: {
    label: "Projected",
    color: "#F59E0B",
  },
} as const;

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

export function ProjectionsChart({ data }: ProjectionsChartProps) {
  const { projections, alerts, creditBalance } = data;

  const chartData = useMemo(() => {
    return projections.map((point) => ({
      date: format(point.timestamp, "MMM d"),
      fullDate: format(point.timestamp, "MMM d, yyyy"),
      cost: point.totalCost,
      requests: point.totalRequests,
      isProjected: point.isProjected,
      confidence: point.confidence,
    }));
  }, [projections]);

  const todayIndex = chartData.findIndex((d) => !d.isProjected);
  const lastHistoricalDate =
    todayIndex >= 0 ? chartData[chartData.length - todayIndex - 1]?.fullDate : "";

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
            <CardTitle className="text-base font-semibold">Usage projections</CardTitle>
            <Badge variant="outline" className="rounded-full text-xs">
              <Activity className="mr-1 h-3 w-3" />
              Predictive analytics
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Linear regression-based forecasting with confidence intervals. Projects future costs
            based on historical trends.
          </p>
        </CardHeader>
        <CardContent className="border-t border-border/60 p-6">
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Balance
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {formatCurrency(creditBalance)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Historical points
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {chartData.filter((d) => !d.isProjected).length}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Projected points
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {chartData.filter((d) => d.isProjected).length}
                </p>
              </div>
            </div>

            <ChartContainer
              config={chartConfig}
              className="h-[340px] w-full rounded-2xl border border-border/70 bg-background/70 p-5 sm:p-6"
            >
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="fill-historical" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartConfig.historical.color} stopOpacity={0.3} />
                    <stop
                      offset="95%"
                      stopColor={chartConfig.historical.color}
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
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
                        if (source && typeof source === "object" && "payload" in source) {
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
                            return `${fullDate} (${confidence}% confidence)`;
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
                  name="Cost"
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
                    label={{ value: "Today", position: "top" }}
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
                <span className="text-muted-foreground">Historical data</span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full opacity-70"
                  style={{ backgroundColor: chartConfig.projected.color }}
                />
                <span className="text-muted-foreground">Projected (with variance)</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {alerts.length > 0 && (
        <Card className="border-border/70 bg-background/60 shadow-sm">
          <CardHeader className="p-6 pb-5">
            <CardTitle className="text-base font-semibold">Projection alerts</CardTitle>
            <p className="text-sm text-muted-foreground">
              Automated insights based on trend analysis and forecasting.
            </p>
          </CardHeader>
          <CardContent className="border-t border-border/60 p-6">
            <div className="space-y-3">
              {alerts.map((alert, index) => {
                const Icon = getAlertIcon(alert.type);
                const severity =
                  alert.severity ?? (alert.type === "danger" ? "critical" : alert.type);
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
