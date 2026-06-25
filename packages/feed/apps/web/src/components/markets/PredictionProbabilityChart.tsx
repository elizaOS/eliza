"use client";

import { cn } from "@feed/shared";
import type { ISeriesApi, Time } from "lightweight-charts";
import { AreaSeries } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatChartTime,
  useLightweightChart,
} from "@/components/charts/LightweightChartBase";
import { MARKET_TIME_RANGES, type MarketTimeRange } from "@/types/markets";

/**
 * Price point structure for prediction chart data.
 */
interface PricePoint {
  /** Timestamp in milliseconds */
  time: number;
  /** YES outcome price (0-1) */
  yesPrice: number;
  /** NO outcome price (0-1) */
  noPrice: number;
  /** Trading volume */
  volume: number;
}

/**
 * Chart data point for Lightweight Charts series.
 */
interface ChartDataPoint {
  time: Time;
  value: number;
}

/**
 * Props for PredictionProbabilityChart component.
 */
interface PredictionProbabilityChartProps {
  /** Array of price history points */
  data: PricePoint[];
  /** Market identifier for keying */
  marketId: string;
  /** Selected time range */
  timeRange: MarketTimeRange;
  /** Time range selection handler */
  onTimeRangeChange: (range: MarketTimeRange) => void;
  /** Whether to show brush selector (unused, for future) */
  showBrush?: boolean;
  /** Whether to show the built-in header (probabilities + range controls). Defaults to true. */
  showHeader?: boolean;
  /**
   * Chart sizing behavior.
   * - fixed: uses a fixed-height chart (good for pages)
   * - fill: stretches to the available parent height (good for flex layouts like the terminal)
   */
  height?: "fixed" | "fill";
  /** When false, hides the YES/NO legend below the chart. Defaults to true. */
  showLegend?: boolean;
  /**
   * When `height` is `fill`, overrides the default chart area classes (`h-full min-h-[240px]`).
   * Use e.g. `h-full min-h-0` when the parent has a fixed small height (feed cards).
   */
  fillChartClassName?: string;
  /** When false, hides the right price scale (0%/100% labels). Defaults to true. */
  showPriceScale?: boolean;
  /** Visual palette for the chart. Defaults to the classic YES/NO colors. */
  palette?: "classic" | "neutral";
}

/**
 * Prediction probability chart using TradingView Lightweight Charts.
 *
 * Displays YES/NO probability history with area chart for YES and
 * line chart for NO. Includes time range filtering and current
 * probability display.
 *
 * Features:
 * - Single probability line (0–100%) with green fill below (YES) and red fill above (NO)
 * - Time range filtering (1H, 4H, 1D, 1W, ALL)
 * - Current probability percentages display
 * - Interactive crosshair with tooltips
 * - Auto-resize to container
 *
 * @param props - PredictionProbabilityChart component props
 * @returns Prediction probability chart element
 */
