import type { Entity, IAgentRuntime, Memory, Provider, State, UUID } from '@elizaos/core';
import { addHeader, formatEntities, processEntitiesForRoom } from '@elizaos/core';
import { getCachedRoom, getCachedEntitiesForRoom } from './shared-cache';

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

    // Get entities details using core's shared processor over cached data
    const entitiesData = processEntitiesForRoom(cachedEntities, room?.source);

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
