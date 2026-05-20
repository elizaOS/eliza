/**
 * Actors Data Loader
 *
 * Loads compatibility actor and organization data for legacy callers.
 * Actor records are pack-backed and exposed as `ActorData` for older APIs.
 *
 * **Architecture:**
 * - Default actor roster is sourced from the active pack
 * - Compatibility mappers expose pack actors as `ActorData`
 * - Organizations still use the existing compatibility source files
 * - In-memory caching avoids repeated cloning work
 *
 * **Performance:**
 * - First load: <1ms (direct imports, no file I/O)
 * - Subsequent loads: <1ms (uses cache)
 * - Single entity loads: Direct import (fastest)
 */

import { actors } from "./data/actors";
import { organizations } from "./data/organizations";
import type { ActorData, ActorsDatabase, Organization } from "./types/shared";

/**
 * Options for selective data loading
 */
export interface LoadActorsOptions {
  includeActors?: boolean;
  includeOrganizations?: boolean;
}

/**
 * In-memory cache for loaded data
 * Cleared on module reload, persists during runtime
 */
const dataCache: {
  actors: Map<string, ActorData>;
  organizations: Map<string, Organization>;
  allActors: ActorData[] | null;
  allOrganizations: Organization[] | null;
} = {
  actors: new Map(),
  organizations: new Map(),
  allActors: null,
  allOrganizations: null,
};

/**
 * Clear the data cache (useful for testing or when data changes)
 */
export function clearDataCache(): void {
  dataCache.actors.clear();
  dataCache.organizations.clear();
  dataCache.allActors = null;
  dataCache.allOrganizations = null;
}

/**
 * Initialize cache from imported data
 */
function initializeCache(): void {
  if (dataCache.allActors === null) {
    // Convert readonly arrays to mutable arrays and populate cache
    // The actors array contains readonly objects, so we need to create new objects
    dataCache.allActors = actors.map((actor) => {
      // Create a mutable copy of the actor data
      const actorData = { ...actor } as ActorData;
      dataCache.actors.set(actorData.id, actorData);
      return actorData;
    });
  }

  if (dataCache.allOrganizations === null) {
    // Convert readonly arrays to mutable arrays and populate cache
    // The organizations array contains readonly objects, so we need to create new objects
    dataCache.allOrganizations = organizations.map((org) => {
      // Create a mutable copy of the organization data
      const orgData = { ...org } as Organization;
      dataCache.organizations.set(orgData.id, orgData);
      return orgData;
    });
  }
}

/**
 * Loads all compatibility actor and organization data
 *
 * @deprecated Use StaticDataRegistry.getAllActors() and StaticDataRegistry.getAllOrganizations() instead.
 * This function maintains a separate cache from StaticDataRegistry, causing memory duplication.
 *
 * **Migration:**
 * ```typescript
 * // Before:
 * const { actors, organizations } = loadActorsData();
 *
 * // After:
 * const actors = StaticDataRegistry.getAllActors();
 * const organizations = StaticDataRegistry.getAllOrganizations();
 * ```
 *
 * @param options Optional configuration for selective loading
 * @returns ActorsDatabase with requested data
 */
export function loadActorsData(options?: LoadActorsOptions): ActorsDatabase {
  initializeCache();

  // Default to loading everything if no options provided
  const includeActors = options?.includeActors !== false;
  const includeOrganizations = options?.includeOrganizations !== false;

  return {
    actors: includeActors ? [...(dataCache.allActors ?? [])] : [],
    organizations: includeOrganizations
      ? [...(dataCache.allOrganizations ?? [])]
      : [],
    relationships: [], // Relationships are now dynamic, stored in DB
  };
}

/**
 * Loads a single actor by ID from the pack-backed compatibility cache.
 *
 * **Performance:** Direct cache lookup, no I/O
 *
 * @param actorId The ID of the actor to load
 * @returns Actor data or null if not found
 */
export function loadActorById(actorId: string): ActorData | null {
  initializeCache();

  // Check cache first (fastest - no I/O)
  if (dataCache.actors.has(actorId)) {
    return dataCache.actors.get(actorId)!;
  }

  return null;
}

/**
 * Loads a single organization by ID - OPTIMIZED with caching
 * Checks cache first, then looks up from imported data
 *
 * **Performance:** Direct cache lookup, no I/O
 *
 * @param orgId The ID of the organization to load
 * @returns Organization data or null if not found
 */
export function loadOrganizationById(orgId: string): Organization | null {
  initializeCache();

  // Check cache first (fastest - no I/O)
  if (dataCache.organizations.has(orgId)) {
    return dataCache.organizations.get(orgId)!;
  }

  return null;
}

/**
 * Get all actor IDs from the compatibility cache.
 * Useful when you only need IDs for lookups
 *
 * @returns Array of actor IDs
 */
export function getActorIds(): string[] {
  initializeCache();
  return dataCache.allActors?.map((actor) => actor.id) ?? [];
}

/**
 * Get all organization IDs from the imported data
 * Useful when you only need IDs for lookups
 *
 * @returns Array of organization IDs
 */
export function getOrganizationIds(): string[] {
  initializeCache();
  return dataCache.allOrganizations?.map((org) => org.id) ?? [];
}
