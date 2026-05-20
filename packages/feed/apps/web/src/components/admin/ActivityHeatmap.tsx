/**
 * Activity Heatmap Component
 *
 * Displays activity patterns as heatmaps:
 * - Hourly: 7x24 grid showing activity by day of week and hour
 * - Calendar: GitHub-style contribution heatmap
 *
 * @module ActivityHeatmap
 */
'use client';

import { cn, formatNumber } from '@feed/shared';
import { Calendar, Clock, RefreshCw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

type HeatmapType = 'hourly' | 'calendar';
type ActivityType = 'all' | 'trades' | 'posts' | 'messages';

interface HourlyDataPoint {
  dayOfWeek: number;
  hour: number;
  count: number;
  intensity: number;
}

interface CalendarDataPoint {
  date: string;
  count: number;
  intensity: number;
}

interface HeatmapData {
  type: HeatmapType;
  activityType: ActivityType;
  data: HourlyDataPoint[] | CalendarDataPoint[];
  metadata: {
    startDate: string;
    endDate: string;
    maxCount: number;
    totalActivities: number;
    daysWithActivity?: number;
  };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = [
  '12a',
  '',
  '',
  '3a',
  '',
  '',
  '6a',
  '',
  '',
  '9a',
  '',
  '',
  '12p',
  '',
  '',
  '3p',
  '',
  '',
  '6p',
  '',
  '',
  '9p',
  '',
  '',
];

const ACTIVITY_OPTIONS: { value: ActivityType; label: string }[] = [
  { value: 'all', label: 'All Activity' },
  { value: 'trades', label: 'Trades' },
  { value: 'posts', label: 'Posts' },
  { value: 'messages', label: 'Messages' },
];

const INTENSITY_COLORS = [
  'bg-muted/30', // 0
  'bg-green-900/50', // 0-25%
  'bg-green-700/70', // 25-50%
  'bg-green-500/80', // 50-75%
  'bg-green-400', // 75-100%
] as const;

function getIntensityColor(intensity: number): string {
  if (intensity === 0) return INTENSITY_COLORS[0];
  if (intensity < 0.25) return INTENSITY_COLORS[1];
  if (intensity < 0.5) return INTENSITY_COLORS[2];
  if (intensity < 0.75) return INTENSITY_COLORS[3];
  return INTENSITY_COLORS[4];
}

function IntensityLegend() {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Less</span>
      <div className="flex gap-0.5">
        {INTENSITY_COLORS.map((color, i) => (
          <div key={i} className={cn('h-3 w-3 rounded-sm', color)} />
        ))}
      </div>
      <span className="text-muted-foreground text-xs">More</span>
    </div>
  );
}

export function ActivityHeatmap() {
  const [data, setData] = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [heatmapType, setHeatmapType] = useState<HeatmapType>('hourly');
  const [activityType, setActivityType] = useState<ActivityType>('all');
  const [isRefreshing, startRefresh] = useTransition();

  const fetchData = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        setError(null);
        const response = await fetch(
          apiUrl(
            `/api/admin/stats/heatmap?type=${heatmapType}&activityType=${activityType}`
          )
        );
        if (!response.ok) {
          setData(null);
          setError('Failed to load heatmap data');
          setLoading(false);
          return;
        }
        const result = await response.json();
        setData(result);
        setLoading(false);
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic().catch(() => {
          setData(null);
          setError('Failed to load heatmap data');
          setLoading(false);
        });
      }
    },
    [heatmapType, activityType]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <Skeleton className="mb-4 h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="py-12 text-center text-muted-foreground">
          <Clock className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>{error ?? 'Failed to load heatmap data'}</p>
          <button
            onClick={() => {
              setLoading(true);
              setError(null);
              fetchData();
            }}
            className="mt-4 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const isHourly = data.type === 'hourly';
  const hourlyData = isHourly ? (data.data as HourlyDataPoint[]) : [];
  const calendarData = !isHourly ? (data.data as CalendarDataPoint[]) : [];

  const hourlyPointMap = useMemo(() => {
    if (!isHourly) return new Map<string, HourlyDataPoint>();
    return new Map(hourlyData.map((p) => [`${p.dayOfWeek}-${p.hour}`, p]));
  }, [hourlyData, isHourly]);

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h3 className="flex items-center gap-2 font-semibold text-lg">
          {isHourly ? (
            <Clock className="h-5 w-5 text-green-500" />
          ) : (
            <Calendar className="h-5 w-5 text-green-500" />
          )}
          Activity Heatmap
        </h3>

        <div className="flex flex-wrap items-center gap-2">
          {/* Heatmap Type Toggle */}
          <div className="flex rounded-lg border border-border bg-background">
            <button
              onClick={() => {
                setHeatmapType('hourly');
                setLoading(true);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-l-lg px-3 py-1.5 font-medium text-xs transition-colors',
                heatmapType === 'hourly'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              <Clock className="h-3.5 w-3.5" />
              Hourly
            </button>
            <button
              onClick={() => {
                setHeatmapType('calendar');
                setLoading(true);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-r-lg px-3 py-1.5 font-medium text-xs transition-colors',
                heatmapType === 'calendar'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              <Calendar className="h-3.5 w-3.5" />
              Calendar
            </button>
          </div>

          {/* Activity Type Selector */}
          <select
            value={activityType}
            onChange={(e) => {
              setActivityType(e.target.value as ActivityType);
              setLoading(true);
            }}
            className="rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-xs"
          >
            {ACTIVITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Refresh Button */}
          <button
            onClick={() => fetchData(true)}
            disabled={isRefreshing}
            className="rounded-lg bg-muted p-1.5 transition-colors hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
          </button>
        </div>
      </div>

      {/* Hourly Heatmap */}
      {isHourly && (
        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            {/* Hour labels */}
            <div className="mb-1 flex">
              <div className="w-12" /> {/* Spacer for day labels */}
              {HOUR_LABELS.map((label, i) => (
                <div
                  key={i}
                  className="flex-1 text-center text-muted-foreground text-xs"
                >
                  {label}
                </div>
              ))}
            </div>

            {/* Grid */}
            {DAY_NAMES.map((dayName, dayIndex) => (
              <div key={dayName} className="flex items-center gap-1">
                <div className="w-12 pr-2 text-right text-muted-foreground text-xs">
                  {dayName}
                </div>
                {Array.from({ length: 24 }).map((_, hourIndex) => {
                  const point = hourlyPointMap.get(`${dayIndex}-${hourIndex}`);
                  const count = point?.count ?? 0;
                  const intensity = point?.intensity ?? 0;

                  return (
                    <div
                      key={hourIndex}
                      className={cn(
                        'aspect-square flex-1 rounded-sm transition-colors',
                        getIntensityColor(intensity)
                      )}
                      title={`${dayName} ${hourIndex}:00 - ${count.toLocaleString()} activities`}
                    />
                  );
                })}
              </div>
            ))}

            {/* Legend */}
            <div className="mt-4 flex justify-end">
              <IntensityLegend />
            </div>
          </div>
        </div>
      )}

      {/* Calendar Heatmap */}
      {!isHourly && (
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            {/* Calendar grid - organized by week */}
            <div className="flex flex-wrap gap-1">
              {calendarData.map((point) => (
                <div
                  key={point.date}
                  className={cn(
                    'h-3 w-3 rounded-sm transition-colors',
                    getIntensityColor(point.intensity)
                  )}
                  title={`${point.date}: ${point.count.toLocaleString()} activities`}
                />
              ))}
            </div>

            {/* Legend */}
            <div className="mt-4 flex items-center justify-between">
              <div className="text-muted-foreground text-xs">
                {data.metadata.daysWithActivity} days with activity
              </div>
              <IntensityLegend />
            </div>
          </div>
        </div>
      )}

      {/* Stats Footer */}
      <div className="mt-4 flex items-center justify-between border-border border-t pt-4 text-sm">
        <div className="text-muted-foreground">
          Total:{' '}
          <span className="font-medium text-foreground">
            {formatNumber(data.metadata.totalActivities)}
          </span>{' '}
          activities
        </div>
        <div className="text-muted-foreground">
          Peak:{' '}
          <span className="font-medium text-foreground">
            {formatNumber(data.metadata.maxCount)}
          </span>{' '}
          / {isHourly ? 'hour' : 'day'}
        </div>
      </div>
    </div>
  );
}
