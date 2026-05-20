"use client";

import { cn, formatCompactCurrency } from "@feed/shared";
import {
  ArrowDown,
  ArrowUp,
  type LucideIcon,
  Minus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

export interface MetricCardData {
  id: string;
  label: string;
  value: string | number;
  previousValue?: string | number;
  change?: number;
  changeLabel?: string;
  icon?: LucideIcon;
  color?: "default" | "green" | "red" | "blue" | "orange" | "purple";
  format?: "number" | "currency" | "percentage" | "raw";
  description?: string;
}

interface MetricCardProps {
  data: MetricCardData;
  size?: "sm" | "md" | "lg";
  className?: string;
}

interface MetricCardsGridProps {
  metrics: MetricCardData[];
  columns?: 2 | 3 | 4 | 5;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Format a number value based on format type
 */
function formatValue(
  value: string | number,
  format: MetricCardData["format"] = "number",
): string {
  const num = typeof value === "string" ? parseFloat(value) : value;

  if (Number.isNaN(num)) return String(value);

  switch (format) {
    case "currency":
      return formatCompactCurrency(num);
    case "percentage":
      return `${num.toFixed(1)}%`;
    case "number":
      if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
      if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
      return num.toLocaleString();
    default:
      return String(value);
  }
}

/**
 * Get color classes based on color prop
 */
function getColorClasses(color: MetricCardData["color"] = "default"): {
  iconClass: string;
  valueClass: string;
  bgClass: string;
} {
  const colorMap = {
    default: {
      iconClass: "text-primary",
      valueClass: "text-foreground",
      bgClass: "bg-primary/10",
    },
    green: {
      iconClass: "text-green-500",
      valueClass: "text-green-500",
      bgClass: "bg-green-500/10",
    },
    red: {
      iconClass: "text-red-500",
      valueClass: "text-red-500",
      bgClass: "bg-red-500/10",
    },
    blue: {
      iconClass: "text-blue-500",
      valueClass: "text-blue-500",
      bgClass: "bg-blue-500/10",
    },
    orange: {
      iconClass: "text-orange-500",
      valueClass: "text-orange-500",
      bgClass: "bg-orange-500/10",
    },
    purple: {
      iconClass: "text-purple-500",
      valueClass: "text-purple-500",
      bgClass: "bg-purple-500/10",
    },
  };

  return colorMap[color];
}

/**
 * Individual metric card component
 */
export function MetricCard({ data, size = "md", className }: MetricCardProps) {
  const {
    label,
    value,
    change,
    changeLabel,
    icon: Icon,
    color = "default",
    format = "number",
    description,
  } = data;

  const colors = getColorClasses(color);
  const formattedValue = formatValue(value, format);

  const sizeClasses = {
    sm: {
      padding: "p-3",
      valueSize: "text-xl",
      labelSize: "text-xs",
      iconSize: "h-4 w-4",
      iconContainer: "h-8 w-8",
    },
    md: {
      padding: "p-4",
      valueSize: "text-2xl",
      labelSize: "text-sm",
      iconSize: "h-5 w-5",
      iconContainer: "h-10 w-10",
    },
    lg: {
      padding: "p-6",
      valueSize: "text-3xl",
      labelSize: "text-base",
      iconSize: "h-6 w-6",
      iconContainer: "h-12 w-12",
    },
  };

  const sizes = sizeClasses[size];

  // Determine change indicator
  const changeIndicator =
    change !== undefined ? (
      <span
        className={cn(
          "flex items-center gap-0.5 text-xs",
          change > 0
            ? "text-green-500"
            : change < 0
              ? "text-red-500"
              : "text-muted-foreground",
        )}
      >
        {change > 0 ? (
          <ArrowUp className="h-3 w-3" />
        ) : change < 0 ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <Minus className="h-3 w-3" />
        )}
        {Math.abs(change).toFixed(1)}%
        {changeLabel && (
          <span className="ml-1 text-muted-foreground">{changeLabel}</span>
        )}
      </span>
    ) : null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card transition-colors hover:border-border/80",
        sizes.padding,
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className={cn("text-muted-foreground", sizes.labelSize)}>
            {label}
          </p>
          <p className={cn("font-bold", sizes.valueSize, colors.valueClass)}>
            {formattedValue}
          </p>
          {changeIndicator}
          {description && (
            <p className="mt-1 text-muted-foreground text-xs">{description}</p>
          )}
        </div>
        {Icon && (
          <div
            className={cn(
              "flex items-center justify-center rounded-lg",
              colors.bgClass,
              sizes.iconContainer,
            )}
          >
            <Icon className={cn(colors.iconClass, sizes.iconSize)} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Grid of metric cards
 */
export function MetricCardsGrid({
  metrics,
  columns = 4,
  size = "md",
  className,
}: MetricCardsGridProps) {
  const gridClasses = {
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
    5: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  };

  return (
    <div className={cn("grid gap-4", gridClasses[columns], className)}>
      {metrics.map((metric) => (
        <MetricCard key={metric.id} data={metric} size={size} />
      ))}
    </div>
  );
}

/**
 * Metric card with sparkline trend
 */
export function MetricCardWithTrend({
  data,
  trendData,
  className,
}: {
  data: MetricCardData;
  trendData: number[];
  className?: string;
}) {
  const colors = getColorClasses(data.color);
  const formattedValue = formatValue(data.value, data.format);

  // Calculate trend direction
  const trendDirection =
    trendData.length > 1
      ? trendData[trendData.length - 1]! > trendData[0]!
        ? "up"
        : "down"
      : "flat";

  // Generate simple sparkline path
  const maxValue = Math.max(...trendData);
  const minValue = Math.min(...trendData);
  const range = maxValue - minValue || 1;
  const width = 80;
  const height = 24;
  const points = trendData
    .map((v, i) => {
      const x = (i / (trendData.length - 1)) * width;
      const y = height - ((v - minValue) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div
      className={cn("rounded-lg border border-border bg-card p-4", className)}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-muted-foreground text-sm">{data.label}</p>
          <p className={cn("font-bold text-2xl", colors.valueClass)}>
            {formattedValue}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* Mini trend indicator */}
          {trendDirection === "up" ? (
            <TrendingUp className="h-5 w-5 text-green-500" />
          ) : trendDirection === "down" ? (
            <TrendingDown className="h-5 w-5 text-red-500" />
          ) : (
            <Minus className="h-5 w-5 text-muted-foreground" />
          )}
          {/* Sparkline */}
          <svg width={width} height={height} className="overflow-visible">
            <polyline
              points={points}
              fill="none"
              stroke={
                trendDirection === "up"
                  ? "#22c55e"
                  : trendDirection === "down"
                    ? "#ef4444"
                    : "#888"
              }
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact stat item for inline use
 */
export function StatItem({
  icon: Icon,
  label,
  value,
  color = "default",
}: {
  icon?: LucideIcon;
  label: string;
  value: string | number;
  color?: MetricCardData["color"];
}) {
  const colors = getColorClasses(color);

  return (
    <div className="flex items-center gap-3">
      {Icon && (
        <Icon className={cn("h-4 w-4 flex-shrink-0", colors.iconClass)} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground text-sm">{label}</div>
        <div className={cn("font-bold text-xl", colors.valueClass)}>
          {value}
        </div>
      </div>
    </div>
  );
}
