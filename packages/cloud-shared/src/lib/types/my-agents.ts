/**
 * My Agents type definitions.
 */

import type {
  CategoryId,
  CategoryInfo,
  ExtendedCharacter,
  PaginationResult,
  SearchFilters,
  SortBy,
} from "./characters";

// Re-export shared character types
export type {
  CategoryId,
  CategoryInfo,
  CharacterSource,
  CharacterStats,
  CloneCharacterOptions,
  ExtendedCharacter,
  PaginationOptions,
  PaginationResult,
  SearchFilters,
  SortBy,
  SortOptions,
  SortOrder,
  TrackingResponse,
} from "./characters";

/**
 * Result of a my agents search query.
 */
export interface MyAgentsSearchResult {
  characters: ExtendedCharacter[];
  pagination: PaginationResult;
  filters: {
    appliedFilters: SearchFilters;
    availableCategories: CategoryInfo[];
  };
  cached: boolean;
}

/**
 * State for my agents UI component.
 */
export interface MyAgentsState {
  characters: ExtendedCharacter[];
  filteredCharacters: ExtendedCharacter[];
  selectedCharacter: ExtendedCharacter | null;
  view: "grid" | "list";
  activeCategory: CategoryId | null;
  searchQuery: string;
  sortBy: SortBy;
  filters: SearchFilters;
  isLoading: boolean;
  isLoadingStats: boolean;
}
