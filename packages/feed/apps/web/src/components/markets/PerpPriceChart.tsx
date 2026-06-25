"use client";

import { cn } from "@feed/shared";
import type { ISeriesApi, Time } from "lightweight-charts";
import { AreaSeries, CrosshairMode } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AREA_STYLES,
  formatChartPrice,
  formatChartTime,
  useLightweightChart,
} from "@/components/charts/LightweightChartBase";
import { MARKET_TIME_RANGES, type MarketTimeRange } from "@/types/markets";

/**
 * Price point structure for chart data.
 */
interface PricePoint {
  /** Timestamp in milliseconds */
  time: number;
  /** Price value */
  price: number;
}

/**
 * Chart data point for Lightweight Charts series.
 */
interface ChartDataPoint {
  time: Time;
  value: number;
}

/**
 * Props for PerpPriceChart component.
 */
interface PerpPriceChartProps {
  /** Array of price history points */
  data: PricePoint[];
  /** Current live price */
  currentPrice: number;
  /** Market ticker symbol */
  ticker: string;
  /** Selected time range */
  timeRange: MarketTimeRange;
  /** Time range selection handler */
  onTimeRangeChange: (range: MarketTimeRange) => void;
  /** Whether to show brush selector (unused, for future) */
  showBrush?: boolean;
  /** Whether to show the header (price + range controls). Defaults to true. */
  showHeader?: boolean;
  /**
   * Chart sizing behavior.
   * - fixed: uses a fixed-height chart (good for pages)
   * - fill: stretches to the available parent height (good for flex layouts like the terminal)
   */
  height?: "fixed" | "fill";
  /** Optional className for the container */
  className?: string;
}

/**
 * Perpetual price chart using TradingView Lightweight Charts.
 *
 * Displays price history with area chart, time range filtering,
 * and price change indicators. Color-coded based on price direction.
 *
 * Features:
 * - Area chart with gradient fill
 * - Time range filtering (1H, 4H, 1D, 1W, ALL)
 * - Price change display with percentage
 * - Color-coded by direction (green up, red down)
 * - Interactive crosshair with tooltips
 * - Auto-resize to container
 * - Current price reference line
 *
 * @param props - PerpPriceChart component props
 * @returns Perpetual price chart element
 */
