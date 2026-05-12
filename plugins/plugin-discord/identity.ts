import {
	createUniqueUuid,
	type IAgentRuntime,
	type Metadata,
	Role,
	stringToUuid,
} from "@elizaos/core";

const CANONICAL_OWNER_SETTING_KEYS = ["ELIZA_ADMIN_ENTITY_ID"] as const;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{15,20}$/;

function getCanonicalOwnerId(runtime: IAgentRuntime): string | undefined {
	for (const key of CANONICAL_OWNER_SETTING_KEYS) {
		const value = runtime.getSetting?.(key);
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readDiscordSnowflake(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return DISCORD_SNOWFLAKE_PATTERN.test(trimmed) ? trimmed : null;
}

function readUserIdFromOwnerLike(value: unknown): string | null {
	const owner = asRecord(value);
	if (!owner) {
		return null;
	}

	return (
		readDiscordSnowflake(owner.id) ??
		readDiscordSnowflake(asRecord(owner.user)?.id) ??
		readDiscordSnowflake(owner.ownerId) ??
		readDiscordSnowflake(owner.ownerUserId)
	);
}

export function resolveElizaOwnerEntityId(runtime: IAgentRuntime): string {
	const configuredOwnerId = getCanonicalOwnerId(runtime);
	if (configuredOwnerId) {
		return configuredOwnerId;
	}

	const agentName = runtime.character?.name?.trim() || runtime.agentId;
	return stringToUuid(`${agentName}-admin-entity`);
}

export function resolveDiscordRuntimeEntityId(
	runtime: IAgentRuntime,
	userId: string,
	ownerDiscordUserIds: Iterable<string> = [],
): string {
	for (const ownerUserId of ownerDiscordUserIds) {
		if (ownerUserId === userId) {
			return resolveElizaOwnerEntityId(runtime);
		}
	}
	return createUniqueUuid(runtime, userId);
}

export function extractDiscordOwnerUserIds(application: unknown): string[] {
	const applicationRecord = asRecord(application);
	if (!applicationRecord) {
		return [];
	}

	const ownerCandidates = new Set<string>();
	const directOwnerId = readUserIdFromOwnerLike(applicationRecord.owner);
	if (directOwnerId) {
		ownerCandidates.add(directOwnerId);
	}

	const team = asRecord(applicationRecord.team);
	const teamOwnerId =
		readDiscordSnowflake(team?.ownerId) ??
		readDiscordSnowflake(team?.ownerUserId);
	if (teamOwnerId) {
		ownerCandidates.add(teamOwnerId);
	}

	const teamMembers = team?.members;
	// Discord.js returns team.members as a Collection (Map-like), not an Array.
	// Handle both Array and iterable (Collection/Map) shapes.
	const memberIterable: Iterable<unknown> | null = Array.isArray(teamMembers)
		? teamMembers
		: teamMembers &&
				typeof teamMembers === "object" &&
				typeof (teamMembers as Iterable<unknown>)[Symbol.iterator] ===
					"function"
			? (teamMembers as Iterable<unknown>)
			: null;
	if (memberIterable) {
		for (const entry of memberIterable) {
			// Collection/Map yields [key, value] tuples; Array yields values directly.
			const member = Array.isArray(entry) ? entry[1] : entry;
			const memberId = readUserIdFromOwnerLike(member);
			if (memberId) {
				ownerCandidates.add(memberId);
			}
		}
	}

	return [...ownerCandidates];
}

export function parseDiscordOwnerUserIds(value: unknown): string[] {
	const rawValues = (() => {
		if (Array.isArray(value)) {
			return value;
		}
		if (typeof value !== "string" || value.trim().length === 0) {
			return [];
		}
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	})();

	return rawValues
		.map((entry) => readDiscordSnowflake(entry))
		.filter((entry): entry is string => Boolean(entry));
}

export function buildDiscordWorldMetadata(
	runtime: IAgentRuntime,
	guildOwnerId: string | undefined,
): Metadata | undefined {
	const ownerId = resolveElizaOwnerEntityId(runtime);
	const roles: Record<string, Role> = {
		[ownerId]: Role.OWNER,
	};

	// The Discord guild owner should also be recognized as an owner in their
	// guild.  Map the guild owner's Discord snowflake to a runtime entity ID
	// and grant OWNER so that role resolution picks them up even when the bot-
	// application owner extraction didn't include them.
	if (guildOwnerId && DISCORD_SNOWFLAKE_PATTERN.test(guildOwnerId)) {
		const guildOwnerEntityId = createUniqueUuid(runtime, guildOwnerId);
		if (guildOwnerEntityId !== ownerId) {
			roles[guildOwnerEntityId] = Role.OWNER;
		}
	}

	return {
		ownership: { ownerId },
		roles,
	};
}

export function buildDiscordEntityMetadata(
	userId: string,
	userName: string,
	name: string,
	globalName?: string,
	avatarUrl?: string,
): Metadata {
	return {
		default: {
			username: userName,
			name,
			...(typeof avatarUrl === "string" && avatarUrl.length > 0
				? { avatarUrl }
				: {}),
		},
		discord: {
			id: userId,
			userId,
			userName,
			username: userName,
			name,
			...(typeof globalName === "string" && globalName.length > 0
				? { globalName }
				: {}),
			...(typeof avatarUrl === "string" && avatarUrl.length > 0
				? { avatarUrl }
				: {}),
		},
		originalId: userId,
		username: userName,
		displayName: name,
		...(typeof avatarUrl === "string" && avatarUrl.length > 0
			? { avatarUrl }
			: {}),
	};
}
