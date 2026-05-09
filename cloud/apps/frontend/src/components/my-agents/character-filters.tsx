/**
 * Character filters component providing search, view mode, and sort controls.
 * Displays character count and supports filtering and sorting options.
 *
 * @param props - Character filters configuration
 * @param props.searchQuery - Current search query
 * @param props.onSearchChange - Callback when search changes
 * @param props.viewMode - Current view mode (grid or list)
 * @param props.onViewModeChange - Callback when view mode changes
 * @param props.sortBy - Current sort option
 * @param props.onSortChange - Callback when sort changes
 * @param props.totalCount - Total number of characters
 * @param props.filteredCount - Number of characters after filtering
 */

"use client";

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/cloud-ui";
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
          <Input
            type="text"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 h-9 md:h-10 rounded-lg border-white/10 bg-neutral-900 text-white text-sm placeholder:text-neutral-500 focus:ring-1 focus:ring-[#FF5800]/50 focus:border-[#FF5800]/50"
          />
        </div>
        {searchQuery && (
          <span className="text-xs text-neutral-500 whitespace-nowrap">
            {filteredCount}/{totalCount}
          </span>
        )}
      </div>

      {/* Right side - Controls */}
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {/* Sort dropdown */}
        <Select value={sortBy} onValueChange={(v) => onSortChange(v as SortOption)}>
          <SelectTrigger className="h-9 w-full rounded-lg border-white/10 bg-neutral-900 text-sm text-neutral-400 focus:ring-1 focus:ring-[#FF5800]/50 sm:w-[160px] md:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg">
            <SelectItem value="modified">Last Modified</SelectItem>
            <SelectItem value="created">Created Date</SelectItem>
            <SelectItem value="name">Name (A-Z)</SelectItem>
            <SelectItem value="recent">Recently Used</SelectItem>
          </SelectContent>
        </Select>

        {/* View mode toggle */}
        <div className="flex h-9 shrink-0 rounded-lg bg-neutral-900 p-1 md:h-10">
          <button
            type="button"
            onClick={() => onViewModeChange("grid")}
            className={`flex items-center justify-center w-8 md:w-9 rounded-md transition-colors ${
              viewMode === "grid"
                ? "bg-white/10 text-white"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange("list")}
            className={`flex items-center justify-center w-8 md:w-9 rounded-md transition-colors ${
              viewMode === "list"
                ? "bg-white/10 text-white"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