export function PredictionProbabilityChart({
  data,
  marketId,
  timeRange,
  onTimeRangeChange,
  showHeader = true,
  height = "fixed",
  showLegend = true,
  fillChartClassName,
  showPriceScale = true,
  palette = "classic",
}: PredictionProbabilityChartProps) {
  const [chartInitError, setChartInitError] = useState<string | null>(null);
  const yesSeries = useRef<ISeriesApi<"Area"> | null>(null);
  const noSeries = useRef<ISeriesApi<"Area"> | null>(null);
  const seriesInitialized = useRef(false);
  const fillHeight = height === "fill";

  const {
    chartContainerRef,
    chart,
    error: chartBaseError,
  } = useLightweightChart({
    rightPriceScale: {
      scaleMargins: { top: 0.02, bottom: 0.02 },
      autoScale: true,
      visible: showPriceScale,
    },
    localization: {
      priceFormatter: (price: number) => `${price.toFixed(0)}%`,
    },
  });

  // Filter and prepare data based on time range — single series (YES probability 0–100%)
  const chartData = useMemo(() => {
    if (!data.length) return [];

    // Filter valid data points and sort by time
    const validData = data
      .filter(
        (point) =>
          Number.isFinite(point.time) &&
          Number.isFinite(point.yesPrice) &&
          point.yesPrice >= 0,
      )
      .sort((a, b) => a.time - b.time);

    // Apply time range filter
    let filtered = validData;
    if (timeRange !== "ALL") {
      const now = Date.now();
      const ranges: Record<MarketTimeRange, number> = {
        "1H": 60 * 60 * 1000,
        "4H": 4 * 60 * 60 * 1000,
        "1D": 24 * 60 * 60 * 1000,
        "1W": 7 * 24 * 60 * 60 * 1000,
        ALL: 0,
      };
      const cutoff = now - ranges[timeRange];
      filtered = validData.filter((d) => d.time >= cutoff);
    }

    // Convert to chart format with deduplication by timestamp
    const seenTimes = new Set<number>();
    const points: ChartDataPoint[] = [];

    for (const point of filtered) {
      const time = formatChartTime(point.time);
      const timeNum = time as number;
      if (seenTimes.has(timeNum)) continue;
      seenTimes.add(timeNum);

      points.push({ time, value: point.yesPrice * 100 });
    }

    return points;
  }, [data, timeRange]);

  // Current probability from latest data point (always use ALL data, not filtered)
  const currentProbability = useMemo(() => {
    if (!data.length) return 50;
    // Get the most recent point from the original data
    const sorted = [...data]
      .filter((p) => Number.isFinite(p.yesPrice) && p.yesPrice >= 0)
      .sort((a, b) => b.time - a.time);
    const latest = sorted[0];
    return latest ? latest.yesPrice * 100 : 50;
  }, [data]);

  const hasData = data.length > 0;
  const yesDisplay = currentProbability.toFixed(1);
  const noDisplay = (100 - currentProbability).toFixed(1);
  const unavailableReason = chartInitError ?? chartBaseError;
  const chartPalette = useMemo(
    () =>
      palette === "neutral"
        ? {
            yesLine: "#2563eb",
            yesTop: "rgba(37, 99, 235, 0.24)",
            yesBottom: "rgba(37, 99, 235, 0.04)",
            noTop: "rgba(15, 23, 42, 0.03)",
            noBottom: "rgba(15, 23, 42, 0.14)",
            yesMarker: "#2563eb",
            yesDotClassName: "bg-blue-600",
            noDotClassName: "bg-foreground/60",
            yesLegendColor: "rgba(37, 99, 235, 0.24)",
            noLegendColor: "rgba(15, 23, 42, 0.14)",
          }
        : {
            yesLine: "#22c55e",
            yesTop: "rgba(34, 197, 94, 0.35)",
            yesBottom: "rgba(34, 197, 94, 0.05)",
            noTop: "rgba(239, 68, 68, 0.05)",
            noBottom: "rgba(239, 68, 68, 0.25)",
            yesMarker: "#22c55e",
            yesDotClassName: "bg-green-500",
            noDotClassName: "bg-red-500",
            yesLegendColor: "rgba(34, 197, 94, 0.35)",
            noLegendColor: "rgba(239, 68, 68, 0.25)",
          },
    [palette],
  );

  // Initialize series when chart is ready
  useEffect(() => {
    if (!chart || seriesInitialized.current) return;

    try {
      setChartInitError(null);

      const priceFormat = {
        type: "custom" as const,
        formatter: (price: number) => `${price.toFixed(1)}%`,
        minMove: 0.01,
      };

      const yesOptions = {
        lineColor: chartPalette.yesLine,
        topColor: chartPalette.yesTop,
        bottomColor: chartPalette.yesBottom,
        lineWidth: 2 as const,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        crosshairMarkerBackgroundColor: chartPalette.yesMarker,
        crosshairMarkerBorderColor: "#ffffff",
        crosshairMarkerBorderWidth: 2,
        priceFormat,
        // Fix scale to always show 0–100%
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: 0, maxValue: 100 },
        }),
      };

      const noOptions = {
        lineColor: "transparent",
        topColor: chartPalette.noTop,
        bottomColor: chartPalette.noBottom,
        invertFilledArea: true,
        lineWidth: 0 as const,
        crosshairMarkerVisible: false,
        priceFormat,
        lastValueVisible: false,
        priceLineVisible: false,
      };

      // IMPORTANT: do not call extracted methods directly; lightweight-charts relies on `this`.
      const chartAny = chart as {
        addSeries?: (
          seriesType: unknown,
          options: unknown,
        ) => ISeriesApi<"Area">;
        addAreaSeries?: (options: unknown) => ISeriesApi<"Area">;
      };

      if (typeof chartAny.addSeries === "function" && AreaSeries) {
        yesSeries.current = chartAny.addSeries.call(
          chart,
          AreaSeries,
          yesOptions,
        ) as ISeriesApi<"Area">;
        noSeries.current = chartAny.addSeries.call(
          chart,
          AreaSeries,
          noOptions,
        ) as ISeriesApi<"Area">;
      } else if (typeof chartAny.addAreaSeries === "function") {
        yesSeries.current = chartAny.addAreaSeries.call(chart, yesOptions);
        noSeries.current = chartAny.addAreaSeries.call(chart, noOptions);
      } else {
        throw new Error("Unsupported lightweight-charts API");
      }

      seriesInitialized.current = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to initialize chart";
      setChartInitError(message);
      yesSeries.current = null;
      noSeries.current = null;
      seriesInitialized.current = false;
      return;
    }

    return () => {
      yesSeries.current = null;
      noSeries.current = null;
      seriesInitialized.current = false;
    };
  }, [chart, chartPalette]);

  // Update data when chart data changes
  useEffect(() => {
    if (!yesSeries.current || !noSeries.current || !chart) return;

    if (!chartData.length) {
      // Clear data when no points in range
      try {
        yesSeries.current.setData([]);
        noSeries.current.setData([]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to clear chart data";
        setChartInitError(message);
      }
      return;
    }

    try {
      setChartInitError(null);
      // Both series use the same data — YES fills below, NO fills above
      yesSeries.current.setData(chartData);
      noSeries.current.setData(chartData);
      chart.timeScale().fitContent();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to render chart data";
      setChartInitError(message);
    }
  }, [chart, chartData]);

  return (
    <div
      data-market-id={marketId}
      className={cn(
        "w-full",
        ((showHeader && !fillHeight) || (!showHeader && fillHeight)) &&
          "space-y-3",
        fillHeight && "flex h-full min-h-0 flex-col gap-3",
      )}
    >
      {showHeader && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "h-3 w-3 rounded-full",
                  chartPalette.yesDotClassName,
                )}
              />
              <span className="font-semibold text-sm">YES {yesDisplay}%</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "h-3 w-3 rounded-full",
                  chartPalette.noDotClassName,
                )}
              />
              <span className="font-semibold text-sm">NO {noDisplay}%</span>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-md bg-muted/30 p-1">
            {MARKET_TIME_RANGES.map((range) => (
              <button
                key={range}
                onClick={() => onTimeRangeChange(range)}
                className={`cursor-pointer rounded px-2 py-1 text-xs transition-colors ${
                  timeRange === range
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chart container */}
      <div className={cn("relative", fillHeight && "min-h-0 flex-1")}>
        <div
          ref={chartContainerRef}
          className={cn(
            "w-full rounded-lg bg-muted/10",
            fillHeight
              ? (fillChartClassName ?? "h-full min-h-[240px]")
              : "h-[400px]",
          )}
        />
        {/* Overlay states are mutually exclusive - priority: unavailable > loading > initializing > empty */}
        {unavailableReason ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg bg-card/90 px-4 py-2 text-center text-muted-foreground text-sm">
              <div className="font-semibold">Chart unavailable</div>
              <div className="mt-1 text-xs">{unavailableReason}</div>
            </div>
          </div>
        ) : !hasData ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg bg-card/90 px-4 py-2 text-muted-foreground text-sm">
              Loading chart data…
            </div>
          </div>
        ) : !chart ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg bg-card/90 px-4 py-2 text-muted-foreground text-sm">
              Initializing chart…
            </div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg bg-card/90 px-4 py-2 text-muted-foreground text-sm">
              No data in selected time range
            </div>
          </div>
        ) : null}
      </div>

      {/* Legend */}
      {showLegend && (
        <div className="flex shrink-0 items-center justify-center gap-6 px-1 text-muted-foreground text-xs">
          <div className="flex items-center gap-2">
            <div
              className="h-2.5 w-4 rounded"
              style={{ backgroundColor: chartPalette.yesLegendColor }}
            />
            <span>YES {yesDisplay}%</span>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="h-2.5 w-4 rounded"
              style={{ backgroundColor: chartPalette.noLegendColor }}
            />
            <span>NO {noDisplay}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
