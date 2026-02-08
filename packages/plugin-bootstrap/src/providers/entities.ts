import type { Entity, IAgentRuntime, Memory, Provider, State, UUID } from '@elizaos/core';
import { addHeader, formatEntities } from '@elizaos/core';
import {
  getCachedRoom,
  getCachedEntitiesForRoom,
} from './shared-cache';

/**
 * Build entity details from room entities (optimized version that accepts pre-fetched room).
 * Avoids duplicate getRoom call if room is already in state.
 *
 * WHY THIS OPTIMIZATION:
 * - Other providers (ROLES, WORLD) often fetch room before ENTITIES provider runs
 * - Accepting pre-fetched room avoids redundant getRoom() database call
 * - Cached entities come from shared-cache, preventing duplicate queries
 * - Component merging is expensive - do it once and cache the result
 */
const getEntityDetailsOptimized = async (
  runtime: IAgentRuntime,
  roomId: UUID,
  room: { source?: string } | null,
  cachedEntities?: Entity[]
): Promise<Entity[]> => {
  // Use cached entities if provided, otherwise fetch with caching
  // WHY: Entities provider might be called multiple times in one message cycle
  const roomEntities = cachedEntities ?? (await getCachedEntitiesForRoom(runtime, roomId));

  // Use a Map for uniqueness checking while processing entities
  // WHY: O(1) has() check vs O(n) find() - critical for large rooms (100+ entities)
  const uniqueEntities = new Map<UUID, Entity>();

  for (const entity of roomEntities) {
    if (!entity.id || uniqueEntities.has(entity.id)) continue;

    // Merge component data efficiently
    const allData: Record<string, unknown> = {};
    for (const component of entity.components || []) {
      Object.assign(allData, component.data);
    }

    // Process merged data
    const mergedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(allData)) {
      if (!mergedData[key]) {
        mergedData[key] = value;
        continue;
      }

      if (Array.isArray(mergedData[key]) && Array.isArray(value)) {
        mergedData[key] = [...new Set([...(mergedData[key] as unknown[]), ...value])];
      } else if (typeof mergedData[key] === 'object' && typeof value === 'object') {
        mergedData[key] = { ...(mergedData[key] as object), ...(value as object) };
      }
    }

    uniqueEntities.set(entity.id, {
      id: entity.id,
      agentId: entity.agentId,
      name: room?.source
        ? (entity.metadata[room.source] as { name?: string })?.name || entity.names[0]
        : entity.names[0],
      names: entity.names,
      metadata: { ...mergedData, ...entity.metadata },
    } as Entity);
  }

  return Array.from(uniqueEntities.values());
};

/**
 * Provider for fetching entities related to the current conversation.
 * @type { Provider }
 */
export const entitiesProvider: Provider = {
  name: 'ENTITIES',
  description: 'People in the current conversation',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const { roomId, entityId } = message;

    // Early validation
    if (!roomId) {
      return { data: {}, values: { entities: '', senderName: '' }, text: '' };
    }

    // Use cached room (in-memory cache with TTL) - avoids DB call for repeated messages
    const room = await getCachedRoom(runtime, roomId);

    // Get cached entities for room
    const cachedEntities = await getCachedEntitiesForRoom(runtime, roomId);

    // Get entities details using cached data
    const entitiesData = await getEntityDetailsOptimized(runtime, roomId, room, cachedEntities);

    // Build entity map for O(1) lookup
    // WHY: Need to find sender name from entityId. find() would be O(n), Map is O(1)
    // Impact: 1000 entities = 1000 comparisons vs 1 lookup (1000x faster)
    const entityMap = new Map<UUID, Entity>();
    for (const entity of entitiesData) {
      if (entity.id) {
        entityMap.set(entity.id, entity);
      }
    }

    // Find sender name using map lookup (O(1) instead of O(n))
    const senderName = entityMap.get(entityId)?.names[0];

    // Format entities for display
    // WHY: ?? [] ensures we never pass null/undefined to formatEntities (defense in depth)
    const formattedEntities = formatEntities({ entities: entitiesData ?? [] });

    // Create formatted text with header
    const entities =
      formattedEntities && formattedEntities.length > 0
        ? addHeader('# People in the Room', formattedEntities)
        : '';

    const data = {
      entitiesData,
      senderName,
      room, // Include room in data for downstream providers
    };

    const values = {
      entities,
      senderName,
    };

    return {
      data,
      values,
      text: entities,
    };
  },
};
