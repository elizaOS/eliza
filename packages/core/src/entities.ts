/**
 * Entity resolution, identity formatting, and component-visibility trust for the
 * agent runtime. `findEntityByName` maps a natural-language reference onto a
 * known `Entity`. The referent (`message.content.text`), sender, agent, room
 * members, related contacts, and recent messages are bound into the TEXT_SMALL
 * prompt; EXACT_MATCH is restricted to that candidate set. A unique exact
 * name/handle hit returns without a model call. Component filtering copies the
 * entity and keeps the target's own identity components.
 * `getEntityDetails` and `formatEntities` merge and render a room's entities for
 * prompt context; `createUniqueUuid` derives a stable per-agent UUID from a base
 * id.
 *
 * `resolveTrustedComponentSourceIds` gates which entity components are visible:
 * a component's data is trusted only when its source is the message sender, the
 * entity the component belongs to, the agent itself, or a source whose RESOLVED
 * role (see roles.ts) is ADMIN-or-higher — never a raw stored role grant. Sits
 * on the runtime boundary (getRoom / getWorld / getEntitiesForRoom /
 * getRelationships / useModel) and imports roles.ts lazily to avoid a cycle with
 * createUniqueUuid. Nested LLM `{ match: … }` unwraps are bounded in
 * `entity-matches.ts`.
 */
import {
	type EntityMatch,
	normalizeEntityMatches,
	readEntityResolutionField,
} from "./entity-matches";
import { logger } from "./logger";
// Type-only (erased at runtime, so no cycle with roles.ts, which imports
// createUniqueUuid from this module). The role-resolution values are pulled via a
// dynamic import at call time in resolveTrustedComponentSourceIds.
import type { RolesWorldMetadata } from "./roles";
import { memoizeTurnWork } from "./trajectory-context.ts";
import {
	type Entity,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type Relationship,
	type State,
	type UUID,
	type World,
} from "./types";
import * as utils from "./utils";
import { stableStringify } from "./utils/deterministic";

type EntityDetailsRecord = Pick<
	Entity,
	"id" | "agentId" | "names" | "metadata"
> & {
	name?: string;
	data: string;
};

/**
 * Component-visibility filtering decides trust from each source entity's
 * RESOLVED effective role, not the raw `world.metadata.roles[sourceEntityId]`
 * literal. `resolveEntityRole` demotes a stored OWNER grant to GUEST under a
 * configured canonical owner and honors connector-admin revocation, so keying
 * off the literal would keep a stale OWNER grant trusted and leak another
 * entity's components. Because `resolveEntityRole` is async, each source
 * entity's role is batch-resolved once before the synchronous component filter;
 * only resolved ADMIN-or-higher is trusted. Returns the set of source entity ids
 * whose components are trusted for this world. (#12087 Item 16)
 */
export async function resolveTrustedComponentSourceIds(
	runtime: IAgentRuntime,
	world: World | null,
	components: NonNullable<Entity["components"]>,
): Promise<Set<string>> {
	const trusted = new Set<string>();
	if (!world) return trusted;

	const sourceIds = new Set<string>();
	for (const component of components) {
		if (component.sourceEntityId) {
			sourceIds.add(component.sourceEntityId);
		}
	}
	if (sourceIds.size === 0) return trusted;

	const { resolveEntityRole, isAdminRank } = await import("./roles");
	const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
	await Promise.all(
		[...sourceIds].map(async (sourceEntityId) => {
			const role = await resolveEntityRole(
				runtime,
				world,
				metadata,
				sourceEntityId,
			);
			if (isAdminRank(role)) {
				trusted.add(sourceEntityId);
			}
		}),
	);
	return trusted;
}

interface ParsedResolution {
	resolvedId?: string;
	confidence?: string;
	matches?: {
		match?:
			| { name?: string; reason?: string }
			| { name?: string; reason?: string }[];
	};
}

