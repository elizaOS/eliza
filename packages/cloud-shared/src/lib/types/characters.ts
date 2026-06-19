/**
 * Type definitions for character-related functionality.
 */

import type { ElizaCharacter } from "./eliza-character";

/**
 * Character category identifier.
 */
export type CategoryId =
  | "assistant"
  | "anime"
  | "creative"
  | "gaming"
  | "learning"
  | "entertainment"
  | "history"
  | "lifestyle";

/**
 * Sort field for character listings.
 */
export type SortBy = "popularity" | "newest" | "name" | "updated";

/**
 * Sort order direction.
 */
export type SortOrder = "asc" | "desc";

/**
 * Source of character creation.
 */
export type CharacterSource = "cloud";

/**
 * Statistics for a character.
 */
export interface CharacterStats {
  messageCount: number;
  roomCount: number;
  lastActiveAt: Date | null;
  deploymentStatus: "deployed" | "draft" | "stopped";
  uptime?: number;
}

/**
 * Extended character with display metadata.
 */
export interface ExtendedCharacter extends ElizaCharacter {
  id: string;
  isTemplate: boolean;
  isPublic: boolean;
  creatorName?: string;
  creatorId?: string;
  avatarUrl?: string;
  category?: CategoryId;
  tags?: string[];
  featured?: boolean;
  popularity?: number;
  viewCount?: number;
  interactionCount?: number;
  stats?: CharacterStats;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Filters for character search.
 */
export interface SearchFilters {
  search?: string;
  category?: CategoryId;
  hasVoice?: boolean;
  deployed?: boolean;
  template?: boolean;
  myCharacters?: boolean;
  public?: boolean;
  featured?: boolean;
  source?: CharacterSource; // Filter by where character was created
}

/**
 * Sort options for character listings.
 */
export interface SortOptions {
  sortBy: SortBy;
  order: SortOrder;
}

/**
 * Pagination options for character listings.
 */
export interface PaginationOptions {
  page: number;
  limit: number;
}

/**
 * Pagination result with metadata.
 */
export interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Category information with metadata.
 */
export interface CategoryInfo {
  id: CategoryId;
  name: string;
  description: string;
  icon: string;
  color: string;
  characterCount: number;
  featured: boolean;
}

/**
 * Options for cloning a character.
 */
export interface CloneCharacterOptions {
  name?: string;
  makePublic?: boolean;
}

/**
 * Response from tracking operations (views, interactions).
 */
export interface TrackingResponse {
  success: boolean;
  count: number;
}
