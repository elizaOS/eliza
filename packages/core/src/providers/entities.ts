import { getEntityDetails } from "../entities";
import { addHeader } from "../prompts";
import type { Entity, IAgentRuntime, Memory, Provider } from "../types";

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
function formatEntities({ entities }: { entities: Entity[] }) {
	const entityStrings = entities.map((entity: Entity) => {
		const header = `${entity.names.join(" aka ")}\nID: ${entity.id}${entity.metadata && Object.keys(entity.metadata).length > 0 ? `\nData: ${JSON.stringify(entity.metadata)}\n` : "\n"}`;
		return header;
	});
	return entityStrings.join("\n");
}

export const entitiesProvider: Provider = {
	name: "ENTITIES",
	description: "Entities in the current conversation",
	get: async (runtime: IAgentRuntime, message: Memory) => {
		const { roomId, entityId } = message;
		// Get entities details
		const entitiesData = await getEntityDetails({ runtime, roomId });
		// Format entities for display
		const formattedEntities = formatEntities({ entities: entitiesData ?? [] });
		// Find sender name
		const senderName = entitiesData?.find(
			(entity: Entity) => entity.id === entityId,
		)?.names[0];
		// Create formatted text with header
		const entities =
			formattedEntities && formattedEntities.length > 0
				? addHeader("# People in the Room", formattedEntities)
				: "";
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
