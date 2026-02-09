/**
 * Shared caching module for provider room/world lookups.
 *
 * This module provides a single, process-wide cache for room and world data
 * to prevent redundant DB calls when multiple providers run in parallel.
 *
 * TWO-LEVEL CACHING STRATEGY:
 * 1. Agent-specific cache (by roomId/worldId) - for within-agent provider deduplication
 * 2. External ID cache (by source:channelId, source:guildId) - for cross-agent deduplication
 *
 * Since roomIds/worldIds are agent-specific (hash of externalId:agentId), we use
 * Discord's raw IDs (guildId, channelId) as secondary cache keys that ALL agents share.
 */
import type { IAgentRuntime, Room, UUID, World, WorldSettings } from '@elizaos/core';
import { createUniqueUuid, getSalt, logger, unsaltWorldSettings } from '@elizaos/core';

// Cache TTL in milliseconds (30 seconds - short enough to pick up changes, long enough to help)
const CACHE_TTL_MS = 30_000;
// Timeout for DB operations to prevent 80+ second waits
const DB_TIMEOUT_MS = 5_000;
// Longer cache TTL for negative results (e.g., worlds without serverId)
const NEGATIVE_CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  isNegative?: boolean;
}

// ============================================================================
// ROOM CACHE - Agent-specific (by roomId)
// ============================================================================

const roomCache = new Map<string, CacheEntry<Room | null>>();
const roomInFlight = new Map<string, Promise<Room | null>>();

// ============================================================================
// EXTERNAL ROOM CACHE - Cross-agent (by source:channelId)
// Stores room data that can be shared across agents
// ============================================================================

interface ExternalRoomData {
  name?: string;
  source: string;
  type: import('@elizaos/core').ChannelType;
  channelId?: string;
  messageServerId?: string;
  metadata?: import('@elizaos/core').Metadata;
}

const externalRoomCache = new Map<string, CacheEntry<ExternalRoomData | null>>();

// ============================================================================
// WORLD CACHE - Agent-specific (by worldId)
// ============================================================================

const worldCache = new Map<string, CacheEntry<World | null>>();
const worldInFlight = new Map<string, Promise<World | null>>();

// ============================================================================
// EXTERNAL WORLD CACHE - Cross-agent (by source:guildId/serverId)
// Stores world metadata that can be shared across agents
// ============================================================================

interface ExternalWorldData {
  name?: string;
  messageServerId?: string;
  metadata?: import('@elizaos/core').Metadata;
  // Settings are stored by raw serverId, so they're shared across agents
  settings?: WorldSettings;
}

const externalWorldCache = new Map<string, CacheEntry<ExternalWorldData | null>>();
const externalWorldInFlight = new Map<string, Promise<ExternalWorldData | null>>();

// Cache for servers/guilds we've determined have no settings (saves future lookups)
// Keyed by raw external ID (e.g., Discord guildId) - shared across ALL agents
const noServerIdCache = new Map<string, CacheEntry<boolean>>();
const noSettingsCache = new Map<string, CacheEntry<boolean>>();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Promise with timeout - prevents indefinite waits on slow DB operations.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  let settled = false;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => {
      if (settled) return; // Main promise already won the race; no-op.
      logger.warn(
        { src: 'plugin:bootstrap:cache', timeoutMs: ms },
        'DB operation timed out, returning fallback'
      );
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    settled = true;
    clearTimeout(timeoutId!);
  }
}

/**
 * Remove expired entries from a cache map by TTL.
 * Returns the number of entries evicted.
 *
 * Called in two contexts:
 * 1. Inline after a fetch (burst guard) - caps at maxSize to prevent sudden spikes
 * 2. Periodic sweep (steady-state) - maxSize=0 to evict everything expired
 */
function evictExpired<T>(cache: Map<string, CacheEntry<T>>, maxSize: number, ttl: number): number {
  // Burst guard: only run the inline eviction when we're over the cap.
  // The periodic sweep passes maxSize=0, so it always runs.
  if (maxSize > 0 && cache.size <= maxSize) return 0;

  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of cache) {
    // Use the entry's own TTL if it's a negative-cache entry, otherwise use the provided TTL
    const entryTtl = entry.isNegative ? NEGATIVE_CACHE_TTL_MS : ttl;
    if (now - entry.timestamp > entryTtl) {
      cache.delete(key);
      evicted++;
    }
  }
  return evicted;
}

