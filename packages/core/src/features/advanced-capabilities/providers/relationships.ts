/**
 * RELATIONSHIPS provider: injects the people the current speaker interacts with
 * into the prompt context, sorted by interaction strength. Resolves the
 * speaker's related-entity cluster, loads their relationship edges, keeps the
 * strongest 30, and formats each counterpart as names + tags + a bounded slice
 * of that entity's metadata. Output is hard-capped both per entity and in total
 * because raw entity metadata can accumulate arbitrarily large blobs and would
 * otherwise push the planner prompt past small-context model limits.
 */
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { getRelatedEntityIds } from "../../../identity-clusters.ts";
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

// Output bounds. Entity metadata is internal bookkeeping that can accumulate
// arbitrarily large blobs (JSON state, embeddings-adjacent fields, history).
// Dumping it verbatim for up to 30 relationships ballooned this provider to
// 80k+ chars on busy agents, blowing the planner prompt past small-context
// models' limits (e.g. Cerebras gpt-oss-120b's 131k ceiling). The useful
// relationship signal is names + tags + interaction strength, not the raw
// metadata, so cap metadata per entity and cap the provider's total output.
const MAX_METADATA_CHARS_PER_ENTITY = 240;
const MAX_RELATIONSHIPS_OUTPUT_CHARS = 4000;

/**
 * Sorts relationships by interaction strength, resolves each counterpart entity
 * relative to the speaker's own ids, and renders the bounded names/tags/metadata
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
		)
		.slice(0, 30); // Get top 30

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
		let used = 0;
		for (const [key, value] of Object.entries(metadata)) {
			let line: string;
			if (value && typeof value === "object") {
				try {
					line = JSON.stringify({ [key]: value });
				} catch {
					line = `${key}: ${String(value)}`;
				}
			} else {
				line = `${key}: ${String(value)}`;
			}
			// Bound per entity: skip once the cap is reached so a single
			// metadata-heavy entity can't dominate the provider output.
			if (used + line.length > MAX_METADATA_CHARS_PER_ENTITY) {
				if (used < MAX_METADATA_CHARS_PER_ENTITY) {
					lines.push(line.slice(0, MAX_METADATA_CHARS_PER_ENTITY - used));
				}
				break;
			}
			lines.push(line);
			used += line.length + 1;
		}
		return lines.join("\n");
	};

	// Format relationships using the entity map
	const formattedRelationships: string[] = [];
	let totalChars = 0;
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
		// Bound total output: stop once the cap is reached so a busy agent's
		// relationship graph can't dominate the planner prompt. Relationships
		// are already sorted by interaction strength, so the kept ones are the
		// most relevant. Always keep at least the first (strongest) block so a
		// single oversized entry never collapses output to "No relationships
		// found."
		if (
			formattedRelationships.length > 0 &&
			totalChars + block.length > MAX_RELATIONSHIPS_OUTPUT_CHARS
		) {
			break;
		}
		formattedRelationships.push(block);
		totalChars += block.length + 1;
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
