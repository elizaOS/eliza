/**
 * Analytics filters component for date range and granularity selection.
 * Supports preset ranges (7d, 30d, 90d) and custom date selection with URL sync.
 */
"use client";

import {
  BrandButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/cloud-ui";
import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";

export function AnalyticsFilters() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const granularity = searchParams.get("granularity") || "day";
  const startDateParam = searchParams.get("startDate");
  const endDateParam = searchParams.get("endDate");

  const activeRange = useMemo(() => {
    if (!startDateParam || !endDateParam) return undefined;
    const start = new Date(startDateParam);
    const end = new Date(endDateParam);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
      return undefined;
    }

    const diffInDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

    const now = new Date();
    const isAlignedWithNow = Math.abs(end.getTime() - now.getTime()) < 1000 * 60 * 60;

    if (diffInDays === 7 && isAlignedWithNow) return "7d";
    if (diffInDays === 30 && isAlignedWithNow) return "30d";
    if (diffInDays === 90 && isAlignedWithNow) return "90d";

    return "custom";
  }, [startDateParam, endDateParam]);

  const presets = [
    { label: "Last 7 days", value: "7d", days: 7 },
    { label: "Last 30 days", value: "30d", days: 30 },
    { label: "Last 90 days", value: "90d", days: 90 },
  ] as const;

  const updateFilters = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      params.set(key, value);
    });
    navigate(`/dashboard/analytics?${params.toString()}`);
  };

  return (
    <div className="flex flex-col gap-5 md:gap-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-4 md:gap-5">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-white/50">Aggregation</p>
          <Select
            value={granularity}
            onValueChange={(value) => updateFilters({ granularity: value })}
          >
            <SelectTrigger className="w-[160px] rounded-none border-white/10 bg-black/40 text-white focus:ring-1 focus:ring-[#FF5800]">
              <SelectValue>
                {granularity.charAt(0).toUpperCase() + granularity.slice(1)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="rounded-none border-white/10 bg-black/90">
              <SelectItem
                value="hour"
                className="rounded-none text-white hover:bg-white/10 focus:bg-white/10"
              >
                Hourly
              </SelectItem>
              <SelectItem
                value="day"
                className="rounded-none text-white hover:bg-white/10 focus:bg-white/10"
              >
                Daily
              </SelectItem>
              <SelectItem
                value="week"
                className="rounded-none text-white hover:bg-white/10 focus:bg-white/10"
              >
                Weekly
              </SelectItem>
              <SelectItem
                value="month"
                className="rounded-none text-white hover:bg-white/10 focus:bg-white/10"
              >
                Monthly
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {activeRange === "custom" ? (
          <span className="flex items-center gap-1 rounded-none border border-white/20 bg-white/10 px-3 py-1 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-[#FF5800]" />
            Custom range detected
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
                const start = new Date(now.getTime() - preset.days * 24 * 60 * 60 * 1000);

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
