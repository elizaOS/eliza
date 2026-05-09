/**
 * Usage chart component displaying time-series analytics data.
 * Supports multiple metrics (requests, cost, success rate) with toggleable display.
 *
 * @param props - Usage chart configuration
 * @param props.data - Time-series data array
 * @param props.granularity - Time granularity (hour, day, week, month)
 */

"use client";

import {
  Badge,
  Button,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@elizaos/cloud-ui";
import { format } from "date-fns";
import { useCallback, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";

type MetricKey = "requests" | "cost" | "successRate";

interface UsageChartProps {
  data: Array<{
    timestamp: Date | string;
    totalRequests: number;
    totalCost: number;
    successRate: number;
  }>;
  granularity: "hour" | "day" | "week" | "month";
}

const chartConfig = {
  requests: {
    label: "Requests",
    color: "#6366F1",
  },
  cost: {
    label: "Cost (USD)",
    color: "#22C55E",
  },
  successRate: {
    label: "Success rate (%)",
    color: "#F97316",
  },
} as const;

const metricDescriptions: Record<MetricKey, string> = {
  requests: "Raw throughput captured at the selected cadence.",
  cost: "Total cost in USD for the interval.",
  successRate: "Share of successful calls over total attempts.",
};

export function UsageChart({ data, granularity }: UsageChartProps) {
  const [activeMetric, setActiveMetric] = useState<MetricKey>("requests");

  const formatDate = useCallback(
    (date: Date) => {
      const formatMap = {
        hour: "MMM d, HH:mm",
        day: "MMM d",
        week: "MMM d",
        month: "MMM yyyy",
      } as const;
      return format(date, formatMap[granularity]);
    },
    [granularity],
  );

  const detailedDate = useCallback((date: Date) => format(date, "MMM d, yyyy · HH:mm"), []);

  const chartData = useMemo(
    () =>
      data.map((point) => {
        const timestamp = new Date(point.timestamp);
        return {
          timestamp,
          label: formatDate(timestamp),
          fullLabel: detailedDate(timestamp),
          requests: point.totalRequests,
          cost: point.totalCost,
          successRate: Number((point.successRate * 100).toFixed(2)),
        };
      }),
    // formatDate depends on granularity, so both are needed
    [data, formatDate, detailedDate],
  );

  const latestPoint = chartData.at(-1);

  const activeColor = chartConfig[activeMetric].color;

  const formatMetricValue = (value: number | undefined) => {
    if (value === undefined) return "–";
    if (activeMetric === "successRate") {
      return `${value.toFixed(1)}%`;
    }
    if (activeMetric === "cost") {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    }
    return value.toLocaleString();
  };

  const yAxisProps = useMemo(() => {
    if (activeMetric === "successRate") {
      return {
        domain: [0, 100] as [number, number],
        tickFormatter: (value: number) => `${value}%`,
      };
    }
    return {
      tickFormatter: (value: number) =>
        value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`,
    };
  }, [activeMetric]);

  return (
    <div className="flex flex-col gap-7 lg:gap-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground/80">Focus metric</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-foreground">
              {formatMetricValue(latestPoint?.[activeMetric])}
            </span>
            <Badge variant="outline" className="rounded-full bg-background/80 text-xs">
              Latest data point
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{metricDescriptions[activeMetric]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {(Object.keys(chartConfig) as MetricKey[]).map((metric) => {
            const isActive = metric === activeMetric;
            const color = chartConfig[metric].color;

            return (
              <Button
                key={metric}
                variant={isActive ? "default" : "outline"}
                size="sm"
                className={cn(
                  "rounded-full text-xs font-medium",
                  !isActive && "border-border/60 bg-background/60",
                )}
                style={isActive ? { backgroundColor: color, borderColor: color } : undefined}
                onClick={() => setActiveMetric(metric)}
              >
                {chartConfig[metric].label}
              </Button>
            );
          })}
        </div>
      </div>

      <ChartContainer
        config={chartConfig}
        className="h-[340px] w-full rounded-2xl border border-border/70 bg-background/70 p-5 sm:p-6"
      >
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id={`fill-${activeMetric}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={activeColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={activeColor} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} width={70} {...yAxisProps} />
          <ChartTooltip
            cursor={{ strokeDasharray: "4 4" }}
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(value) => {
                  const numeric = Number(value);
                  if (activeMetric === "successRate") {
                    return `${numeric.toFixed(1)}%`;
                  }
                  if (activeMetric === "cost") {
                    return new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format(numeric);
                  }
                  return numeric.toLocaleString();
                }}
                labelFormatter={(_, payload) => {
                  const source = payload?.[0];
                  if (source && typeof source === "object" && "payload" in source) {
                    interface TooltipPayload {
                      payload?: { fullLabel?: string };
                    }
                    const inner = (source as TooltipPayload).payload;
                    return inner?.fullLabel ?? "";
                  }
                  return "";
                }}
              />
            }
          />
          <Area
            type="monotone"
            dataKey={activeMetric}
            stroke={activeColor}
            fill={`url(#fill-${activeMetric})`}
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
