/**
 * My Agents type definitions.
 */

import type {
  CategoryId,
  SortBy,
  ExtendedCharacter,
  SearchFilters,
  PaginationResult,
  CategoryInfo,
} from "./characters";

// Re-export shared character types
export type {
  CategoryId,
  SortBy,
  SortOrder,
  CharacterSource,
  CharacterStats,
  ExtendedCharacter,
  SearchFilters,
  SortOptions,
  PaginationOptions,
  PaginationResult,
  CategoryInfo,
  CloneCharacterOptions,
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
