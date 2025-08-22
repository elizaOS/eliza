import { stringToUuid } from './index';
import { logger } from './logger';
import { composePrompt, parseKeyValueXml } from './utils';
import {
  type Entity,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Relationship,
  type State,
  type UUID,
} from './types';

/**
 * Template for resolving entity name within a conversation context.
 *
 * @type {string}
 */
/**
 * Entity Resolution Template for resolving entity names based on context and recent messages.
 *
 * Contains placeholders for message sender, agent, entities in the room, and recent messages.
 * Provides instructions for analyzing the context and resolving entity references.
 *
 * @return {string} entityResolutionTemplate - The template for resolving entity names with detailed instructions.
 */
const entityResolutionTemplate = `# Task: Resolve Entity Name
Message Sender: {{senderName}} (ID: {{senderId}})
Agent: {{agentName}} (ID: {{agentId}})

# Entities in Room:
{{#if entitiesInRoom}}
{{entitiesInRoom}}
{{/if}}

{{recentMessages}}

# Instructions:
1. Analyze the context to identify which entity is being referenced
2. Consider special references like "me" (the message sender) or "you" (agent the message is directed to)
3. Look for usernames/handles in standard formats (e.g. @username, user#1234)
4. Consider context from recent messages for pronouns and references
5. If multiple matches exist, use context to disambiguate
6. Consider recent interactions and relationship strength when resolving ambiguity

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with:
<response>
  <entityId>exact-id-if-known-otherwise-null</entityId>
  <type>EXACT_MATCH | USERNAME_MATCH | NAME_MATCH | RELATIONSHIP_MATCH | AMBIGUOUS | UNKNOWN</type>
  <matches>
    <match>
      <name>matched-name</name>
      <reason>why this entity matches</reason>
    </match>
  </matches>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

/**
 * Get recent interactions between a source entity and candidate entities in a specific room.
 *
 * @param {IAgentRuntime} runtime - The runtime context for the agent.
 * @param {UUID} sourceEntityId - The ID of the source entity initiating interactions.
 * @param {Entity[]} candidateEntities - The list of candidate entities to evaluate interactions with.
 * @param {UUID} roomId - The ID of the room where interactions are taking place.
 * @param {Relationship[]} relationships - The relationships between the entities involved.
 * @returns {Promise<{ entity: Entity; interactions: Memory[]; count: number }[]>} - An array of objects containing the entity, recent interactions, and interaction count.
 */
async function getRecentInteractions(
  runtime: IAgentRuntime,
  sourceEntityId: UUID,
  candidateEntities: Entity[],
  roomId: UUID,
  relationships: Relationship[]
): Promise<{ entity: Entity; interactions: Memory[]; count: number }[]> {
  const results = [];

  // Get recent messages from the room - just for context
  const recentMessages = await runtime.getMemories({
    tableName: 'messages',
    roomId,
    count: 20, // Reduced from 100 since we only need context
  });

  for (const entity of candidateEntities) {
    const interactions: Memory[] = [];
    let interactionScore = 0;

    // First get direct replies using inReplyTo
    const directReplies = recentMessages.filter(
      (msg) =>
        (msg.entityId === sourceEntityId && msg.content.inReplyTo === entity.id) ||
        (msg.entityId === entity.id && msg.content.inReplyTo === sourceEntityId)
    );

    interactions.push(...directReplies);

    // Get relationship strength from metadata
    const relationship = relationships.find(
      (rel) =>
        (rel.sourceEntityId === sourceEntityId && rel.targetEntityId === entity.id) ||
        (rel.targetEntityId === sourceEntityId && rel.sourceEntityId === entity.id)
    );

    if (relationship?.metadata?.interactions) {
      interactionScore = relationship.metadata.interactions as number;
    }

    // Add bonus points for recent direct replies
    interactionScore += directReplies.length;

    // Keep last few messages for context
    const uniqueInteractions = [...new Set(interactions)];
    results.push({
      entity,
      interactions: uniqueInteractions.slice(-5), // Only keep last 5 messages for context
      count: Math.round(interactionScore),
    });
  }

  // Sort by interaction score descending
  return results.sort((a, b) => b.count - a.count);
}

/**
 * Finds an entity by name in the given runtime environment.
 *
 * @param {IAgentRuntime} runtime - The agent runtime environment.
 * @param {Memory} message - The memory message containing relevant information.
 * @param {State} state - The current state of the system.
 * @returns {Promise<Entity | null>} A promise that resolves to the found entity or null if not found.
 */
export async function findEntityByName(
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<Entity | null> {
  const room = state.data.room ?? (await runtime.getRoom(message.roomId));
  if (!room) {
    logger.warn('Room not found for entity search');
    return null;
  }

  const world = room.worldId ? await runtime.getWorld(room.worldId) : null;

  // Get all entities in the room with their components
  const entitiesInRoom = await runtime.getEntitiesForRoom(room.id, true);

  // Filter components for each entity based on permissions
  const filteredEntities = await Promise.all(
    entitiesInRoom.map(async (entity) => {
      if (!entity.components) return entity;

      // Get world roles if we have a world
      const worldRoles = world?.metadata?.roles || {};

      // Filter components based on permissions
      entity.components = entity.components.filter((component) => {
        // 1. Pass if sourceEntityId matches the requesting entity
        if (component.sourceEntityId === message.entityId) return true;

        // 2. Pass if sourceEntityId is an owner/admin of the current world
        if (world && component.sourceEntityId) {
          const sourceRole = worldRoles[component.sourceEntityId];
          if (sourceRole === 'OWNER' || sourceRole === 'ADMIN') return true;
        }

        // 3. Pass if sourceEntityId is the agentId
        if (component.sourceEntityId === runtime.agentId) return true;

        // Filter out components that don't meet any criteria
        return false;
      });

      return entity;
    })
  );

  // Get relationships for the message sender
  const relationships = await runtime.getRelationships({
    entityId: message.entityId,
  });

  // Get entities from relationships
  const relationshipEntities = await Promise.all(
    relationships.map(async (rel) => {
      const entityId =
        rel.sourceEntityId === message.entityId ? rel.targetEntityId : rel.sourceEntityId;
      return runtime.getEntityById(entityId);
    })
  );

  // Filter out nulls and combine with room entities
  const allEntities = [
    ...filteredEntities,
    ...relationshipEntities.filter((e): e is Entity => e !== null),
  ];

  // Get interaction strength data for relationship entities
  const interactionData = await getRecentInteractions(
    runtime,
    message.entityId,
    allEntities,
    room.id,
    relationships
  );

  // Compose context for LLM
  const prompt = composePrompt({
    state: {
      roomName: room.name || room.id,
      worldName: world?.name || 'Unknown',
      entitiesInRoom: JSON.stringify(filteredEntities, null, 2),
      entityId: message.entityId,
      senderId: message.entityId,
    },
    template: entityResolutionTemplate,
  });

  // Use LLM to analyze and resolve the entity
  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  // Parse LLM response
  const resolution = parseKeyValueXml(result);
  if (!resolution) {
    logger.warn('Failed to parse entity resolution result');
    return null;
  }

  // If we got an exact entity ID match
  if (resolution.type === 'EXACT_MATCH' && resolution.entityId) {
    const entity = await runtime.getEntityById(resolution.entityId as UUID);
    if (entity) {
      // Filter components again for the returned entity
      if (entity.components) {
        const worldRoles = world?.metadata?.roles || {};
        entity.components = entity.components.filter((component) => {
          if (component.sourceEntityId === message.entityId) return true;
          if (world && component.sourceEntityId) {
            const sourceRole = worldRoles[component.sourceEntityId];
            if (sourceRole === 'OWNER' || sourceRole === 'ADMIN') return true;
          }
          if (component.sourceEntityId === runtime.agentId) return true;
          return false;
        });
      }
      return entity;
    }
  }

  // For username/name/relationship matches, search through all entities
  // Handle matches - parseKeyValueXml returns nested structures differently
  let matchesArray: any[] = [];
  if (resolution.matches?.match) {
    // Normalize to array
    matchesArray = Array.isArray(resolution.matches.match)
      ? resolution.matches.match
      : [resolution.matches.match];
  }

  if (matchesArray.length > 0 && matchesArray[0]?.name) {
    const matchName = matchesArray[0].name.toLowerCase();

    // Find matching entity by username/handle in components or by name
    const matchingEntity = allEntities.find((entity) => {
      // Check names
      if (entity.names.some((n) => n.toLowerCase() === matchName)) return true;

      // Check components for username/handle match
      return entity.components?.some(
        (c) =>
          (c.data.username as string)?.toLowerCase() === matchName ||
          (c.data.handle as string)?.toLowerCase() === matchName
      );
    });

    if (matchingEntity) {
      // If this is a relationship match, sort by interaction strength
      if (resolution.type === 'RELATIONSHIP_MATCH') {
        const interactionInfo = interactionData.find((d) => d.entity.id === matchingEntity.id);
        if (interactionInfo && interactionInfo.count > 0) {
          return matchingEntity;
        }
      } else {
        return matchingEntity;
      }
    }
  }

  return null;
}

/**
 * Function to create a unique UUID based on the runtime and base user ID.
 *
 * @param {RuntimeContext} runtime - The runtime context object.
 * @param {UUID|string} baseUserId - The base user ID to use in generating the UUID.
 * @returns {UUID} - The unique UUID generated based on the runtime and base user ID.
 */
export const createUniqueUuid = (runtime, baseUserId: UUID | string): UUID => {
  // If the base user ID is the agent ID, return it directly
  if (baseUserId === runtime.agentId) {
    return runtime.agentId;
  }

  // Use a deterministic approach to generate a new UUID based on both IDs
  // This creates a unique ID for each user+agent combination while still being deterministic
  const combinedString = `${baseUserId}:${runtime.agentId}`;

  // Create a namespace UUID (version 5) from the combined string
  return stringToUuid(combinedString);
};

/**
 * Get details for a list of entities.
 */
/**
 * Retrieves entity details for a specific room from the database.
 *
 * @param {Object} params - The input parameters
 * @param {IAgentRuntime} params.runtime - The Agent Runtime instance
 * @param {UUID} params.roomId - The ID of the room to retrieve entity details for
 * @returns {Promise<Array>} - A promise that resolves to an array of unique entity details
 */
export async function getEntityDetails({
  runtime,
  roomId,
}: {
  runtime: IAgentRuntime;
  roomId: UUID;
}) {
  // Parallelize the two async operations
  const [room, roomEntities] = await Promise.all([
    runtime.getRoom(roomId),
    runtime.getEntitiesForRoom(roomId, true),
  ]);

  // Use a Map for uniqueness checking while processing entities
  const uniqueEntities = new Map();

  // Process entities in a single pass
  for (const entity of roomEntities) {
    if (uniqueEntities.has(entity.id)) continue;

    // Merge component data more efficiently
    const allData = {};
    for (const component of entity.components || []) {
      Object.assign(allData, component.data);
    }

    // Process merged data
    const mergedData = {};
    for (const [key, value] of Object.entries(allData)) {
      if (!mergedData[key]) {
        mergedData[key] = value;
        continue;
      }

      if (Array.isArray(mergedData[key]) && Array.isArray(value)) {
        // Use Set for deduplication in arrays
        mergedData[key] = [...new Set([...mergedData[key], ...value])];
      } else if (typeof mergedData[key] === 'object' && typeof value === 'object') {
        mergedData[key] = { ...mergedData[key], ...value };
      }
    }

    // Create the entity details
    uniqueEntities.set(entity.id, {
      id: entity.id,
      name: room?.source
        ? (entity.metadata[room.source] as { name?: string })?.name || entity.names[0]
        : entity.names[0],
      names: entity.names,
      data: JSON.stringify({ ...mergedData, ...entity.metadata }),
    });
  }

  return Array.from(uniqueEntities.values());
}

/**
 * Format entities into a string
 * @param entities - list of entities
 * @returns string
 */
/**
 * Format the given entities into a string representation.
 *
 * @param {Object} options - The options object.
 * @param {Entity[]} options.entities - The list of entities to format.
 * @returns {string} A formatted string representing the entities.
 */
export function formatEntities({ entities }: { entities: Entity[] }) {
  const entityStrings = entities.map((entity: Entity) => {
    const header = `"${entity.names.join('" aka "')}"\nID: ${entity.id}${entity.metadata && Object.keys(entity.metadata).length > 0 ? `\nData: ${JSON.stringify(entity.metadata)}\n` : '\n'}`;
    return header;
  });
  return entityStrings.join('\n');
}
