import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Relationship,
	State,
	UUID,
	World,
} from "./types";
import type { SchemaRow } from "./types/state";
import * as utils from "./utils";
import { stableStringify } from "./utils/deterministic";

type EntityDetailsRecord = Pick<Entity, "id" | "names"> & {
	name?: string;
	data: string;
};

const ENTITY_DETAILS_CACHE_TTL_MS = 1_000;
const entityDetailsCache = new WeakMap<
	IAgentRuntime,
	Map<string, { expiresAt: number; promise: Promise<EntityDetailsRecord[]> }>
>();

interface EntityMatch {
	name?: string;
	reason?: string;
}

interface ParsedResolution {
	resolvedId?: string;
	confidence?: string;
	matches?: {
		match?: EntityMatch | EntityMatch[];
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntityMatch(value: unknown): EntityMatch | null {
	if (!isRecord(value)) return null;

	const name = typeof value.name === "string" ? value.name : undefined;
	const reason = typeof value.reason === "string" ? value.reason : undefined;

	if (!name) return null;
	return { name, reason };
}

function normalizeEntityMatches(value: unknown): EntityMatch[] {
	if (Array.isArray(value)) {
		return value
			.map((entry) => normalizeEntityMatch(entry))
			.filter((entry): entry is EntityMatch => entry !== null);
	}

	if (isRecord(value) && "match" in value) {
		return normalizeEntityMatches(value.match);
	}

	const directMatch = normalizeEntityMatch(value);
	return directMatch ? [directMatch] : [];
}

function parsedResolutionFromRecord(
	parsed: Record<string, unknown>,
): (ParsedResolution & { type?: string; entityId?: string }) | null {
	const type = typeof parsed.type === "string" ? parsed.type : undefined;
	const entityId =
		typeof parsed.entityId === "string"
			? parsed.entityId
			: typeof parsed.resolvedId === "string"
				? parsed.resolvedId
				: undefined;
	const matches = normalizeEntityMatches(parsed.matches);

	if (type || entityId || matches.length > 0) {
		return {
			type,
			entityId: entityId && entityId !== "null" ? entityId : undefined,
			matches: matches.length > 0 ? { match: matches } : undefined,
		};
	}
	return null;
}

const entityResolutionSchema: SchemaRow[] = [
	{
		field: "entityId",
		description: "Exact entity UUID if known, or the literal null if unknown",
		required: false,
	},
	{
		field: "type",
		description:
			"One of: EXACT_MATCH, USERNAME_MATCH, NAME_MATCH, RELATIONSHIP_MATCH, AMBIGUOUS, UNKNOWN",
		required: false,
	},
	{
		field: "matches",
		description: "Candidate entities when ambiguous or for context",
		type: "array",
		required: false,
		items: {
			type: "object",
			description: "One candidate match",
			properties: [
				{
					field: "name",
					description: "Display name or handle of the candidate entity",
					required: true,
				},
				{
					field: "reason",
					description: "Why this entity might match the reference",
					required: false,
				},
			],
		},
	},
];

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

Return a TOON document with:
entityId: exact-id-if-known-otherwise-null
type: EXACT_MATCH | USERNAME_MATCH | NAME_MATCH | RELATIONSHIP_MATCH | AMBIGUOUS | UNKNOWN
matches[0]:
  name: matched-name
  reason: why this entity matches

IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any text, thinking, or reasoning before or after it.`;

async function getRecentInteractions(
	runtime: IAgentRuntime,
	sourceEntityId: UUID,
	candidateEntities: Entity[],
	roomId: UUID,
	relationships: Relationship[],
): Promise<{ entity: Entity; interactions: Memory[]; count: number }[]> {
	const results: Array<{
		entity: Entity;
		interactions: Memory[];
		count: number;
	}> = [];

	const recentMessages = await runtime.getMemories({
		tableName: "messages",
		roomId,
		count: 20,
	});

	for (const entity of candidateEntities) {
		const interactions: Memory[] = [];
		let interactionScore = 0;

		const directReplies = recentMessages.filter(
			(msg) =>
				(msg.entityId === sourceEntityId &&
					msg.content.inReplyTo === entity.id) ||
				(msg.entityId === entity.id &&
					msg.content.inReplyTo === sourceEntityId),
		);

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
			interactions: uniqueInteractions.slice(-5),
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

	const filteredEntities = await Promise.all(
		entitiesInRoom.map(async (entity) => {
			if (!entity.components) return entity;

			const worldMetadata = world?.metadata;
			const worldRoles = worldMetadata?.roles || {};

			entity.components = entity.components.filter((component) => {
				if (component.sourceEntityId === message.entityId) return true;

				if (world && component.sourceEntityId) {
					const sourceRole = worldRoles[component.sourceEntityId];
					if (sourceRole === "OWNER" || sourceRole === "ADMIN") return true;
				}

				if (component.sourceEntityId === runtime.agentId) return true;

				return false;
			});

			return entity;
		}),
	);

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

	const allEntities = [
		...filteredEntities,
		...relationshipEntities.filter((e): e is Entity => e !== null),
	];

	const interactionData = await getRecentInteractions(
		runtime,
		message.entityId,
		allEntities,
		room.id as UUID,
		relationships,
	);

	const prompt = utils.composePrompt({
		state: {
			roomName: (room.name || room.id) as string,
			worldName: (world?.name || "Unknown") as string,
			entitiesInRoom: JSON.stringify(filteredEntities, null, 2),
			entityId: message.entityId,
			senderId: message.entityId,
		},
		template: entityResolutionTemplate,
	});

	const askResult = await runtime.promptBatcher.askNow(
		`entity-resolution:${uuidv4()}`,
		{
			preamble: prompt,
			schema: entityResolutionSchema,
			fallback: {},
			model: "small",
			execOptions: {
				stopSequences: [],
			},
		},
	);

	const resolution = askResult ? parsedResolutionFromRecord(askResult) : null;
	if (!resolution) {
		// If the model output is malformed, fall back to a conservative heuristic:
		// when there's only one candidate entity in context, return it.
		if (filteredEntities.length === 1) {
			return filteredEntities[0] ?? null;
		}
		logger.warn(
			{ src: "core:entities" },
			"Failed to parse entity resolution result",
		);
		return null;
	}

	if (resolution.type === "EXACT_MATCH" && resolution.entityId) {
		const entity = await runtime.getEntityById(resolution.entityId as UUID);
		if (entity) {
			if (entity.components) {
				const worldMetadata = world?.metadata;
				const worldRoles = worldMetadata?.roles || {};
				entity.components = entity.components.filter((component) => {
					if (component.sourceEntityId === message.entityId) return true;
					if (world && component.sourceEntityId) {
						const sourceRole = worldRoles[component.sourceEntityId];
						if (sourceRole === "OWNER" || sourceRole === "ADMIN") return true;
					}
					if (component.sourceEntityId === runtime.agentId) return true;
					return false;
				});
			}
			return entity;
		}
	}

	let matchesArray: EntityMatch[] = [];
	const parsedResolution = resolution as ParsedResolution;
	const parsedResolutionMatches = parsedResolution.matches;
	if (parsedResolutionMatches?.match) {
		const matchValue = parsedResolutionMatches.match;
		matchesArray = Array.isArray(matchValue) ? matchValue : [matchValue];
	}

	const normalize = (s: string): string => s.trim().toLowerCase();
	const stripAt = (s: string): string => normalize(s).replace(/^@+/, "");
	const indexedEntities = allEntities.map((entity) => {
		const normalizedNames = new Set<string>();
		const strippedNames = new Set<string>();
		for (const name of entity.names) {
			normalizedNames.add(normalize(name));
			strippedNames.add(stripAt(name));
		}

		const normalizedUsernames = new Set<string>();
		const strippedUsernames = new Set<string>();
		const normalizedHandles = new Set<string>();
		const strippedHandles = new Set<string>();
		const fallbackTokens: string[] = [];
		for (const component of entity.components ?? []) {
			const username =
				typeof component.data?.username === "string"
					? component.data.username
					: undefined;
			if (username) {
				normalizedUsernames.add(normalize(username));
				strippedUsernames.add(stripAt(username));
				fallbackTokens.push(normalize(username));
			}

			const handle =
				typeof component.data?.handle === "string"
					? component.data.handle
					: undefined;
			if (handle) {
				const normalizedHandle = normalize(handle);
				normalizedHandles.add(normalizedHandle);
				strippedHandles.add(stripAt(handle));
				fallbackTokens.push(normalizedHandle);
				const handleNoAt = handle.replace(/^@+/, "");
				if (handleNoAt) {
					fallbackTokens.push(normalize(handleNoAt));
				}
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
			fallbackTokens,
		};
	});

	const firstMatch = matchesArray[0];
	if (matchesArray.length > 0 && firstMatch && firstMatch.name) {
		const matchName = normalize(firstMatch.name);
		const matchKey = stripAt(firstMatch.name);

		const matchingEntity = indexedEntities.find((entry) => {
			if (
				entry.strippedNames.has(matchKey) ||
				entry.normalizedNames.has(matchName) ||
				entry.strippedUsernames.has(matchKey) ||
				entry.normalizedUsernames.has(matchName) ||
				entry.strippedHandles.has(matchKey) ||
				entry.normalizedHandles.has(matchName)
			) {
				return true;
			}
			return false;
		})?.entity;

		if (matchingEntity) {
			if (resolution.type === "RELATIONSHIP_MATCH") {
				const interactionInfo = interactionData.find(
					(d) => d.entity.id === matchingEntity.id,
				);
				if (interactionInfo && interactionInfo.count > 0) {
					return matchingEntity;
				}
			} else {
				return matchingEntity;
			}
		}
	}

	// Fallback: if parsing failed to produce a usable match list, try to detect
	// usernames/handles mentioned in the structured model output.
	const resultLower = (
		askResult ? JSON.stringify(askResult) : ""
	).toLowerCase();
	const fallbackEntity = indexedEntities.find((entry) =>
		entry.fallbackTokens.some((token) => resultLower.includes(token)),
	)?.entity;
	if (fallbackEntity) {
		return fallbackEntity;
	}

	// Heuristic fallback: if the model indicates a name/username match but we
	// couldn't map it, and there's only a single candidate entity in context,
	// return it rather than failing closed.
	if (
		(resolution.type === "USERNAME_MATCH" ||
			resolution.type === "NAME_MATCH") &&
		filteredEntities.length === 1
	) {
		return filteredEntities[0] ?? null;
	}

	// Final fallback: if there's only one candidate entity in scope, return it.
	// This prevents needless nulls in small rooms when the model response is noisy.
	if (allEntities.length === 1) {
		return allEntities[0] ?? null;
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
	const runtimeCache = entityDetailsCache.get(runtime) ?? new Map();
	entityDetailsCache.set(runtime, runtimeCache);

	const cacheKey = String(roomId);
	const cachedEntry = runtimeCache.get(cacheKey);
	if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
		return cachedEntry.promise;
	}

	const pendingPromise = (async () => {
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
				name: room?.source
					? getEntityNameFromMetadata(String(room.source)) || entity.names[0]
					: entity.names[0],
				names: entity.names,
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
	})();

	runtimeCache.set(cacheKey, {
		expiresAt: Date.now() + ENTITY_DETAILS_CACHE_TTL_MS,
		promise: pendingPromise,
	});

	try {
		return await pendingPromise;
	} catch (error) {
		runtimeCache.delete(cacheKey);
		throw error;
	}
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
		const header = `"${entity.names.join('" aka "')}"\nID: ${entity.id}${
			entity.metadata && Object.keys(entity.metadata).length > 0
				? `\nData: ${stableStringify(entity.metadata)}\n`
				: "\n"
		}`;
		return header;
	});
	return entityStrings.join("\n");
}
