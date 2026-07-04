/**
 * Analytics filters: aggregation (time-range bucket) selector + preset date
 * ranges, synced to the URL search params.
 *
 * BUG-FIX NOTE (the "weekly bug"): the original UI wrote `granularity` /
 * `startDate` / `endDate` to the URL, but the breakdown endpoint
 * (`/api/analytics/breakdown`) only honors a coarse `timeRange`
 * (`daily` | `weekly` | `monthly`) — it derives the date range + granularity
 * itself. So the aggregation control now drives the `timeRange` param the
 * backend actually reads (and `Page.tsx` keys its query on it). The preset
 * buttons keep writing `startDate` / `endDate` because those still feed the
 * filter-aware export (`/api/analytics/export` via `ExportButton`).
 */
"use client";

import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  BrandButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../cloud-ui";
import { cn } from "../../../lib/utils";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  ANALYTICS_TIME_RANGES,
  type AnalyticsTimeRange,
  resolveTimeRangeParam,
} from "../lib/time-range";

export function AnalyticsFilters() {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const timeRange = resolveTimeRangeParam(searchParams.get("timeRange"));
  const startDateParam = searchParams.get("startDate");
  const endDateParam = searchParams.get("endDate");

  const activeRange = useMemo(() => {
    if (!startDateParam || !endDateParam) return undefined;
    const start = new Date(startDateParam);
    const end = new Date(endDateParam);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
      return undefined;
    }

    const diffInDays = Math.round(
      (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );

    const now = new Date();
    const isAlignedWithNow =
      Math.abs(end.getTime() - now.getTime()) < 1000 * 60 * 60;

    if (diffInDays === 7 && isAlignedWithNow) return "7d";
    if (diffInDays === 30 && isAlignedWithNow) return "30d";
    if (diffInDays === 90 && isAlignedWithNow) return "90d";

    return "custom";
  }, [startDateParam, endDateParam]);

  const rangeLabels: Record<AnalyticsTimeRange, string> = {
    daily: t("cloud.analytics.filters.daily", { defaultValue: "Daily" }),
    weekly: t("cloud.analytics.filters.weekly", { defaultValue: "Weekly" }),
    monthly: t("cloud.analytics.filters.monthly", { defaultValue: "Monthly" }),
  };

  const presets = [
    {
      label: t("cloud.analytics.filters.last7", {
        defaultValue: "Last 7 days",
      }),
      value: "7d",
      days: 7,
    },
    {
      label: t("cloud.analytics.filters.last30", {
        defaultValue: "Last 30 days",
      }),
      value: "30d",
      days: 30,
    },
    {
      label: t("cloud.analytics.filters.last90", {
        defaultValue: "Last 90 days",
      }),
      value: "90d",
      days: 90,
    },
  ] as const;

  const updateFilters = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      params.set(key, value);
    }
    navigate(`/dashboard/analytics?${params.toString()}`);
  };

  return (
    <div className="flex flex-col gap-5 md:gap-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-4 md:gap-5">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-white/50">
            {t("cloud.analytics.filters.aggregation", {
              defaultValue: "Aggregation",
            })}
          </p>
          <Select
            value={timeRange}
            onValueChange={(value) => updateFilters({ timeRange: value })}
          >
            <SelectTrigger className="w-[160px] rounded-sm border-white/10 bg-black/40 text-white  ">
              <SelectValue>{rangeLabels[timeRange]}</SelectValue>
            </SelectTrigger>
            <SelectContent className="rounded-sm border-white/10 bg-black/90">
              {ANALYTICS_TIME_RANGES.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  className="rounded-sm text-white hover:bg-white/10 "
                >
                  {rangeLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeRange === "custom" ? (
          <span className="flex items-center gap-1 rounded-sm border border-white/20 bg-white/10 px-3 py-1 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
            {t("cloud.analytics.filters.customRange", {
              defaultValue: "Custom range detected",
            })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3 md:gap-4">
        {presets.map((preset) => {
          const isActive = activeRange === preset.value;

          return (
            <BrandButton
              key={preset.value}
              variant={isActive ? "primary" : "outline"}
              size="sm"
              className={cn(
                "text-xs font-medium transition-colors",
                !isActive && "hover:bg-white/5",
              )}
              onClick={() => {
                const now = new Date();
                const start = new Date(
                  now.getTime() - preset.days * 24 * 60 * 60 * 1000,
                );

                updateFilters({
                  startDate: start.toISOString(),
                  endDate: now.toISOString(),
                });
              }}
            >
              {preset.label}
            </BrandButton>
          );
        })}
      </div>
    </div>
  );
}