function parseEntityResolutionResponse(
	response: unknown,
): (ParsedResolution & { type?: string; entityId?: string }) | null {
	if (!response) return null;
	let parsedJson: unknown = response;
	if (typeof response === "string") {
		const trimmed = response.trim();
		if (!trimmed) return null;
		try {
			parsedJson = JSON.parse(trimmed);
		} catch {
			// error-policy:J3 entity resolution is model-produced input; malformed
			// JSON is an explicit invalid response.
			return null;
		}
	}

	if (parsedJson && typeof parsedJson === "object") {
		const typeValue = readEntityResolutionField(parsedJson, "type");
		const entityIdValue = readEntityResolutionField(parsedJson, "entityId");
		const resolvedIdValue = readEntityResolutionField(parsedJson, "resolvedId");
		const type = typeof typeValue === "string" ? typeValue : undefined;
		const entityId =
			typeof entityIdValue === "string"
				? entityIdValue
				: typeof resolvedIdValue === "string"
					? resolvedIdValue
					: undefined;
		const matches = normalizeEntityMatches(
			readEntityResolutionField(parsedJson, "matches"),
		);

		if (type || entityId || matches.length > 0) {
			return {
				type,
				entityId: entityId && entityId !== "null" ? entityId : undefined,
				matches: matches.length > 0 ? { match: matches } : undefined,
			};
		}
	}

	return null;
}

const ENTITY_RESOLUTION_SCHEMA = {
	type: "object",
	properties: {
		entityId: { type: "string" },
		type: {
			type: "string",
			enum: [
				"EXACT_MATCH",
				"USERNAME_MATCH",
				"NAME_MATCH",
				"RELATIONSHIP_MATCH",
				"AMBIGUOUS",
				"UNKNOWN",
			],
		},
		matches: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					reason: { type: "string" },
				},
			},
		},
	},
};

