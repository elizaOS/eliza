import type { Entity, IAgentRuntime, Memory, Provider } from '@elizaos/core';
import { addHeader, formatEntities, getEntityDetails } from '@elizaos/core';

/**
 * Provider for fetching entities related to the current conversation.
 * @type { Provider }
 */
export const entitiesProvider: Provider = {
  name: 'ENTITIES',
  description: 'People in the current conversation',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const { roomId, entityId } = message;
    // Get entities details
    const entitiesData = await getEntityDetails({ runtime, roomId });
    // Format entities for display
    const formattedEntities = formatEntities({ entities: entitiesData ?? [] });
    // Find sender name
    const senderName = entitiesData?.find((entity: Entity) => entity.id === entityId)?.names[0];
    // Create formatted text with header
    const entities =
      formattedEntities && formattedEntities.length > 0
        ? addHeader('# People in the Room', formattedEntities)
        : '';
    const data = {
      entitiesData,
      senderName,
    };

    const values = {
      entities,
    };

    return {
      data,
      values,
      text: entities,
    };
  },
};
