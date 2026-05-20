'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePnlHistory } from '@/hooks/usePnlHistory';
import type { PnlHistoryScope } from '@/lib/wallet/pnl-history-types';

interface PnLChartProps {
  entityId?: string | null;
  metricLabel?: string;
  scope: PnlHistoryScope;
  userId: string;
  timeframe: string;
}

function formatChartTime(time: number, timeframe: string): string {
  const date = new Date(time);

  if (timeframe === '1H' || timeframe === '4H' || timeframe === '1D') {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }

  if (timeframe === '1W') {
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:00`;
  }

  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function PnLChart({
  entityId,
  metricLabel = 'Current P&L',
  scope,
  userId,
  timeframe,
}: PnLChartProps) {
  const { points, loading } = usePnlHistory(userId, timeframe, {
    entityId,
    scope,
  });

  const chartData = useMemo(() => {
    if (points.length === 0) return [];
    return points.map((p) => ({
      time: formatChartTime(p.time, timeframe),
      value: p.value,
    }));
  }, [points, timeframe]);

  const yDomain = useMemo(() => {
    if (chartData.length === 0) return [0, 100] as const;
    const values = chartData.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max((max - min) * 0.1, 1);
    return [Math.floor(min - padding), Math.ceil(max + padding)] as const;
  }, [chartData]);

  // Estimate Y-axis width based on the longest label
  const yAxisWidth = useMemo(() => {
    if (chartData.length === 0) return 40;
    const maxLabel = `$${Math.round(yDomain[1]).toLocaleString()}`;
    return Math.max(maxLabel.length * 7, 38);
  }, [chartData, yDomain]);

  const isPnlPositive =
    chartData.length >= 2
      ? (chartData.at(-1)?.value ?? 0) >= (chartData[0]?.value ?? 0)
      : true;
  const chartColor = isPnlPositive ? '#10b981' : '#f87171';

  if (loading) {
    return (
      <div className="flex h-72 w-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="flex h-72 w-full items-center justify-center text-muted-foreground text-sm">
        No {metricLabel.toLowerCase()} history for this timeframe yet
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-xs tracking-wide">
        {metricLabel} history
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 10, right: 0, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={chartColor} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="time"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#9ca3af', fontSize: 12 }}
            />
            <YAxis
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#9ca3af', fontSize: 11 }}
              tickFormatter={(value) =>
                `$${Math.round(value).toLocaleString()}`
              }
              domain={[yDomain[0], yDomain[1]]}
              width={yAxisWidth}
            />
            <Tooltip
              content={({ active, payload }) => {
                const firstPoint = payload?.[0];
                if (active && firstPoint?.value != null) {
                  return (
                    <div className="rounded bg-[#1a365d] px-2 py-1 font-medium text-white text-xs">
                      ${Number(firstPoint.value).toFixed(2)}
                    </div>
                  );
                }
                return null;
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={chartColor}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorValue)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