export function PerpPriceChart({
  data,
  currentPrice,
  ticker: _ticker,
  timeRange,
  onTimeRangeChange,
  showHeader = true,
  height = "fixed",
  className,
}: PerpPriceChartProps) {
  const [chartInitError, setChartInitError] = useState<string | null>(null);
  const priceSeries = useRef<ISeriesApi<"Area"> | null>(null);
  const lastPriceLineRef = useRef<ReturnType<
    ISeriesApi<"Area">["createPriceLine"]
  > | null>(null);
  const seriesInitialized = useRef(false);

  const {
    chartContainerRef,
    chart,
    error: chartBaseError,
  } = useLightweightChart({
    crosshair: {
      mode: CrosshairMode.Normal,
    },
    localization: {
      priceFormatter: (price: number) => formatChartPrice(price, true),
    },
  });

  const fillHeight = height === "fill";
  const hasData = data.length > 0;
  const unavailableReason = chartInitError ?? chartBaseError;

  // Filter and prepare data based on time range
  const chartData = useMemo(() => {
    if (!data.length) return [];

    // Filter valid data points and sort by time
    const validData = data
      .filter(
        (point) =>
          Number.isFinite(point.time) &&
          Number.isFinite(point.price) &&
          point.price > 0,
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
    // Lightweight Charts requires unique, ascending timestamps
    const seenTimes = new Set<number>();
    const result: ChartDataPoint[] = [];

    for (const point of filtered) {
      const time = formatChartTime(point.time);
      const timeNum = time as number;
      if (seenTimes.has(timeNum)) continue;
      seenTimes.add(timeNum);
      result.push({ time, value: point.price });
    }

    return result;
  }, [data, timeRange]);

  // Calculate price change from first to last point in filtered range
  const { priceChange, priceChangePercent, isPositive } = useMemo(() => {
    if (chartData.length < 2) {
      return { priceChange: 0, priceChangePercent: 0, isPositive: true };
    }

    const first = chartData[0];
    const last = chartData[chartData.length - 1];
    const change = (last?.value ?? 0) - (first?.value ?? 0);
    const percent = first?.value ? (change / first.value) * 100 : 0;

    return {
      priceChange: change,
      priceChangePercent: percent,
      isPositive: change >= 0,
    };
  }, [chartData]);

  // Initialize series when chart is ready
  useEffect(() => {
    if (!chart || seriesInitialized.current) return;

    try {
      setChartInitError(null);

      const seriesOptions = {
        ...AREA_STYLES.green,
        priceFormat: {
          type: "custom" as const,
          formatter: (price: number) => formatChartPrice(price, true),
          minMove: 0.00000001,
        },
        lastValueVisible: true,
        priceLineVisible: false,
      };

      // lightweight-charts v5: chart.addSeries(AreaSeries, options)
      // lightweight-charts v4: chart.addAreaSeries(options)
      // IMPORTANT: do not call extracted methods directly; lightweight-charts relies on `this`.
      const chartAny = chart as {
        addSeries?: (
          seriesType: unknown,
          options: unknown,
        ) => ISeriesApi<"Area">;
        addAreaSeries?: (options: unknown) => ISeriesApi<"Area">;
      };

      if (typeof chartAny.addSeries === "function" && AreaSeries) {
        priceSeries.current = chartAny.addSeries.call(
          chart,
          AreaSeries,
          seriesOptions,
        );
      } else if (typeof chartAny.addAreaSeries === "function") {
        priceSeries.current = chartAny.addAreaSeries.call(chart, seriesOptions);
      } else {
        throw new Error("Unsupported lightweight-charts API");
      }

      seriesInitialized.current = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to initialize chart";
      setChartInitError(message);
      priceSeries.current = null;
      seriesInitialized.current = false;
      return;
    }

    return () => {
      lastPriceLineRef.current = null;
      priceSeries.current = null;
      seriesInitialized.current = false;
    };
  }, [chart]);

  // Update series color based on price direction
  useEffect(() => {
    if (!priceSeries.current) return;
    const style = isPositive ? AREA_STYLES.green : AREA_STYLES.red;
    priceSeries.current.applyOptions(style);
  }, [isPositive]);

  // Update data when chart data changes
  useEffect(() => {
    if (!priceSeries.current || !chart) return;

    if (!chartData.length) {
      // Clear data when no points in range
      try {
        priceSeries.current.setData([]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to clear chart data";
        setChartInitError(message);
      }
      return;
    }

    try {
      setChartInitError(null);
      priceSeries.current.setData(chartData);
      chart.timeScale().fitContent();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to render chart data";
      setChartInitError(message);
    }
  }, [chart, chartData]);

  // Update current price reference line
  useEffect(() => {
    if (!priceSeries.current || !currentPrice) return;

    try {
      // Remove existing price line before creating new one
      if (lastPriceLineRef.current) {
        priceSeries.current.removePriceLine(lastPriceLineRef.current);
      }

      // Add horizontal line at current price
      lastPriceLineRef.current = priceSeries.current.createPriceLine({
        price: currentPrice,
        color: "#0066FF",
        lineWidth: 2,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: "Current",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update current price line";
      setChartInitError(message);
    }
  }, [currentPrice]);

  return (
    <div
      className={cn(
        "flex w-full",
        fillHeight ? "h-full min-h-0 flex-col gap-3" : "h-full flex-col",
        showHeader && !fillHeight ? "space-y-3" : "",
        className,
      )}
    >
      {/* Header with price info and time range selector */}
      {showHeader && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-3">
            <div>
              <div className="font-bold text-2xl">
                {formatChartPrice(currentPrice, true)}
              </div>
              <div
                className={cn(
                  "font-medium text-sm",
                  isPositive ? "text-green-600" : "text-red-600",
                )}
              >
                {isPositive ? "↑" : "↓"}{" "}
                {formatChartPrice(Math.abs(priceChange), true)} (
                {priceChangePercent >= 0 ? "+" : ""}
                {priceChangePercent.toFixed(2)}%)
              </div>
            </div>
          </div>

          {/* Time range selector */}
          <div className="flex items-center gap-1 rounded-md bg-muted/30 p-1">
            {MARKET_TIME_RANGES.map((range) => (
              <button
                key={range}
                onClick={() => onTimeRangeChange(range)}
                className={cn(
                  "cursor-pointer rounded px-2 py-1 text-xs transition-colors",
                  timeRange === range
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
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
            fillHeight ? "h-full min-h-[240px]" : "h-[400px]",
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
    </div>
  );
}
