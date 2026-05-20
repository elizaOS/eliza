"use client";

import { cn } from "@feed/shared";
import { Calendar, ChevronDown, Filter, X } from "lucide-react";
import { useCallback, useState } from "react";

/**
 * Date range presets
 */
const DATE_PRESETS = [
  { label: "Today", days: 0 },
  { label: "Yesterday", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Custom", days: -1 },
] as const;

export interface FilterConfig {
  dateRange?: {
    startDate: Date | null;
    endDate: Date | null;
    preset: string;
  };
  entityType?: string;
  customFilters?: Record<string, string>;
}

interface FilterPanelProps {
  filters: FilterConfig;
  onFilterChange: (filters: FilterConfig) => void;
  entityOptions?: Array<{ value: string; label: string }>;
  customFilterOptions?: Array<{
    key: string;
    label: string;
    options: Array<{ value: string; label: string }>;
  }>;
  className?: string;
}

/**
 * FilterPanel component for admin dashboards
 * Provides date range picker, entity filters, and custom filters
 */
export function FilterPanel({
  filters,
  onFilterChange,
  entityOptions,
  customFilterOptions,
  className,
}: FilterPanelProps) {
  const [showFilters, setShowFilters] = useState(false);

  const handlePresetClick = useCallback(
    (preset: (typeof DATE_PRESETS)[number]) => {
      if (preset.days === -1) {
        // Custom date range - handled by custom date inputs
        return;
      }

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - preset.days);

      onFilterChange({
        ...filters,
        dateRange: { startDate, endDate, preset: preset.label },
      });
    },
    [filters, onFilterChange],
  );

  const handleEntityChange = useCallback(
    (value: string) => {
      onFilterChange({
        ...filters,
        entityType: value,
      });
    },
    [filters, onFilterChange],
  );

  const handleCustomFilterChange = useCallback(
    (key: string, value: string) => {
      onFilterChange({
        ...filters,
        customFilters: {
          ...filters.customFilters,
          [key]: value,
        },
      });
    },
    [filters, onFilterChange],
  );

  const handleClearFilters = useCallback(() => {
    onFilterChange({
      dateRange: {
        startDate: null,
        endDate: null,
        preset: "All time",
      },
      entityType: "all",
      customFilters: {},
    });
  }, [onFilterChange]);

  const handleCustomDateChange = useCallback(
    (type: "start" | "end", value: string) => {
      const date = value ? new Date(value) : null;
      onFilterChange({
        ...filters,
        dateRange: {
          ...filters.dateRange,
          startDate:
            type === "start" ? date : filters.dateRange?.startDate || null,
          endDate: type === "end" ? date : filters.dateRange?.endDate || null,
          preset: "Custom",
        },
      });
    },
    [filters, onFilterChange],
  );

  const activeFiltersCount =
    (filters.dateRange?.preset && filters.dateRange.preset !== "All time"
      ? 1
      : 0) +
    (filters.entityType && filters.entityType !== "all" ? 1 : 0) +
    Object.values(filters.customFilters || {}).filter((v) => v && v !== "all")
      .length;

  return (
    <div className={cn("space-y-3", className)}>
      {/* Filter Toggle and Active Chips */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 font-medium text-sm transition-colors",
            showFilters
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-card text-muted-foreground hover:border-primary/50",
          )}
        >
          <Filter className="h-4 w-4" />
          Filters
          {activeFiltersCount > 0 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
              {activeFiltersCount}
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform",
              showFilters && "rotate-180",
            )}
          />
        </button>

        {/* Active Filter Chips */}
        {filters.dateRange?.preset &&
          filters.dateRange.preset !== "All time" && (
            <FilterChip
              label={filters.dateRange.preset}
              onRemove={() =>
                onFilterChange({
                  ...filters,
                  dateRange: {
                    startDate: null,
                    endDate: null,
                    preset: "All time",
                  },
                })
              }
            />
          )}
        {filters.entityType && filters.entityType !== "all" && (
          <FilterChip
            label={
              entityOptions?.find((o) => o.value === filters.entityType)
                ?.label || filters.entityType
            }
            onRemove={() => onFilterChange({ ...filters, entityType: "all" })}
          />
        )}
        {Object.entries(filters.customFilters || {}).map(([key, value]) => {
          if (!value || value === "all") return null;
          const option = customFilterOptions?.find((o) => o.key === key);
          const label =
            option?.options.find((o) => o.value === value)?.label || value;
          return (
            <FilterChip
              key={key}
              label={`${option?.label || key}: ${label}`}
              onRemove={() =>
                onFilterChange({
                  ...filters,
                  customFilters: { ...filters.customFilters, [key]: "all" },
                })
              }
            />
          );
        })}

        {activeFiltersCount > 0 && (
          <button
            onClick={handleClearFilters}
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Expanded Filter Panel */}
      {showFilters && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* Date Range */}
            <div>
              <label className="mb-2 block font-medium text-muted-foreground text-sm">
                <Calendar className="mr-1 inline h-4 w-4" />
                Date Range
              </label>
              <div className="flex flex-wrap gap-1">
                {DATE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => handlePresetClick(preset)}
                    className={cn(
                      "rounded px-2 py-1 text-xs transition-colors",
                      filters.dateRange?.preset === preset.label
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80",
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {/* Custom Date Inputs */}
              {filters.dateRange?.preset === "Custom" && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="date"
                    value={
                      filters.dateRange.startDate
                        ? filters.dateRange.startDate
                            .toISOString()
                            .split("T")[0]
                        : ""
                    }
                    onChange={(e) =>
                      handleCustomDateChange("start", e.target.value)
                    }
                    className="rounded border border-border bg-background px-2 py-1 text-sm"
                  />
                  <span className="text-muted-foreground">to</span>
                  <input
                    type="date"
                    value={
                      filters.dateRange.endDate
                        ? filters.dateRange.endDate.toISOString().split("T")[0]
                        : ""
                    }
                    onChange={(e) =>
                      handleCustomDateChange("end", e.target.value)
                    }
                    className="rounded border border-border bg-background px-2 py-1 text-sm"
                  />
                </div>
              )}
            </div>

            {/* Entity Type Filter */}
            {entityOptions && entityOptions.length > 0 && (
              <div>
                <label className="mb-2 block font-medium text-muted-foreground text-sm">
                  Entity Type
                </label>
                <select
                  value={filters.entityType || "all"}
                  onChange={(e) => handleEntityChange(e.target.value)}
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="all">All</option>
                  {entityOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Custom Filters */}
            {customFilterOptions?.map((filterOption) => (
              <div key={filterOption.key}>
                <label className="mb-2 block font-medium text-muted-foreground text-sm">
                  {filterOption.label}
                </label>
                <select
                  value={filters.customFilters?.[filterOption.key] || "all"}
                  onChange={(e) =>
                    handleCustomFilterChange(filterOption.key, e.target.value)
                  }
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="all">All</option>
                  {filterOption.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Filter chip component
 */
function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-primary text-sm">
      {label}
      <button
        onClick={onRemove}
        className="hover:text-primary/70"
        aria-label={`Remove ${label} filter`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