// ============================================================================
// PERIODIC CACHE SWEEP
// ============================================================================
//
// WHY: Without periodic cleanup, caches leak memory in two ways:
// 1. Caches below maxSize never trigger inline eviction - stale entries accumulate
// 2. Several caches (externalRoomCache, noServerIdCache, noSettingsCache) had no
//    inline eviction at all - completely unbounded growth
// 3. Idle systems (no fetches) never trigger any cleanup
//
// The sweep runs every 60s (2x the standard TTL), iterates ALL caches, and
// removes entries past their TTL. The timer is unref'd so it won't keep the
// process alive.

const SWEEP_INTERVAL_MS = 60_000;

function sweepAllCaches(): void {
  evictExpired(roomCache, 0, CACHE_TTL_MS);
  evictExpired(externalRoomCache, 0, CACHE_TTL_MS);
  evictExpired(worldCache, 0, CACHE_TTL_MS);
  evictExpired(externalWorldCache, 0, CACHE_TTL_MS);
  evictExpired(noServerIdCache, 0, NEGATIVE_CACHE_TTL_MS);
  evictExpired(noSettingsCache, 0, NEGATIVE_CACHE_TTL_MS);
  evictExpired(entitiesCache, 0, CACHE_TTL_MS);
  evictExpired(worldSettingsCache, 0, CACHE_TTL_MS);
}

