/**
 * Agent filters — search, view-mode toggle, and sort controls for the agent
 * library. Ported from
 * `@elizaos/cloud-frontend/src/components/my-agents/character-filters.tsx` with
 * the brand fix: the original active view-toggle used `text-[#0c4f8d]` (a blue),
 * which violates the app's no-blue rule. The active toggle now reads as the
 * brand-neutral foreground; the rest of the light-on-glass treatment is
 * preserved.
 */

"use client";

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui/cloud-ui";
import { LayoutGrid, List, Search } from "lucide-react";
import { useT } from "../lib/i18n";
import type { SortOption, ViewMode } from "./types";

interface CharacterFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  totalCount: number;
  filteredCount: number;
}

export function CharacterFilters({
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  sortBy,
  onSortChange,
  totalCount,
  filteredCount,
}: CharacterFiltersProps) {
  const t = useT();
  return (
    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
      {/* Left side - Search and count */}
      <div className="flex w-full flex-1 items-center gap-3 sm:w-auto">
        <div className="relative w-full flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
          <Input
            type="text"
            placeholder={t("cloud.characterFilters.searchPlaceholder", {
              defaultValue: "Search agent...",
            })}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 rounded-full border-white/15 bg-black/40 pl-9 text-sm text-white placeholder:text-white/35 focus-visible:ring-[var(--brand-orange)]/50 md:h-10"
          />
        </div>
        {searchQuery && (
          <span className="whitespace-nowrap text-xs text-white/50">
            {filteredCount}/{totalCount}
          </span>
        )}
      </div>

      {/* Right side - Controls */}
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {/* Sort dropdown */}
        <Select
          value={sortBy}
          onValueChange={(v) => onSortChange(v as SortOption)}
        >
          <SelectTrigger className="h-9 w-full rounded-full border-white/15 bg-black/40 text-sm text-white/70 focus:ring-1 focus:ring-[var(--brand-orange)]/50 sm:w-[160px] md:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-sm">
            <SelectItem value="modified">
              {t("cloud.characterFilters.sortLastUpdated", {
                defaultValue: "Last Updated",
              })}
            </SelectItem>
            <SelectItem value="created">
              {t("cloud.characterFilters.sortCreatedDate", {
                defaultValue: "Created Date",
              })}
            </SelectItem>
            <SelectItem value="name">
              {t("cloud.characterFilters.sortName", {
                defaultValue: "Name (A-Z)",
              })}
            </SelectItem>
            <SelectItem value="recent">
              {t("cloud.characterFilters.sortRecentActivity", {
                defaultValue: "Recent Activity",
              })}
            </SelectItem>
          </SelectContent>
        </Select>

        {/* View mode toggle */}
        <div className="flex h-9 shrink-0 rounded-full border border-white/15 bg-black/40 p-1 md:h-10">
          <button
            type="button"
            aria-label={t("cloud.characterFilters.gridView", {
              defaultValue: "Grid view",
            })}
            aria-pressed={viewMode === "grid"}
            onClick={() => onViewModeChange("grid")}
            className={`flex items-center justify-center w-8 md:w-9 rounded-sm transition-colors ${
              viewMode === "grid"
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("cloud.characterFilters.listView", {
              defaultValue: "List view",
            })}
            aria-pressed={viewMode === "list"}
            onClick={() => onViewModeChange("list")}
            className={`flex items-center justify-center w-8 md:w-9 rounded-sm transition-colors ${
              viewMode === "list"
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white"
            }`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
