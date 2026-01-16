import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  Entity,
  IAgentRuntime,
  Memory,
  Metadata,
  Provider,
  Relationship,
  UUID,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("RELATIONSHIPS");

/**
 * Formats the provided relationships based on interaction strength and returns a string.
 * @param {IAgentRuntime} runtime - The runtime object to interact with the agent.
 * @param {Relationship[]} relationships - The relationships to format.
 * @returns {string} The formatted relationships as a string.
 */
/**
 * Asynchronously formats relationships based on their interaction strength.
 *
 * @param {IAgentRuntime} runtime The runtime instance.
 * @param {Relationship[]} relationships The relationships to be formatted.
 * @returns {Promise<string>} A formatted string of the relationships.
 */
async function formatRelationships(
  runtime: IAgentRuntime,
  relationships: Relationship[],
) {
  // Sort relationships by interaction strength (descending)
  const sortedRelationships = relationships
    .filter((rel) => rel.metadata?.interactions)
    .sort(
      (a, b) =>
        ((b.metadata && (b.metadata.interactions as number | undefined)) || 0) -
        ((a.metadata && (a.metadata.interactions as number | undefined)) || 0),
    )
    .slice(0, 30); // Get top 30

  if (sortedRelationships.length === 0) {
    return "";
  }

  // Deduplicate target entity IDs to avoid redundant fetches
  const uniqueEntityIds = Array.from(
    new Set(sortedRelationships.map((rel) => rel.targetEntityId as UUID)),
  );

  // Fetch all required entities in a single batch operation
  const entities = await Promise.all(
    uniqueEntityIds.map((id) => runtime.getEntityById(id)),
  );

  // Create a lookup map for efficient access
  const entityMap = new Map<string, Entity | null>();
  entities.forEach((entity, index) => {
    if (entity) {
      entityMap.set(uniqueEntityIds[index], entity);
    }
  });

  const formatMetadata = (metadata?: Metadata) => {
    if (!metadata) return "";
    const lines: string[] = [];
    for (const [key, value] of Object.entries(metadata)) {
      if (value && typeof value === "object") {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${key}: ${String(value)}`);
      }
    }
    return lines.join("\n");
  };

  // Format relationships using the entity map
  const formattedRelationships: string[] = [];
  for (const rel of sortedRelationships) {
    const targetEntityId = rel.targetEntityId as UUID;
    const entity = entityMap.get(targetEntityId);
    if (!entity) continue;

    const names = entity.names.join(" aka ");
    const tags = rel.tags ? rel.tags.join(", ") : "";
    const metadata = formatMetadata(entity.metadata);
    const parts = [names, tags, metadata].filter((part) => part.length > 0);
    formattedRelationships.push(`${parts.join("\n")}\n`);
  }

  return formattedRelationships.join("\n");
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
  name: spec.name,
  description: spec.description,
  dynamic: spec.dynamic ?? true,
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
          relationships: "No relationships found.",
        },
        text: "No relationships found.",
      };
    }

    const formattedRelationships = await formatRelationships(
      runtime,
      relationships,
    );

    if (!formattedRelationships) {
      return {
        data: {
          relationships: [],
        },
        values: {
          relationships: "No relationships found.",
        },
        text: "No relationships found.",
      };
    }
    return {
      data: {
        relationships: formattedRelationships,
      },
      values: {
        relationships: formattedRelationships,
      },
      text: `# ${runtime.character.name} has observed ${message.content.senderName || message.content.name} interacting with these people:\n${formattedRelationships}`,
    };
  },
};

export { relationshipsProvider };
