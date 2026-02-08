import type { Entity, IAgentRuntime, Memory, Provider, Relationship, UUID } from '@elizaos/core';

/**
 * Escape a value for CSV output.
 * Wraps in quotes if contains comma, quote, or newline.
 */
function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats relationships as CSV for token efficiency.
 * Format: name,interactions,tags
 *
 * @param runtime - The runtime instance
 * @param relationships - The relationships to format
 * @returns CSV formatted string
 */
async function formatRelationships(runtime: IAgentRuntime, relationships: Relationship[]) {
  // Sort relationships by interaction strength (descending)
  const sortedRelationships = relationships
    .filter((rel) => rel.metadata?.interactions)
    .sort(
      (a, b) =>
        ((b.metadata?.interactions as number | undefined) || 0) -
        ((a.metadata?.interactions as number | undefined) || 0)
    )
    .slice(0, 30); // Get top 30

  if (sortedRelationships.length === 0) {
    return '';
  }

  // Deduplicate target entity IDs to avoid redundant fetches
  const uniqueEntityIds = Array.from(
    new Set(sortedRelationships.map((rel) => rel.targetEntityId as UUID))
  );

  // Fetch all required entities in a single batch operation
  const entities = await Promise.all(uniqueEntityIds.map((id) => runtime.getEntityById(id)));

  // Create a lookup map for efficient access
  const entityMap = new Map<string, Entity | null>();
  entities.forEach((entity, index) => {
    if (entity) {
      entityMap.set(uniqueEntityIds[index], entity);
    }
  });

  // CSV header
  const rows: string[] = ['name,interactions,tags'];

  // Format relationships as CSV rows
  for (const rel of sortedRelationships) {
    const targetEntityId = rel.targetEntityId as UUID;
    const entity = entityMap.get(targetEntityId);

    if (!entity) continue;

    const name = entity.names[0] || 'Unknown';
    const interactions = (rel.metadata?.interactions as number) || 0;
    const tags = rel.tags?.join(';') || '';

    rows.push(`${csvEscape(name)},${interactions},${csvEscape(tags)}`);
  }

  return rows.join('\n');
}

/**
 * Provider for fetching relationships data.
 *
 * @type {Provider}
 * @property {string} name - The name of the provider ("RELATIONSHIPS").
 * @property {string} description - Description of the provider.
 * @property {Function} get - Asynchronous function to fetch relationships data.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {Memory} message - The message object containing entity ID.
 * @returns {Promise<Object>} Object containing relationships data or error message.
 */
const relationshipsProvider: Provider = {
  name: 'RELATIONSHIPS',
  description:
    'Relationships between {{agentName}} and other people, or between other people that {{agentName}} has observed interacting with',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    // Get all relationships for the current user
    const relationships = await runtime.getRelationships({
      entityId: message.entityId,
    });

    if (!relationships || relationships.length === 0) {
      return {
        data: {
          relationships: [],
        },
        values: {
          relationships: 'No relationships found.',
        },
        text: 'No relationships found.',
      };
    }

    const formattedRelationships = await formatRelationships(runtime, relationships);

    if (!formattedRelationships) {
      return {
        data: {
          relationships: [],
        },
        values: {
          relationships: 'No relationships found.',
        },
        text: 'No relationships found.',
      };
    }

    const senderName = message.content.senderName || message.content.name || 'user';
    const header = `# Relationships (${relationships.length}) - ${senderName}'s connections`;

    return {
      data: {
        relationships: formattedRelationships,
      },
      values: {
        relationships: formattedRelationships,
      },
      text: `${header}\n${formattedRelationships}`,
    };
  },
};

export { relationshipsProvider };