// Lazy-initialized sweep timer. Starts on first cache access rather than
// on module import, avoiding side effects at load time and timer leaks
// in test environments that never call stopCacheMaintenance().
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepTimer(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(sweepAllCaches, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for cache maintenance
  if (sweepTimer && typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    (sweepTimer as { unref: () => void }).unref();
  }
}

/**
 * Stop the periodic cache sweep and clear all caches.
 * Call during shutdown or in tests to prevent timer leaks.
 */
export function stopCacheMaintenance(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  roomCache.clear();
  roomInFlight.clear();
  externalRoomCache.clear();
  worldCache.clear();
  worldInFlight.clear();
  externalWorldCache.clear();
  externalWorldInFlight.clear();
  noServerIdCache.clear();
  noSettingsCache.clear();
  entitiesCache.clear();
  entitiesInFlight.clear();
  worldSettingsCache.clear();
  worldSettingsInFlight.clear();
}

// ============================================================================
// ROOM CACHE FUNCTIONS
// ============================================================================

/**
 * Build external cache key from room data.
 * Uses source:channelId which is shared across all agents.
 */
function getExternalRoomKey(room: Room | ExternalRoomData): string | null {
  if (!room.source || !room.channelId) return null;
  return `${room.source}:${room.channelId}`;
}

/**
 * Store room data in the external (cross-agent) cache.
 */
function cacheRoomByExternalId(room: Room): void {
  const key = getExternalRoomKey(room);
  if (!key) return;

  const externalData: ExternalRoomData = {
    name: room.name,
    source: room.source,
    type: room.type,
    channelId: room.channelId,
    messageServerId: room.messageServerId ?? room.serverId,
    metadata: room.metadata,
  };
  externalRoomCache.set(key, { data: externalData, timestamp: Date.now() });
}

/**
 * Get cached room or fetch from DB with promise coalescing.
 *
 * Two-level caching:
 * 1. First checks agent-specific cache (by roomId)
 * 2. Then checks external cache (by source:channelId) for cross-agent hits
 *
 * @param runtime - The agent runtime
 * @param roomId - The room UUID to fetch
 * @returns The room data or null if not found
 */
export async function getCachedRoom(runtime: IAgentRuntime, roomId: UUID): Promise<Room | null> {
  ensureSweepTimer();
  const cacheKey = roomId;
  const cached = roomCache.get(cacheKey);
  const now = Date.now();

  // Return cached data if valid
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Check if ANY agent/provider already has an in-flight request for this room
  const inFlight = roomInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Create new promise and store it BEFORE awaiting
  const fetchPromise = (async () => {
    try {
      const room = await withTimeout(runtime.getRoom(roomId), DB_TIMEOUT_MS, null);
      roomCache.set(cacheKey, { data: room, timestamp: Date.now() });

      // Also cache by external ID for cross-agent benefit
      if (room) {
        cacheRoomByExternalId(room);
      }

      return room;
    } finally {
      roomInFlight.delete(cacheKey);
    }
  })();

  roomInFlight.set(cacheKey, fetchPromise);
  evictExpired(roomCache, 500, CACHE_TTL_MS);

  return fetchPromise;
}

/**
 * Get cached room data by external ID (source:channelId).
 * This is useful for cross-agent lookups where you have the raw Discord IDs.
 *
 * @param source - The source (e.g., "discord")
 * @param channelId - The raw channel ID from Discord
 * @returns Cached external room data or null
 */
export function getCachedRoomByExternalId(
  source: string,
  channelId: string
): ExternalRoomData | null {
  const key = `${source}:${channelId}`;
  const cached = externalRoomCache.get(key);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

/**
 * Invalidate the room cache for a specific room (low-level).
 * For most use cases, prefer the combined invalidateRoomCache wrapper below.
 */
function invalidateRoomCacheInternal(roomId: UUID): void {
  roomCache.delete(roomId);
}

/**
 * Invalidate cache for a room (combined wrapper).
 * Clears both room and entities cache for proper cache coherence.
 * This is the recommended function to use when entities change.
 */
export function invalidateRoomCache(agentId: UUID, roomId: UUID): void {
  invalidateRoomCacheInternal(roomId);
  invalidateEntitiesCache(agentId, roomId);
}

/**
 * Invalidate room cache by external ID.
 */
export function invalidateRoomCacheByExternalId(source: string, channelId: string): void {
  externalRoomCache.delete(`${source}:${channelId}`);
}

// ============================================================================
// WORLD CACHE FUNCTIONS
// ============================================================================

/**
 * Build external cache key from world data.
 * Uses the raw messageServerId (Discord guildId) which is shared across all agents.
 */
function getExternalWorldKey(world: World | { messageServerId?: string }): string | null {
  const serverId = world.messageServerId;
  if (!serverId) return null;
  return `guild:${serverId}`;
}

/**
 * Store world data in the external (cross-agent) cache.
 * Most importantly, caches the settings which are keyed by raw serverId.
 */
function cacheWorldByExternalId(world: World): void {
  const key = getExternalWorldKey(world);
  if (!key) return;

  const externalData: ExternalWorldData = {
    name: world.name,
    messageServerId: world.messageServerId,
    metadata: world.metadata,
  };

  // Extract and cache settings if present
  if (world.metadata?.settings) {
    try {
      const salt = getSalt();
      externalData.settings = unsaltWorldSettings(world.metadata.settings as WorldSettings, salt);
    } catch {
      // Settings decryption failed, skip caching settings
    }
  }

  externalWorldCache.set(key, { data: externalData, timestamp: Date.now() });
}

/**
 * Get cached world or fetch from DB with promise coalescing and timeout.
 *
 * @param runtime - The agent runtime
 * @param worldId - The world UUID to fetch
 * @returns The world data or null if not found
 */
export async function getCachedWorld(runtime: IAgentRuntime, worldId: UUID): Promise<World | null> {
  ensureSweepTimer();
  const cacheKey = worldId;
  const cached = worldCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Check if ANY agent already has an in-flight request for this world
  const inFlight = worldInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Create new promise and store it BEFORE awaiting
  const fetchPromise = (async () => {
    try {
      const world = await withTimeout(runtime.getWorld(worldId), DB_TIMEOUT_MS, null);
      worldCache.set(cacheKey, { data: world, timestamp: Date.now() });

      // Also cache by external ID (guildId) for cross-agent benefit
      if (world) {
        cacheWorldByExternalId(world);
      }

      return world;
    } finally {
      worldInFlight.delete(cacheKey);
    }
  })();

  worldInFlight.set(cacheKey, fetchPromise);
  evictExpired(worldCache, 200, CACHE_TTL_MS);

  return fetchPromise;
}

/**
 * Get cached world settings by raw server/guild ID (cross-agent).
 * This is the key optimization - settings are stored by raw serverId,
 * so if Agent A fetches settings for guild X, Agent B can reuse them.
 *
 * @param serverId - The raw server/guild ID (e.g., Discord guildId)
 * @returns Cached settings or null
 */
export function getCachedSettingsByServerId(serverId: string): WorldSettings | null {
  const key = `guild:${serverId}`;
  const cached = externalWorldCache.get(key);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS && cached.data?.settings) {
    return cached.data.settings;
  }
  return null;
}

/**
 * Check if a server/guild is known to have no settings (cross-agent negative cache).
 * Uses raw serverId so ALL agents share this knowledge.
 */
export function hasNoSettings(serverId: string): boolean {
  const cached = noSettingsCache.get(serverId);
  const now = Date.now();
  if (cached && now - cached.timestamp < NEGATIVE_CACHE_TTL_MS) {
    return cached.data;
  }
  return false;
}

/**
 * Mark a server/guild as having no settings.
 * Shared across all agents.
 */
export function markNoSettings(serverId: string): void {
  noSettingsCache.set(serverId, { data: true, timestamp: Date.now() });
}

/**
 * Invalidate the world cache for a specific world.
 */
export function invalidateWorldCache(worldId: UUID): void {
  worldCache.delete(worldId);
  noServerIdCache.delete(worldId);
}

/**
 * Invalidate world cache by raw server/guild ID.
 */
export function invalidateWorldCacheByServerId(serverId: string): void {
  externalWorldCache.delete(`guild:${serverId}`);
  noSettingsCache.delete(serverId);
}

// ============================================================================
// NO-SERVER-ID CACHE (negative caching for worlds without messageServerId)
// Keyed by agent-specific worldId (since we need to know the worldId to skip)
// ============================================================================

/**
 * Check if a world is known to have no server ID.
 */
export function hasNoServerId(worldId: UUID): boolean {
  const cached = noServerIdCache.get(worldId);
  const now = Date.now();
  if (cached && now - cached.timestamp < NEGATIVE_CACHE_TTL_MS) {
    return cached.data;
  }
  return false;
}

/**
 * Mark a world as having no server ID.
 */
export function markNoServerId(worldId: UUID): void {
  noServerIdCache.set(worldId, { data: true, timestamp: Date.now() });
}

// ============================================================================
// ENTITY CACHE FUNCTIONS
// ============================================================================

const entitiesCache = new Map<string, CacheEntry<import('@elizaos/core').Entity[]>>();
const entitiesInFlight = new Map<string, Promise<import('@elizaos/core').Entity[]>>();

/**
 * Get cached entities for a room or fetch from DB with promise coalescing.
 *
 * Unlike rooms/worlds, entities ARE agent-specific (different agents may see
 * different entity metadata), so we include agentId in the cache key.
 *
 * @param runtime - The agent runtime
 * @param roomId - The room UUID to fetch entities for
 * @returns Array of entities in the room
 */
export async function getCachedEntitiesForRoom(
  runtime: IAgentRuntime,
  roomId: UUID
): Promise<import('@elizaos/core').Entity[]> {
  ensureSweepTimer();
  // Keep agentId for entities - different agents may see different entity metadata
  const cacheKey = `${runtime.agentId}:${roomId}`;
  const cached = entitiesCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Check if there's already an in-flight request for this key
  const inFlight = entitiesInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Create new promise and store it BEFORE awaiting
  const fetchPromise = (async () => {
    try {
      const entities = await withTimeout(
        runtime.getEntitiesForRoom(roomId, true),
        DB_TIMEOUT_MS,
        []
      );
      entitiesCache.set(cacheKey, { data: entities, timestamp: Date.now() });
      return entities;
    } finally {
      entitiesInFlight.delete(cacheKey);
    }
  })();

  entitiesInFlight.set(cacheKey, fetchPromise);
  evictExpired(entitiesCache, 500, CACHE_TTL_MS);

  return fetchPromise;
}

/**
 * Invalidate entity cache for a specific agent and room.
 */
export function invalidateEntitiesCache(agentId: UUID, roomId: UUID): void {
  const cacheKey = `${agentId}:${roomId}`;
  entitiesCache.delete(cacheKey);
}

// ============================================================================
// WORLD SETTINGS CACHE (avoids redundant getWorld calls in getWorldSettings)
// ============================================================================

const worldSettingsCache = new Map<string, CacheEntry<WorldSettings | null>>();
const worldSettingsInFlight = new Map<string, Promise<WorldSettings | null>>();

/**
 * Extract settings from an already-fetched world.
 *
 * This avoids the redundant `runtime.getWorld()` call that `getWorldSettings`
 * would make. Use this when you already have the world from `getCachedWorld`.
 *
 * Also caches the settings by raw serverId for cross-agent benefit.
 *
 * @param world - The already-fetched world object
 * @returns The world settings or null
 */
export function extractWorldSettings(world: World | null): WorldSettings | null {
  if (!world) {
    return null;
  }

  // First check if we have cross-agent cached settings for this server
  if (world.messageServerId) {
    const cachedSettings = getCachedSettingsByServerId(world.messageServerId);
    if (cachedSettings) {
      return cachedSettings;
    }
  }

  if (!world.metadata?.settings) {
    // Mark as having no settings so other agents skip
    if (world.messageServerId) {
      markNoSettings(world.messageServerId);
    }
    return null;
  }

  // Get settings from metadata and remove salt
  const saltedSettings = world.metadata.settings as WorldSettings;
  const salt = getSalt();
  const settings = unsaltWorldSettings(saltedSettings, salt);

  // Cache by raw serverId for cross-agent benefit
  if (world.messageServerId && settings) {
    const key = `guild:${world.messageServerId}`;
    const externalData: ExternalWorldData = {
      name: world.name,
      messageServerId: world.messageServerId,
      metadata: world.metadata,
      settings,
    };
    externalWorldCache.set(key, { data: externalData, timestamp: Date.now() });
  }

  return settings;
}

/**
 * Get cached world settings for a serverId with promise coalescing.
 *
 * This is more efficient than calling `getWorldSettings` from core because:
 * 1. It shares the world cache with other providers
 * 2. It has promise coalescing to prevent thundering herd
 *
 * @param runtime - The agent runtime
 * @param serverId - The server ID to get settings for
 * @returns The world settings or null
 */
export async function getCachedWorldSettings(
  runtime: IAgentRuntime,
  serverId: string
): Promise<WorldSettings | null> {
  ensureSweepTimer();
  const cacheKey = `${runtime.agentId}:${serverId}`;
  const cached = worldSettingsCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const inFlight = worldSettingsInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    try {
      const worldId = createUniqueUuid(runtime, serverId);
      const world = await getCachedWorld(runtime, worldId);
      const settings = extractWorldSettings(world);
      worldSettingsCache.set(cacheKey, { data: settings, timestamp: Date.now() });
      return settings;
    } finally {
      worldSettingsInFlight.delete(cacheKey);
    }
  })();

  worldSettingsInFlight.set(cacheKey, fetchPromise);
  evictExpired(worldSettingsCache, 200, CACHE_TTL_MS);

  return fetchPromise;
}

// ============================================================================
// CACHE STATS (for debugging)
// ============================================================================

export function getCacheStats(): {
  // Agent-specific caches
  rooms: number;
  roomsInFlight: number;
  worlds: number;
  worldsInFlight: number;
  entities: number;
  entitiesInFlight: number;
  worldSettings: number;
  worldSettingsInFlight: number;
  // Cross-agent caches (by external IDs)
  externalRooms: number;
  externalWorlds: number;
  externalWorldsInFlight: number;
  // Negative caches
  noServerIds: number;
  noSettings: number;
} {
  return {
    // Agent-specific
    rooms: roomCache.size,
    roomsInFlight: roomInFlight.size,
    worlds: worldCache.size,
    worldsInFlight: worldInFlight.size,
    entities: entitiesCache.size,
    entitiesInFlight: entitiesInFlight.size,
    worldSettings: worldSettingsCache.size,
    worldSettingsInFlight: worldSettingsInFlight.size,
    // Cross-agent
    externalRooms: externalRoomCache.size,
    externalWorlds: externalWorldCache.size,
    externalWorldsInFlight: externalWorldInFlight.size,
    // Negative
    noServerIds: noServerIdCache.size,
    noSettings: noSettingsCache.size,
  };
}
