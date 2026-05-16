/**
 * Agent filters component providing search, view mode, and sort controls.
 * Displays agent count and supports filtering and sorting options.
 *
 * @param props - Character filters configuration
 * @param props.searchQuery - Current search query
 * @param props.onSearchChange - Callback when search changes
 * @param props.viewMode - Current view mode (grid or list)
 * @param props.onViewModeChange - Callback when view mode changes
 * @param props.sortBy - Current sort option
 * @param props.onSortChange - Callback when sort changes
 * @param props.totalCount - Total number of agents
 * @param props.filteredCount - Number of agents after filtering
 */

"use client";

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { LayoutGrid, List, Search } from "lucide-react";
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
  return (
    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
      {/* Left side - Search and count */}
      <div className="flex w-full flex-1 items-center gap-3 sm:w-auto">
        <div className="relative w-full flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#06131f]/42" />
          <Input
            type="text"
            placeholder="Search agent..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 rounded-full border-white/42 bg-white/58 pl-9 text-sm text-[#06131f] placeholder:text-[#06131f]/42 focus:border-accent/50 focus:ring-1 focus:ring-accent/50 md:h-10"
          />
        </div>
        {searchQuery && (
          <span className="whitespace-nowrap text-xs text-[#06131f]/52">
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
          <SelectTrigger className="h-9 w-full rounded-full border-white/42 bg-white/58 text-sm text-[#06131f]/72 focus:ring-1 focus:ring-accent/50 sm:w-[160px] md:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg">
            <SelectItem value="modified">Last Updated</SelectItem>
            <SelectItem value="created">Created Date</SelectItem>
            <SelectItem value="name">Name (A-Z)</SelectItem>
            <SelectItem value="recent">Recent Activity</SelectItem>
          </SelectContent>
        </Select>

        {/* View mode toggle */}
        <div className="flex h-9 shrink-0 rounded-full border border-white/42 bg-white/48 p-1 md:h-10">
          <button
            type="button"
            onClick={() => onViewModeChange("grid")}
            className={`flex items-center justify-center w-8 md:w-9 rounded-md transition-colors ${
              viewMode === "grid"
                ? "bg-white text-[#0c4f8d] shadow-sm"
                : "text-[#06131f]/50 hover:text-[#06131f]"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange("list")}
            className={`flex items-center justify-center w-8 md:w-9 rounded-md transition-colors ${
              viewMode === "list"
                ? "bg-white text-[#0c4f8d] shadow-sm"
                : "text-[#06131f]/50 hover:text-[#06131f]"
            }`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
