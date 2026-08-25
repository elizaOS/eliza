/**
 * RELATIONSHIPS provider: injects the people the current speaker interacts with
 * into the prompt context, sorted by interaction strength. Resolves the
 * speaker's related-entity cluster, loads every relationship edge, and formats
 * every counterpart with its complete names, tags, and metadata.
 */
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { getRelatedEntityIds } from "../../../identity-clusters.ts";
import { stringifyForDiagnostics } from "../../../runtime/json-output.ts";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Metadata,
	Provider,
	Relationship,
	UUID,
} from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("RELATIONSHIPS");

/**
 * Sorts relationships by interaction strength, resolves each counterpart entity
 * relative to the speaker's own ids, and renders the complete names/tags/metadata
 * block. `currentEntityIds` are the speaker's clustered ids, used to pick which
 * side of each edge is the counterpart.
 */
async function formatRelationships(
	runtime: IAgentRuntime,
	relationships: Relationship[],
	currentEntityIds: UUID[],
) {
	const currentEntityIdSet = new Set(currentEntityIds);
	// Sort relationships by interaction strength (descending)
	const sortedRelationships = relationships
		.filter((rel) => rel.metadata?.interactions)
		.sort(
			(a, b) =>
				((b.metadata && (b.metadata.interactions as number | undefined)) || 0) -
				((a.metadata && (a.metadata.interactions as number | undefined)) || 0),
		);

	if (sortedRelationships.length === 0) {
		return "";
	}

	// Deduplicate target entity IDs to avoid redundant fetches
	const uniqueEntityIds = Array.from(
		new Set(
			sortedRelationships
				.map((rel) => {
					if (currentEntityIdSet.has(rel.sourceEntityId)) {
						return rel.targetEntityId as UUID;
					}
					if (currentEntityIdSet.has(rel.targetEntityId)) {
						return rel.sourceEntityId as UUID;
					}
					return null;
				})
				.filter((id): id is UUID => Boolean(id)),
		),
	);

	// Relationship fan-out can contain dozens of counterparts. One adapter
	// query keeps provider latency constant instead of paying one SQL round-trip
	// per entity.
	const entities =
		uniqueEntityIds.length > 0
			? await runtime.getEntitiesByIds(uniqueEntityIds)
			: [];

	// Create a lookup map for efficient access
	const entityMap = new Map<string, Entity>(
		entities.flatMap((entity) =>
			entity.id === undefined ? [] : [[entity.id, entity] as const],
		),
	);

	const formatMetadata = (metadata?: Metadata) => {
		if (!metadata) return "";
		const lines: string[] = [];
		for (const [key, value] of Object.entries(metadata)) {
			const line =
				value && typeof value === "object"
					? stringifyForDiagnostics({ [key]: value })
					: `${key}: ${String(value)}`;
			lines.push(line);
		}
		return lines.join("\n");
	};

	// Format relationships using the entity map
	const formattedRelationships: string[] = [];
	for (const rel of sortedRelationships) {
		const counterpartEntityId = currentEntityIdSet.has(rel.sourceEntityId)
			? (rel.targetEntityId as UUID)
			: currentEntityIdSet.has(rel.targetEntityId)
				? (rel.sourceEntityId as UUID)
				: null;
		if (!counterpartEntityId) continue;
		const entity = entityMap.get(counterpartEntityId);
		if (!entity) continue;

		const names = entity.names.join(" aka ");
		const tags = rel.tags ? rel.tags.join(", ") : "";
		const metadata = formatMetadata(entity.metadata);
		const parts = [names, tags, metadata].filter((part) => part.length > 0);
		const block = `${parts.join("\n")}\n`;
		formattedRelationships.push(block);
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
	contexts: ["contacts", "memory"],
	contextGate: { anyOf: ["contacts", "memory"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory) => {
		const relatedEntityIds = await getRelatedEntityIds(
			runtime,
			message.entityId,
		);
		// Get all relationships for the current user
		const relationships = await runtime.getRelationships({
			entityIds: relatedEntityIds,
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
			relatedEntityIds,
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
