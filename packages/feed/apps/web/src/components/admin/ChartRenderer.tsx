"use client";

import { cn } from "@feed/shared";
import { Download, Maximize2 } from "lucide-react";
import { useCallback, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartType = "line" | "bar" | "area" | "pie";

export interface ChartConfig {
  type: ChartType;
  title: string;
  description?: string;
  dataKey: string;
  xAxisKey?: string;
  yAxisLabel?: string;
  xAxisLabel?: string;
  colors?: string[];
  showGrid?: boolean;
  showLegend?: boolean;
  stacked?: boolean;
  multipleLines?: string[];
  formatValue?: (value: number) => string;
  formatXAxis?: (value: string) => string;
}

interface ChartRendererProps {
  data: Array<Record<string, string | number>>;
  config: ChartConfig;
  height?: number;
  className?: string;
  onExport?: () => void;
}

const DEFAULT_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // orange
  "#ef4444", // red
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

/**
 * Custom tooltip component
 */
function CustomTooltip({
  active,
  payload,
  label,
  formatValue,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  formatValue?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-lg">
      <p className="mb-2 font-medium text-foreground text-sm">{label}</p>
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2 text-sm">
          <span
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-medium">
            {formatValue
              ? formatValue(entry.value)
              : entry.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Line chart component
 */
function LineChartComponent({
  data,
  config,
  height,
}: {
  data: Array<Record<string, string | number>>;
  config: ChartConfig;
  height: number;
}) {
  const lines = config.multipleLines || [config.dataKey];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        {config.showGrid && (
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        )}
        <XAxis
          dataKey={config.xAxisKey || "date"}
          stroke="#888"
          fontSize={12}
          tickFormatter={config.formatXAxis}
        />
        <YAxis
          stroke="#888"
          fontSize={12}
          tickFormatter={config.formatValue}
          label={
            config.yAxisLabel
              ? {
                  value: config.yAxisLabel,
                  angle: -90,
                  position: "insideLeft",
                  style: { textAnchor: "middle", fill: "#888" },
                }
              : undefined
          }
        />
        <Tooltip content={<CustomTooltip formatValue={config.formatValue} />} />
        {config.showLegend && <Legend />}
        {lines.map((line, index) => (
          <Line
            key={line}
            type="monotone"
            dataKey={line}
            stroke={
              config.colors?.[index] ||
              DEFAULT_COLORS[index % DEFAULT_COLORS.length]
            }
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * Bar chart component
 */
function BarChartComponent({
  data,
  config,
  height,
}: {
  data: Array<Record<string, string | number>>;
  config: ChartConfig;
  height: number;
}) {
  const bars = config.multipleLines || [config.dataKey];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        {config.showGrid && (
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        )}
        <XAxis
          dataKey={config.xAxisKey || "name"}
          stroke="#888"
          fontSize={12}
          tickFormatter={config.formatXAxis}
        />
        <YAxis stroke="#888" fontSize={12} tickFormatter={config.formatValue} />
        <Tooltip content={<CustomTooltip formatValue={config.formatValue} />} />
        {config.showLegend && <Legend />}
        {bars.map((bar, index) => (
          <Bar
            key={bar}
            dataKey={bar}
            fill={
              config.colors?.[index] ||
              DEFAULT_COLORS[index % DEFAULT_COLORS.length]
            }
            stackId={config.stacked ? "stack" : undefined}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Area chart component
 */
function AreaChartComponent({
  data,
  config,
  height,
}: {
  data: Array<Record<string, string | number>>;
  config: ChartConfig;
  height: number;
}) {
  const areas = config.multipleLines || [config.dataKey];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data}>
        {config.showGrid && (
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        )}
        <XAxis
          dataKey={config.xAxisKey || "date"}
          stroke="#888"
          fontSize={12}
          tickFormatter={config.formatXAxis}
        />
        <YAxis stroke="#888" fontSize={12} tickFormatter={config.formatValue} />
        <Tooltip content={<CustomTooltip formatValue={config.formatValue} />} />
        {config.showLegend && <Legend />}
        {areas.map((area, index) => (
          <Area
            key={area}
            type="monotone"
            dataKey={area}
            stroke={
              config.colors?.[index] ||
              DEFAULT_COLORS[index % DEFAULT_COLORS.length]
            }
            fill={
              config.colors?.[index] ||
              DEFAULT_COLORS[index % DEFAULT_COLORS.length]
            }
            fillOpacity={0.2}
            stackId={config.stacked ? "stack" : undefined}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Pie chart component
 */
function PieChartComponent({
  data,
  config,
  height,
}: {
  data: Array<Record<string, string | number>>;
  config: ChartConfig;
  height: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey={config.dataKey}
          nameKey={config.xAxisKey || "name"}
          cx="50%"
          cy="50%"
          outerRadius={height / 3}
          label={({ name, percent }) =>
            `${String(name || "")} ${((percent ?? 0) * 100).toFixed(0)}%`
          }
          labelLine={false}
        >
          {data.map((_, index) => (
            <Cell
              key={`cell-${index}`}
              fill={
                config.colors?.[index] ||
                DEFAULT_COLORS[index % DEFAULT_COLORS.length]
              }
            />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip formatValue={config.formatValue} />} />
        {config.showLegend && <Legend />}
      </PieChart>
    </ResponsiveContainer>
  );
}

/**
 * Main ChartRenderer component
 */
export function ChartRenderer({
  data,
  config,
  height = 300,
  className,
  onExport,
}: ChartRendererProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleExport = useCallback(() => {
    if (onExport) {
      onExport();
      return;
    }

    // Default CSV export
    const headers = Object.keys(data[0] || {});
    const csvContent = [
      headers.join(","),
      ...data.map((row) =>
        headers.map((h) => JSON.stringify(row[h] ?? "")).join(","),
      ),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.title.toLowerCase().replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, config.title, onExport]);

  const chartHeight = isFullscreen ? window.innerHeight - 200 : height;

  const renderChart = () => {
    switch (config.type) {
      case "line":
        return (
          <LineChartComponent
            data={data}
            config={config}
            height={chartHeight}
          />
        );
      case "bar":
        return (
          <BarChartComponent data={data} config={config} height={chartHeight} />
        );
      case "area":
        return (
          <AreaChartComponent
            data={data}
            config={config}
            height={chartHeight}
          />
        );
      case "pie":
        return (
          <PieChartComponent data={data} config={config} height={chartHeight} />
        );
      default:
        return (
          <LineChartComponent
            data={data}
            config={config}
            height={chartHeight}
          />
        );
    }
  };

  const chartWrapper = (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4",
        isFullscreen && "fixed inset-4 z-50 overflow-auto",
        className,
      )}
    >
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-lg">{config.title}</h3>
          {config.description && (
            <p className="text-muted-foreground text-sm">
              {config.description}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground text-sm hover:bg-muted/80"
            title="Export data"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground text-sm hover:bg-muted/80"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Chart */}
      {data.length === 0 ? (
        <div
          className="flex items-center justify-center text-muted-foreground"
          style={{ height: chartHeight }}
        >
          No data available
        </div>
      ) : (
        renderChart()
      )}
    </div>
  );

  // Fullscreen backdrop
  if (isFullscreen) {
    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setIsFullscreen(false)}
        />
        {chartWrapper}
      </>
    );
  }

  return chartWrapper;
}

/**
 * Simple data table component for tabular data
 */
export function DataTable({
  data,
  columns,
  title,
  className,
}: {
  data: Array<Record<string, string | number | boolean | null>>;
  columns: Array<{
    key: string;
    label: string;
    format?: (value: string | number | boolean | null) => string;
    align?: "left" | "center" | "right";
  }>;
  title?: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      {title && (
        <div className="border-border border-b p-4">
          <h3 className="font-semibold text-lg">{title}</h3>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-border border-b bg-muted/50">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-3 font-medium text-muted-foreground text-sm",
                    col.align === "right" && "text-right",
                    col.align === "center" && "text-center",
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, index) => (
              <tr
                key={index}
                className="border-border border-b last:border-b-0 hover:bg-muted/30"
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "px-4 py-3 text-sm",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                    )}
                  >
                    {col.format
                      ? col.format(
                          row[col.key] as string | number | boolean | null,
                        )
                      : String(row[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No data available
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