const entityResolutionTemplate = `# Task: Resolve Entity Name
Message Sender: {{senderName}} (ID: {{senderId}})
Agent: {{agentName}} (ID: {{agentId}})

# Referent to resolve:
{{referent}}

# Entities in Room:
{{#if entitiesInRoom}}
{{entitiesInRoom}}
{{/if}}

# Related contacts:
{{#if relationshipEntities}}
{{relationshipEntities}}
{{/if}}

{{recentMessages}}

# Instructions:
1. Analyze the context to identify which entity is being referenced
2. Consider special references like "me" (the message sender) or "you" (agent the message is directed to)
3. Look for usernames/handles in standard formats (e.g. @username, user#1234)
4. Consider context from recent messages for pronouns and references
5. If multiple matches exist, use context to disambiguate
6. Consider recent interactions and relationship strength when resolving ambiguity
7. Only return an entityId that appears in the entity lists above

Return a JSON object with:
- entityId: exact ID if known, otherwise null
- type: EXACT_MATCH | USERNAME_MATCH | NAME_MATCH | RELATIONSHIP_MATCH | AMBIGUOUS | UNKNOWN
- matches: array of { "name": "matched-name", "reason": "why this entity matches" }

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

function normalizeEntityName(value: string): string {
	return value.trim().toLowerCase();
}

function stripAtPrefix(value: string): string {
	return normalizeEntityName(value).replace(/^@+/, "");
}

function referentTextOf(message: Memory): string {
	return typeof message.content?.text === "string" ? message.content.text : "";
}

function formatRecentMessagesForResolution(memories: Memory[]): string {
	return memories
		.map((memory) => {
			const text =
				typeof memory.content?.text === "string" ? memory.content.text : "";
			return `${memory.entityId}: ${text}`;
		})
		.join("\n");
}

function visibleComponents(
	entity: Entity,
	messageEntityId: UUID,
	agentId: UUID,
	trustedSourceIds: Set<string>,
): NonNullable<Entity["components"]> {
	return (entity.components ?? []).filter((component) => {
		if (component.sourceEntityId === messageEntityId) return true;
		if (entity.id && component.sourceEntityId === entity.id) return true;
		if (
			component.sourceEntityId &&
			trustedSourceIds.has(component.sourceEntityId)
		) {
			return true;
		}
		if (component.sourceEntityId === agentId) return true;
		return false;
	});
}

async function withVisibleComponents(
	runtime: IAgentRuntime,
	world: World | null,
	entity: Entity,
	messageEntityId: UUID,
): Promise<Entity> {
	if (!entity.components) {
		return { ...entity };
	}
	const trustedSourceIds = await resolveTrustedComponentSourceIds(
		runtime,
		world,
		entity.components,
	);
	return {
		...entity,
		components: visibleComponents(
			entity,
			messageEntityId,
			runtime.agentId,
			trustedSourceIds,
		),
	};
}

function uniqueEntitiesById(entities: Entity[]): Entity[] {
	const seen = new Set<string>();
	const unique: Entity[] = [];
	for (const entity of entities) {
		const id = entity.id;
		if (!id) {
			unique.push(entity);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		unique.push(entity);
	}
	return unique;
}

type IndexedEntity = {
	entity: Entity;
	normalizedNames: Set<string>;
	strippedNames: Set<string>;
	normalizedUsernames: Set<string>;
	strippedUsernames: Set<string>;
	normalizedHandles: Set<string>;
	strippedHandles: Set<string>;
};

function indexEntities(entities: Entity[]): IndexedEntity[] {
	return entities.map((entity) => {
		const normalizedNames = new Set<string>();
		const strippedNames = new Set<string>();
		for (const name of entity.names) {
			normalizedNames.add(normalizeEntityName(name));
			strippedNames.add(stripAtPrefix(name));
		}

		const normalizedUsernames = new Set<string>();
		const strippedUsernames = new Set<string>();
		const normalizedHandles = new Set<string>();
		const strippedHandles = new Set<string>();
		for (const component of entity.components ?? []) {
			const username =
				typeof component.data?.username === "string"
					? component.data.username
					: undefined;
			if (username) {
				normalizedUsernames.add(normalizeEntityName(username));
				strippedUsernames.add(stripAtPrefix(username));
			}

			const handle =
				typeof component.data?.handle === "string"
					? component.data.handle
					: undefined;
			if (handle) {
				normalizedHandles.add(normalizeEntityName(handle));
				strippedHandles.add(stripAtPrefix(handle));
			}
		}

		return {
			entity,
			normalizedNames,
			strippedNames,
			normalizedUsernames,
			strippedUsernames,
			normalizedHandles,
			strippedHandles,
		};
	});
}

function indexedEntityMatches(
	entry: IndexedEntity,
	matchName: string,
	matchKey: string,
): boolean {
	return (
		entry.strippedNames.has(matchKey) ||
		entry.normalizedNames.has(matchName) ||
		entry.strippedUsernames.has(matchKey) ||
		entry.normalizedUsernames.has(matchName) ||
		entry.strippedHandles.has(matchKey) ||
		entry.normalizedHandles.has(matchName)
	);
}

function entitiesMatchingReferent(
	indexed: IndexedEntity[],
	referent: string,
): Entity[] {
	const matchName = normalizeEntityName(referent);
	const matchKey = stripAtPrefix(referent);
	if (!matchKey) return [];
	return indexed
		.filter((entry) => indexedEntityMatches(entry, matchName, matchKey))
		.map((entry) => entry.entity);
}

async function getRecentInteractions(
	sourceEntityId: UUID,
	candidateEntities: Entity[],
	recentMessages: Memory[],
	relationships: Relationship[],
): Promise<{ entity: Entity; interactions: Memory[]; count: number }[]> {
	const results: Array<{
		entity: Entity;
		interactions: Memory[];
		count: number;
	}> = [];

	const messageEntityById = new Map<UUID, UUID>();
	for (const recentMessage of recentMessages) {
		if (recentMessage.id && recentMessage.entityId) {
			messageEntityById.set(recentMessage.id, recentMessage.entityId);
		}
	}

	for (const entity of candidateEntities) {
		const interactions: Memory[] = [];
		let interactionScore = 0;

		const directReplies = recentMessages.filter((msg) => {
			if (!msg.entityId || !msg.content.inReplyTo) {
				return false;
			}
			const repliedToEntityId = messageEntityById.get(msg.content.inReplyTo);
			return (
				(msg.entityId === sourceEntityId && repliedToEntityId === entity.id) ||
				(msg.entityId === entity.id && repliedToEntityId === sourceEntityId)
			);
		});

		interactions.push(...directReplies);

		const relationship = relationships.find(
			(rel) =>
				(rel.sourceEntityId === sourceEntityId &&
					rel.targetEntityId === entity.id) ||
				(rel.targetEntityId === sourceEntityId &&
					rel.sourceEntityId === entity.id),
		);

		const relationshipMetadata = relationship?.metadata;
		if (relationshipMetadata?.interactions) {
			interactionScore = relationshipMetadata.interactions as number;
		}

		interactionScore += directReplies.length;

		const uniqueInteractions = [...new Set(interactions)];
		results.push({
			entity,
			interactions: uniqueInteractions,
			count: Math.round(interactionScore),
		});
	}

	return results.sort((a, b) => b.count - a.count);
}

export async function findEntityByName(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): Promise<Entity | null> {
	const room = state.data.room ?? (await runtime.getRoom(message.roomId));
	if (!room) {
		logger.warn(
			{ src: "core:entities", roomId: message.roomId },
			"Room not found for entity search",
		);
		return null;
	}

	const world: World | null = room.worldId
		? await runtime.getWorld(room.worldId)
		: null;

	const entitiesInRoom = await runtime.getEntitiesForRoom(room.id, true);
	const relationships = await runtime.getRelationships({
		entityIds: [message.entityId],
	});
	const relationshipEntities = await Promise.all(
		relationships.map(async (rel) => {
			const entityId =
				rel.sourceEntityId === message.entityId
					? rel.targetEntityId
					: rel.sourceEntityId;
			return runtime.getEntityById(entityId);
		}),
	);

	const filteredEntities = await Promise.all(
		entitiesInRoom.map((entity) =>
			withVisibleComponents(runtime, world, entity, message.entityId),
		),
	);
	const filteredRelationshipEntities = await Promise.all(
		relationshipEntities
			.filter((entity): entity is Entity => entity !== null)
			.map((entity) =>
				withVisibleComponents(runtime, world, entity, message.entityId),
			),
	);

	const allEntities = uniqueEntitiesById([
		...filteredEntities,
		...filteredRelationshipEntities,
	]);
	const indexedEntities = indexEntities(allEntities);
	const referent = referentTextOf(message);
	const uniqueReferentHits = entitiesMatchingReferent(
		indexedEntities,
		referent,
	);
	if (uniqueReferentHits.length === 1) {
		return uniqueReferentHits[0] ?? null;
	}

	const recentMessages = await runtime.getMemories({
		tableName: "messages",
		roomId: room.id,
		limit: 20,
	});
	const interactionData = await getRecentInteractions(
		message.entityId,
		allEntities,
		recentMessages,
		relationships,
	);

	const senderEntity = allEntities.find(
		(entity) => entity.id === message.entityId,
	);
	const prompt = utils.composePrompt({
		state: {
			roomName: room.name || room.id,
			worldName: world?.name || "Unknown",
			referent,
			entitiesInRoom: JSON.stringify(filteredEntities, null, 2),
			relationshipEntities: JSON.stringify(
				filteredRelationshipEntities,
				null,
				2,
			),
			recentMessages: formatRecentMessagesForResolution(recentMessages),
			entityId: message.entityId,
			senderId: message.entityId,
			senderName: senderEntity?.names[0] ?? "",
			agentName: runtime.character?.name ?? "",
			agentId: runtime.agentId,
		},
		template: entityResolutionTemplate,
	});

	const result = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		responseSchema: ENTITY_RESOLUTION_SCHEMA,
		responseFormat: { type: "json_object" },
	});

	const resolution = parseEntityResolutionResponse(result);
	const candidateById = new Map(
		allEntities
			.filter((entity): entity is Entity & { id: UUID } => Boolean(entity.id))
			.map((entity) => [entity.id, entity]),
	);
	if (!resolution) {
		logger.warn(
			{ src: "core:entities" },
			"Failed to parse entity resolution result",
		);
		return null;
	}

	if (resolution.type === "EXACT_MATCH" && resolution.entityId) {
		const matched = candidateById.get(resolution.entityId as UUID);
		if (matched) {
			return matched;
		}
	}

	let matchesArray: EntityMatch[] = [];
	const parsedResolution = resolution as ParsedResolution;
	const parsedResolutionMatches = parsedResolution.matches;
	if (parsedResolutionMatches?.match) {
		const matchValue = parsedResolutionMatches.match;
		matchesArray = Array.isArray(matchValue) ? matchValue : [matchValue];
	}

	for (const match of matchesArray) {
		if (!match?.name) continue;
		const matchName = normalizeEntityName(match.name);
		const matchKey = stripAtPrefix(match.name);
		const matchingEntity = indexedEntities.find((entry) =>
			indexedEntityMatches(entry, matchName, matchKey),
		)?.entity;
		if (!matchingEntity) continue;
		if (resolution.type === "RELATIONSHIP_MATCH") {
			const interactionInfo = interactionData.find(
				(data) => data.entity.id === matchingEntity.id,
			);
			if (interactionInfo && interactionInfo.count > 0) {
				return matchingEntity;
			}
			continue;
		}
		return matchingEntity;
	}

	return null;
}

export const createUniqueUuid = (
	runtime: IAgentRuntime,
	baseUserId: UUID | string,
): UUID => {
	if (baseUserId === runtime.agentId) {
		return runtime.agentId;
	}

	const combinedString = `${baseUserId}:${runtime.agentId}`;
	return utils.stringToUuid(combinedString);
};

export async function getEntityDetails({
	runtime,
	roomId,
}: {
	runtime: IAgentRuntime;
	roomId: UUID;
}) {
	return memoizeTurnWork(
		`entity-details:${runtime.agentId}:${roomId}`,
		async () => {
			const [room, roomEntities] = await Promise.all([
				runtime.getRoom(roomId),
				runtime.getEntitiesForRoom(roomId, true),
			]);

			const uniqueEntities = new Map<string, EntityDetailsRecord>();

			for (const entity of roomEntities) {
				const entityId = entity.id;
				if (!entityId || uniqueEntities.has(entityId)) continue;

				const allData = {};
				for (const component of entity.components || []) {
					Object.assign(allData, component.data);
				}

				const mergedData: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(allData)) {
					if (!mergedData[key]) {
						mergedData[key] = value;
						continue;
					}

					if (Array.isArray(mergedData[key]) && Array.isArray(value)) {
						mergedData[key] = [...new Set([...mergedData[key], ...value])];
					} else if (
						typeof mergedData[key] === "object" &&
						typeof value === "object"
					) {
						mergedData[key] = { ...mergedData[key], ...value };
					}
				}

				const getEntityNameFromMetadata = (
					source: string,
				): string | undefined => {
					const sourceMetadata = entity.metadata?.[source];
					if (
						sourceMetadata &&
						typeof sourceMetadata === "object" &&
						sourceMetadata !== null
					) {
						const metadataObj = sourceMetadata as Record<string, unknown>;
						if ("name" in metadataObj && typeof metadataObj.name === "string") {
							return metadataObj.name;
						}
					}
					return undefined;
				};

				uniqueEntities.set(entityId, {
					id: entityId,
					agentId: entity.agentId,
					name: room?.source
						? getEntityNameFromMetadata(String(room.source)) || entity.names[0]
						: entity.names[0],
					names: entity.names,
					metadata: entity.metadata,
					data: stableStringify({ ...mergedData, ...entity.metadata }),
				});
			}

			return Array.from(uniqueEntities.values()).sort((left, right) => {
				const leftName = left.name ?? left.names[0] ?? "";
				const rightName = right.name ?? right.names[0] ?? "";
				return (
					leftName.localeCompare(rightName) ||
					String(left.id ?? "").localeCompare(String(right.id ?? ""))
				);
			});
		},
	);
}

function formatEntityNames(names: string[]): string {
	const uniqueNames = [...new Set(names.filter(Boolean))];
	const renderedNames =
		uniqueNames.length > 0 ? `"${uniqueNames.join('" aka "')}"` : '"(unnamed)"';
	return renderedNames;
}

export function formatEntityMetadata(metadata: unknown): string {
	return stableStringify(metadata);
}

export function formatEntities({ entities }: { entities: Entity[] }) {
	const sortedEntities = [...entities].sort((left, right) => {
		const leftName = left.names[0] ?? "";
		const rightName = right.names[0] ?? "";
		return (
			leftName.localeCompare(rightName) ||
			String(left.id ?? "").localeCompare(String(right.id ?? ""))
		);
	});

	const entityStrings = sortedEntities.map((entity: Entity) => {
		const header = `${formatEntityNames(entity.names)}\nID: ${entity.id}${
			entity.metadata && Object.keys(entity.metadata).length > 0
				? `\nData: ${formatEntityMetadata(entity.metadata)}\n`
				: "\n"
		}`;
		return header;
	});
	return entityStrings.join("\n");
}
