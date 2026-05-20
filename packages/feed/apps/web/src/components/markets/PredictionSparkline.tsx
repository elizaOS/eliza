"use client";

import type { ISeriesApi, Time } from "lightweight-charts";
import { ColorType, createChart, LineSeries } from "lightweight-charts";
import { memo, useEffect, useMemo, useRef } from "react";

/**
 * Chart data point for sparkline series.
 */
interface SparklineDataPoint {
  time: Time;
  value: number;
}

/**
 * Prediction sparkline component for displaying mini price trend charts.
 *
 * Displays a small line chart showing the last 20 data points of YES/NO probability
 * trends. Used as a compact visualization in lists and cards. Shows both YES
 * (green) and NO (red) probability lines.
 *
 * Features:
 * - Compact line chart (default 120x32px)
 * - Last 20 data points only
 * - Dual lines (YES and NO)
 * - Color-coded (green YES, red NO)
 * - Empty state handling
 * - Uses TradingView Lightweight Charts
 *
 * @param props - PredictionSparkline component props
 * @returns Prediction sparkline element or empty state
 *
 * @example
 * ```tsx
 * <PredictionSparkline
 *   data={priceHistory}
 *   width={120}
 *   height={32}
 * />
 * ```
 */
interface PredictionSparklineProps {
  data: Array<{ time: number; yesPrice: number; noPrice: number }>;
  width?: number;
  height?: number;
}

function PredictionSparklineBase({
  data,
  width = 120,
  height = 32,
}: PredictionSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const yesSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const noSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return { yes: [], no: [] };

    const sliced = data.slice(-20);
    const yes: SparklineDataPoint[] = [];
    const no: SparklineDataPoint[] = [];

    for (const point of sliced) {
      // Skip points with invalid data to prevent "Value is null" errors
      if (
        !Number.isFinite(point.time) ||
        point.yesPrice === null ||
        point.yesPrice === undefined
      ) {
        continue;
      }

      const time = Math.floor(point.time / 1000) as Time;
      const yesVal = point.yesPrice * 100;
      const noVal =
        point.noPrice !== undefined && point.noPrice !== null
          ? point.noPrice * 100
          : 100 - yesVal;

      // Final validation before adding
      if (Number.isFinite(yesVal) && Number.isFinite(noVal)) {
        yes.push({ time, value: yesVal });
        no.push({ time, value: noVal });
      }
    }

    return { yes, no };
  }, [data]);

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "transparent",
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
    });

    chartRef.current = chart;

    // YES series (green)
    yesSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // NO series (red)
    noSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      yesSeriesRef.current = null;
      noSeriesRef.current = null;
    };
  }, [width, height]);

  // Update data
  useEffect(() => {
    if (!yesSeriesRef.current || !noSeriesRef.current) return;
    if (chartData.yes.length === 0) return;

    yesSeriesRef.current.setData(chartData.yes);
    noSeriesRef.current.setData(chartData.no);

    chartRef.current?.timeScale().fitContent();
  }, [chartData]);

  if (!data || data.length === 0) {
    return <div className="text-muted-foreground text-xs">–</div>;
  }

  return (
    <div
      ref={containerRef}
      style={{ width, height }}
      className="overflow-hidden"
    />
  );
}

export const PredictionSparkline = memo(PredictionSparklineBase);
