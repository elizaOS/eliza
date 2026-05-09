import type {
	Entity,
	IAgentRuntime,
	JsonValue,
	Memory,
	Relationship,
	Room,
	UUID,
} from "../types/index";
import { asRecord } from "../utils/type-guards";

/** Aligns with `MergeCandidateEvidence` in `relationships.ts` (kept here to avoid a circular import). */
export type RelationshipsMergeProposalEvidence = {
	platform?: string;
	handle?: string;
	identityIds?: UUID[];
	notes?: string;
	[extra: string]: JsonValue | UUID[] | undefined;
};

// Inlined from @elizaos/shared (core does not depend on shared)
function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export type RelationshipsGraphQuery = {
	search?: string | null;
	platform?: string | null;
	limit?: number;
	offset?: number;
	scope?: "all" | "relevant";
};

export type RelationshipsMergeCandidate = {
	id: UUID;
	entityA: UUID;
	entityB: UUID;
	confidence: number;
	evidence: Record<string, unknown>;
	status: "pending" | "accepted" | "rejected";
	proposedAt: string;
	resolvedAt?: string;
};

export type RelationshipsGraphSnapshot = {
	people: RelationshipsPersonSummary[];
	relationships: RelationshipsGraphEdge[];
	stats: RelationshipsGraphStats;
	candidateMerges: RelationshipsMergeCandidate[];
};

export type RelationshipsGraphStats = {
	totalPeople: number;
	totalRelationships: number;
	totalIdentities: number;
};

export type RelationshipsIdentityHandle = {
	entityId: UUID;
	platform: string;
	handle: string;
	status?: string | null;
	verified?: boolean | null;
};

export type RelationshipsIdentitySummary = {
	entityId: UUID;
	names: string[];
	platforms: string[];
	handles: RelationshipsIdentityHandle[];
};

export type RelationshipsProfile = {
	entityId: UUID;
	source: string;
	handle?: string | null;
	userId?: string | null;
	displayName?: string | null;
	avatarUrl?: string | null;
	canonical?: boolean | null;
};

export type RelationshipsPersonSummary = {
	groupId: UUID;
	primaryEntityId: UUID;
	memberEntityIds: UUID[];
	displayName: string;
	aliases: string[];
	platforms: string[];
	identities: RelationshipsIdentitySummary[];
	emails: string[];
	phones: string[];
	websites: string[];
	preferredCommunicationChannel: string | null;
	categories: string[];
	tags: string[];
	factCount: number;
	relationshipCount: number;
	isOwner: boolean;
	profiles: RelationshipsProfile[];
	lastInteractionAt?: string;
};

export type RelationshipsGraphEdge = {
	id: string;
	sourcePersonId: UUID;
	targetPersonId: UUID;
	sourcePersonName: string;
	targetPersonName: string;
	relationshipTypes: string[];
	sentiment: string;
	strength: number;
	interactionCount: number;
	lastInteractionAt?: string;
	rawRelationshipIds: string[];
};

export type RelationshipsPersonFact = {
	id: string;
	sourceType: "claim" | "contact" | "memory";
	text: string;
	field?: string;
	value?: string;
	scope?: string;
	confidence?: number;
	updatedAt?: string;
	/** ISO8601 timestamp from the FactRefinementEvaluator metadata. */
	lastReinforced?: string;
	/** Message IDs that contributed evidence for this fact. */
	evidenceMessageIds?: string[];
	provenance?: RelationshipsFactProvenance;
	extractedInformation?: RelationshipsFactExtractedInformation;
};

export type RelationshipsFactProvenance = {
	source?: string;
	evaluatorName?: string;
	sourceTrajectoryId?: UUID;
	lastReinforced?: string;
	evidenceMessageIds: string[];
};

export type RelationshipsFactExtractedInformation = {
	scope?: string;
	raw?: Record<string, unknown>;
};

export type RelationshipsConversationMessage = {
	id: string;
	entityId?: UUID;
	speaker: string;
	text: string;
	createdAt?: number;
};

export type RelationshipsConversationSnippet = {
	roomId: UUID;
	roomName: string;
	lastActivityAt?: string;
	messages: RelationshipsConversationMessage[];
};

export type RelationshipsIdentityEdge = {
	id: string;
	sourceEntityId: UUID;
	targetEntityId: UUID;
	confidence: number;
	status: string;
};

export type RelationshipsRelevantMemory = {
	id: string;
	sourceType: "message";
	entityId?: UUID;
	roomId?: UUID;
	roomName: string | null;
	speaker: string;
	text: string;
	createdAt?: string;
	source?: string | null;
};

export type RelationshipsUserPersonalityPreference = {
	id: string;
	entityId: UUID;
	text: string;
	category?: string;
	originalRequest?: string;
	source?: string | null;
	createdAt?: string;
};

export type RelationshipsPersonDetail = RelationshipsPersonSummary & {
	facts: RelationshipsPersonFact[];
	recentConversations: RelationshipsConversationSnippet[];
	relevantMemories: RelationshipsRelevantMemory[];
	relationships: RelationshipsGraphEdge[];
	identityEdges: RelationshipsIdentityEdge[];
	userPersonalityPreferences: RelationshipsUserPersonalityPreference[];
};

export type RelationshipsGraphService = {
	getGraphSnapshot: (
		query?: RelationshipsGraphQuery,
	) => Promise<RelationshipsGraphSnapshot>;
	getPersonDetail: (
		primaryEntityId: UUID,
	) => Promise<RelationshipsPersonDetail | null>;
	getCandidateMerges: () => Promise<RelationshipsMergeCandidate[]>;
	acceptMerge: (candidateId: UUID) => Promise<void>;
	rejectMerge: (candidateId: UUID) => Promise<void>;
	proposeMerge: (
		entityA: UUID,
		entityB: UUID,
		evidence: RelationshipsMergeProposalEvidence,
	) => Promise<UUID>;
};

type RelationshipsContactLike = {
	entityId: UUID;
	categories?: string[];
	tags?: string[];
	preferences?: {
		preferredCommunicationChannel?: string;
	};
	customFields?: Record<string, unknown>;
	lastModified?: string;
};

export type RelationshipsServiceLike = {
	getContact?: (
		entityId: UUID,
	) => Promise<RelationshipsContactLike | null | undefined>;
	searchContacts?: (criteria: {
		categories?: string[];
		tags?: string[];
		searchTerm?: string;
		privacyLevel?: string;
	}) => Promise<RelationshipsContactLike[]>;
	getCandidateMerges?: () => Promise<unknown[]>;
	acceptMerge?: (candidateId: UUID) => Promise<void>;
	rejectMerge?: (candidateId: UUID) => Promise<void>;
	proposeMerge?: (
		entityA: UUID,
		entityB: UUID,
		evidence: RelationshipsMergeProposalEvidence,
	) => Promise<UUID>;
};

type EntityContext = {
	entityId: UUID;
	entity: Entity | null;
	contact: RelationshipsContactLike | null;
	handles: RelationshipsIdentityHandle[];
	profiles: RelationshipsProfile[];
	platforms: string[];
	emails: string[];
	phones: string[];
	websites: string[];
};

type ClusterRecord = {
	groupId: UUID;
	primaryEntityId: UUID;
	memberEntityIds: UUID[];
};

type GraphEdgeSample = {
	sourcePersonId: UUID;
	targetPersonId: UUID;
	relationshipTypes: string[];
	sentiment: string;
	strength: number;
	strengthWeight?: number;
	interactionCount: number;
	lastInteractionAt?: string;
	rawRelationshipIds: string[];
};

type GraphEdgeAccumulator = {
	sourcePersonId: UUID;
	targetPersonId: UUID;
	relationshipTypes: Set<string>;
	sentimentCounts: Record<string, number>;
	strengthTotal: number;
	strengthWeight: number;
	interactionCount: number;
	lastInteractionAt?: string;
	rawRelationshipIds: Set<string>;
};

type ConversationGraphBuildResult = {
	edgeMap: Map<string, GraphEdgeAccumulator>;
	messageCountsByGroupId: Map<UUID, number>;
};

const KNOWN_PLATFORM_KEYS = [
	"discord",
	"telegram",
	"x",
	"twitter",
	"github",
	"bluesky",
	"instagram",
	"linkedin",
	"youtube",
	"reddit",
	"farcaster",
	"lens",
	"nostr",
	"warpcast",
	"signal",
	"email",
	"phone",
	"website",
] as const;

const CONTACT_PLATFORM_SET = new Set(["email", "phone", "website"]);
const GENERIC_RELATIONSHIP_TAGS = new Set([
	"identity_link",
	"relationships",
	"updated",
]);
const USER_PERSONALITY_PREFERENCES_TABLE = "user_personality_preferences";
const USER_PERSONALITY_PREFERENCES_LIMIT = 10;
const PERSON_RELEVANT_MEMORIES_LIMIT = 24;

function asString(value: unknown): string | null {
	return asNonEmptyString(value) ?? null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function contentRecord(memory: Memory): Record<string, unknown> {
	return asRecord(memory.content) ?? {};
}

function memoryText(memory: Memory): string | null {
	return asString(contentRecord(memory).text);
}

function memorySource(memory: Memory): string | null {
	return asString(contentRecord(memory).source);
}

function parseEvidenceMessageIds(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.length > 0,
			)
		: [];
}

function pushUnique(target: string[], value: string | null | undefined): void {
	if (!value || target.includes(value)) {
		return;
	}
	target.push(value);
}

function normalizePlatform(platform: string): string {
	const normalized = platform.trim().toLowerCase();
	if (normalized === "x") {
		return "twitter";
	}
	if (normalized === "telegram-account" || normalized === "telegramaccount") {
		return "telegram";
	}
	return normalized;
}

function normalizeProfileSource(source: string): string {
	const normalized = source.trim().toLowerCase();
	if (normalized === "clientchat") {
		return "client_chat";
	}
	if (normalized === "eliza-cloud") {
		return "elizacloud";
	}
	return normalizePlatform(normalized);
}

function normalizeIdentityHandle(platform: string, handle: string): string {
	const normalizedPlatform = normalizePlatform(platform);
	let normalizedHandle = handle.trim().toLowerCase();
	if (
		normalizedPlatform !== "email" &&
		normalizedPlatform !== "phone" &&
		normalizedPlatform !== "website"
	) {
		normalizedHandle = normalizedHandle.replace(/^@+/, "");
	}
	if (normalizedPlatform === "website") {
		normalizedHandle = normalizedHandle.replace(/\/+$/, "");
	}
	return normalizedHandle;
}

function normalizedIdentityKey(platform: string, handle: string): string {
	return `${normalizePlatform(platform)}:${normalizeIdentityHandle(
		platform,
		handle,
	)}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort((left, right) =>
		left.localeCompare(right),
	);
}

function normalizeRoomType(room: Room): string {
	return typeof room.type === "string" ? room.type.toLowerCase() : "";
}

function isoFromTimestamp(value?: number | null): string | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? new Date(value).toISOString()
		: undefined;
}

function laterIso(left?: string, right?: string): string | undefined {
	if (!left) return right;
	if (!right) return left;
	return Date.parse(left) >= Date.parse(right) ? left : right;
}

function relationshipStatus(relationship: Relationship): string {
	const metadata = asRecord(relationship.metadata);
	return asString(metadata?.status) ?? "unknown";
}

function isIdentityLink(relationship: Relationship): boolean {
	return (
		Array.isArray(relationship.tags) &&
		relationship.tags.includes("identity_link")
	);
}

function isConfirmedIdentityLink(relationship: Relationship): boolean {
	return (
		isIdentityLink(relationship) &&
		relationshipStatus(relationship) === "confirmed"
	);
}

function relationshipSentiment(relationship: Relationship): string {
	const metadata = asRecord(relationship.metadata);
	return asString(metadata?.sentiment) ?? "neutral";
}

function relationshipTypes(relationship: Relationship): string[] {
	const metadata = asRecord(relationship.metadata);
	const types = new Set<string>();
	const primaryType = asString(metadata?.relationshipType);
	if (primaryType) {
		types.add(primaryType);
	}
	for (const tag of relationship.tags ?? []) {
		if (!GENERIC_RELATIONSHIP_TAGS.has(tag)) {
			types.add(tag);
		}
	}
	return Array.from(types);
}

function relationshipStrength(relationship: Relationship): number {
	const metadata = asRecord(relationship.metadata);
	const raw = asNumber(metadata?.strength);
	if (raw === null) {
		return 0.5;
	}
	const normalized = raw > 1 ? raw / 100 : raw;
	return Math.max(0.05, Math.min(1, normalized));
}

function relationshipInteractionCount(relationship: Relationship): number {
	const metadata = asRecord(relationship.metadata);
	return Math.max(1, asNumber(metadata?.interactionCount) ?? 1);
}

function relationshipLastInteractionAt(
	relationship: Relationship,
): string | undefined {
	const metadata = asRecord(relationship.metadata);
	return asString(metadata?.lastInteractionAt) ?? undefined;
}

function relationshipConfidence(relationship: Relationship): number {
	const metadata = asRecord(relationship.metadata);
	return Math.max(
		0,
		Math.min(
			1,
			asNumber(metadata?.confidence) ??
				(relationshipStatus(relationship) === "confirmed" ? 1 : 0.5),
		),
	);
}

function factProvenanceFromMetadata(
	metadata: Record<string, unknown>,
): RelationshipsFactProvenance | undefined {
	const evidenceMessageIds = parseEvidenceMessageIds(
		metadata.evidenceMessageIds,
	);
	const provenance: RelationshipsFactProvenance = {
		source: asString(metadata.source) ?? undefined,
		evaluatorName: asString(metadata.evaluatorName) ?? undefined,
		sourceTrajectoryId: asString(metadata.sourceTrajectoryId) ?? undefined,
		lastReinforced: asString(metadata.lastReinforced) ?? undefined,
		evidenceMessageIds,
	};

	if (
		!provenance.source &&
		!provenance.evaluatorName &&
		!provenance.sourceTrajectoryId &&
		!provenance.lastReinforced &&
		provenance.evidenceMessageIds.length === 0
	) {
		return undefined;
	}

	return provenance;
}

function factExtractedInformationFromMetadata(
	metadata: Record<string, unknown>,
): RelationshipsFactExtractedInformation | undefined {
	const explicit =
		asRecord(metadata.extractedInformation) ??
		asRecord(metadata.extracted_information);
	const base = asRecord(metadata.base);
	const raw = explicit ?? base;
	if (!raw) {
		return undefined;
	}

	const scope =
		asString(raw.scope) ??
		(raw === explicit ? (asString(base?.scope) ?? undefined) : undefined);

	return {
		scope,
		raw,
	};
}

function entityNames(entity: Entity | null): string[] {
	return (
		entity?.names?.filter(
			(name): name is string =>
				typeof name === "string" && name.trim().length > 0,
		) ?? []
	);
}

function collectIdentityHandles(
	entityId: UUID,
	entity: Entity | null,
): RelationshipsIdentityHandle[] {
	const handles = new Map<string, RelationshipsIdentityHandle>();
	const metadata = asRecord(entity?.metadata);
	const rawPlatformIdentities = Array.isArray(metadata?.platformIdentities)
		? metadata?.platformIdentities
		: [];
	const rawClaims = Array.isArray(metadata?.identityClaims)
		? metadata?.identityClaims
		: [];

	const addHandle = (
		platformValue: unknown,
		handleValue: unknown,
		options?: { status?: unknown; verified?: unknown },
	) => {
		const platform = asString(platformValue);
		const handle = asString(handleValue);
		if (!platform || !handle) {
			return;
		}
		const normalizedPlatform = normalizePlatform(platform);
		const key = normalizedIdentityKey(normalizedPlatform, handle);
		if (!handles.has(key)) {
			handles.set(key, {
				entityId,
				platform: normalizedPlatform,
				handle: handle.trim(),
				status: asString(options?.status),
				verified: asBoolean(options?.verified),
			});
		}
	};

	for (const identity of rawPlatformIdentities) {
		const record = asRecord(identity);
		addHandle(record?.platform, record?.handle, {
			status: record?.status,
			verified: record?.verified,
		});
	}

	for (const claim of rawClaims) {
		const record = asRecord(claim);
		if (asString(record?.status) === "rejected") {
			continue;
		}
		addHandle(record?.platform, record?.handle, {
			status: record?.status,
			verified: record?.verified,
		});
	}

	for (const platform of KNOWN_PLATFORM_KEYS) {
		const platformMetadata = asRecord(metadata?.[platform]);
		if (!platformMetadata) {
			continue;
		}
		addHandle(
			normalizePlatform(platform),
			platformMetadata.handle ??
				platformMetadata.username ??
				platformMetadata.userName ??
				platformMetadata.screenName ??
				platformMetadata.email ??
				platformMetadata.phone ??
				platformMetadata.url ??
				platformMetadata.website ??
				platformMetadata.id,
		);
	}

	return Array.from(handles.values());
}

function extractContactAliases(
	customFields: Record<string, unknown> | undefined,
): string[] {
	return extractCustomFieldStrings(customFields, [
		"displayName",
		"preferredName",
		"nickname",
		"nicknames",
		"alias",
		"aliases",
		"username",
		"usernames",
		"handle",
		"handles",
	]);
}

function preferredContactLabel(
	contact: RelationshipsContactLike | null,
): string | null {
	return (
		extractContactAliases(contact?.customFields)?.find(
			(value) => value.trim().length > 0,
		) ?? null
	);
}

function extractContactIdentityHandles(
	entityId: UUID,
	customFields: Record<string, unknown> | undefined,
): RelationshipsIdentityHandle[] {
	if (!customFields) {
		return [];
	}

	const handles = new Map<string, RelationshipsIdentityHandle>();
	const addHandle = (platform: string, value: string) => {
		const trimmed = value.trim();
		if (!trimmed) {
			return;
		}
		const normalizedPlatform = normalizePlatform(platform);
		const key = normalizedIdentityKey(normalizedPlatform, trimmed);
		if (!handles.has(key)) {
			handles.set(key, {
				entityId,
				platform: normalizedPlatform,
				handle: trimmed,
			});
		}
	};

	const platformFieldPrefixes: Record<string, string[]> = {
		twitter: ["twitter", "x"],
		github: ["github"],
		discord: ["discord"],
		telegram: ["telegram", "telegramAccount", "telegram-account"],
		bluesky: ["bluesky"],
		instagram: ["instagram"],
		linkedin: ["linkedin"],
		youtube: ["youtube"],
		reddit: ["reddit"],
		farcaster: ["farcaster"],
		lens: ["lens"],
		nostr: ["nostr"],
		warpcast: ["warpcast"],
		signal: ["signal"],
	};

	for (const [platform, prefixes] of Object.entries(platformFieldPrefixes)) {
		const keys = prefixes.flatMap((prefix) => [
			`${prefix}Handle`,
			`${prefix}handle`,
			`${prefix}Username`,
			`${prefix}username`,
			`${prefix}UserName`,
			`${prefix}userName`,
			`${prefix}ScreenName`,
			`${prefix}screenName`,
		]);
		for (const value of extractCustomFieldStrings(customFields, keys)) {
			addHandle(platform, value);
		}
	}

	return Array.from(handles.values());
}

function extractCustomFieldStrings(
	customFields: Record<string, unknown> | undefined,
	keys: string[],
): string[] {
	if (!customFields) {
		return [];
	}
	const values: string[] = [];
	for (const key of keys) {
		const rawValue = customFields[key];
		if (Array.isArray(rawValue)) {
			for (const entry of rawValue) {
				pushUnique(values, asString(entry));
			}
			continue;
		}
		pushUnique(values, asString(rawValue));
	}
	return values;
}

function preferredProfileHandle(profile: RelationshipsProfile): string {
	return (
		asString(profile.handle) ??
		asString(profile.userId) ??
		asString(profile.displayName) ??
		profile.entityId
	);
}

function upsertProfile(
	profiles: Map<string, RelationshipsProfile>,
	profile: RelationshipsProfile,
): void {
	const source = normalizeProfileSource(profile.source);
	const normalizedProfile: RelationshipsProfile = {
		entityId: profile.entityId,
		source,
		handle: asString(profile.handle),
		userId: asString(profile.userId),
		displayName: asString(profile.displayName),
		avatarUrl: asString(profile.avatarUrl),
		canonical:
			typeof profile.canonical === "boolean" ? profile.canonical : undefined,
	};
	if (
		!normalizedProfile.handle &&
		!normalizedProfile.userId &&
		!normalizedProfile.displayName &&
		!normalizedProfile.avatarUrl
	) {
		return;
	}
	const existing = profiles.get(source);
	profiles.set(source, {
		entityId: normalizedProfile.entityId,
		source,
		handle: normalizedProfile.handle ?? existing?.handle ?? null,
		userId: normalizedProfile.userId ?? existing?.userId ?? null,
		displayName: normalizedProfile.displayName ?? existing?.displayName ?? null,
		avatarUrl: normalizedProfile.avatarUrl ?? existing?.avatarUrl ?? null,
		canonical: normalizedProfile.canonical ?? existing?.canonical ?? undefined,
	});
}

function profileValueFromRecord(
	record: Record<string, unknown> | null,
	keys: string[],
): string | null {
	if (!record) {
		return null;
	}
	for (const key of keys) {
		const value = asString(record[key]);
		if (value) {
			return value;
		}
	}
	return null;
}

function collectEntityProfiles(
	entityId: UUID,
	entity: Entity | null,
	handles: RelationshipsIdentityHandle[],
): RelationshipsProfile[] {
	const profiles = new Map<string, RelationshipsProfile>();
	const metadata = asRecord(entity?.metadata);
	const names = entityNames(entity);
	const fallbackDisplayName =
		profileValueFromRecord(metadata, ["displayName", "name", "username"]) ??
		names[0] ??
		null;
	const fallbackAvatarUrl =
		profileValueFromRecord(metadata, ["avatarUrl", "avatar"]) ?? null;

	for (const handle of handles) {
		if (CONTACT_PLATFORM_SET.has(handle.platform)) {
			continue;
		}
		upsertProfile(profiles, {
			entityId,
			source: handle.platform,
			handle: handle.handle,
			displayName: fallbackDisplayName,
			avatarUrl: fallbackAvatarUrl,
		});
	}

	for (const platform of KNOWN_PLATFORM_KEYS) {
		const platformMetadata = asRecord(metadata?.[platform]);
		if (!platformMetadata) {
			continue;
		}
		upsertProfile(profiles, {
			entityId,
			source: platform,
			handle: profileValueFromRecord(platformMetadata, [
				"handle",
				"username",
				"userName",
				"screenName",
				"email",
				"phone",
				"url",
				"website",
			]),
			userId: profileValueFromRecord(platformMetadata, [
				"userId",
				"id",
				"accountId",
				"originalId",
			]),
			displayName:
				profileValueFromRecord(platformMetadata, [
					"displayName",
					"globalName",
					"name",
				]) ?? fallbackDisplayName,
			avatarUrl:
				profileValueFromRecord(platformMetadata, ["avatarUrl", "avatar"]) ??
				fallbackAvatarUrl,
		});
	}

	return Array.from(profiles.values()).sort((left, right) =>
		left.source.localeCompare(right.source),
	);
}

function buildEntityContext(
	entityId: UUID,
	entity: Entity | null,
	contact: RelationshipsContactLike | null,
): EntityContext {
	const mergedHandles = new Map<string, RelationshipsIdentityHandle>();
	for (const handle of [
		...collectIdentityHandles(entityId, entity),
		...extractContactIdentityHandles(entityId, contact?.customFields),
	]) {
		mergedHandles.set(normalizedIdentityKey(handle.platform, handle.handle), {
			...handle,
			platform: normalizePlatform(handle.platform),
		});
	}
	const handles = Array.from(mergedHandles.values());
	const emails = handles
		.filter((handle) => handle.platform === "email")
		.map((handle) => handle.handle);
	const phones = handles
		.filter((handle) => handle.platform === "phone")
		.map((handle) => handle.handle);
	const websites = handles
		.filter((handle) => handle.platform === "website")
		.map((handle) => handle.handle);

	const customFields = contact?.customFields;
	for (const email of extractCustomFieldStrings(customFields, [
		"email",
		"emails",
		"emailAddress",
	])) {
		pushUnique(emails, email);
	}
	for (const phone of extractCustomFieldStrings(customFields, [
		"phone",
		"phones",
		"phoneNumber",
	])) {
		pushUnique(phones, phone);
	}
	for (const website of extractCustomFieldStrings(customFields, [
		"website",
		"websites",
		"url",
	])) {
		pushUnique(websites, website);
	}

	const profiles = collectEntityProfiles(entityId, entity, handles);

	return {
		entityId,
		entity,
		contact,
		handles,
		profiles,
		platforms: uniqueSorted(handles.map((handle) => handle.platform)),
		emails: uniqueSorted(emails),
		phones: uniqueSorted(phones),
		websites: uniqueSorted(websites),
	};
}

async function collectWorkspaceEntityIds(
	runtime: IAgentRuntime,
	relationshipsService: RelationshipsServiceLike,
	rooms: Room[],
): Promise<UUID[]> {
	const entityIds = new Set<UUID>();

	if (typeof relationshipsService.searchContacts === "function") {
		const contacts = await relationshipsService.searchContacts({});
		for (const contact of contacts) {
			if (contact?.entityId && contact.entityId !== runtime.agentId) {
				entityIds.add(contact.entityId);
			}
		}
	}

	if (rooms.length > 0) {
		const roomEntities = await Promise.all(
			rooms.map((room) => runtime.getEntitiesForRoom(room.id).catch(() => [])),
		);
		for (const entities of roomEntities) {
			for (const entity of entities) {
				if (entity.id && entity.id !== runtime.agentId) {
					entityIds.add(entity.id);
				}
			}
		}
	}

	if (entityIds.size > 0) {
		const relationships = await runtime.getRelationships({
			entityIds: Array.from(entityIds),
			limit: 10000,
		});
		for (const relationship of relationships) {
			if (relationship.sourceEntityId !== runtime.agentId) {
				entityIds.add(relationship.sourceEntityId);
			}
			if (relationship.targetEntityId !== runtime.agentId) {
				entityIds.add(relationship.targetEntityId);
			}
		}
	}

	return Array.from(entityIds);
}

async function getWorkspaceRooms(runtime: IAgentRuntime): Promise<Room[]> {
	const worlds = await runtime.getAllWorlds();
	if (worlds.length === 0) {
		return [];
	}
	return runtime.getRoomsByWorlds(
		worlds.map((world) => world.id),
		5000,
	);
}

function buildClusters(
	entityIds: UUID[],
	relationships: Relationship[],
	contexts: Map<UUID, EntityContext>,
	ownerEntityId?: UUID | null,
): ClusterRecord[] {
	const parent = new Map<UUID, UUID>();
	for (const entityId of entityIds) {
		parent.set(entityId, entityId);
	}

	const find = (entityId: UUID): UUID => {
		const current = parent.get(entityId) ?? entityId;
		if (current === entityId) {
			return current;
		}
		const root = find(current);
		parent.set(entityId, root);
		return root;
	};

	const union = (left: UUID, right: UUID) => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) {
			parent.set(rightRoot, leftRoot);
		}
	};

	for (const relationship of relationships) {
		if (
			isConfirmedIdentityLink(relationship) &&
			parent.has(relationship.sourceEntityId) &&
			parent.has(relationship.targetEntityId)
		) {
			union(relationship.sourceEntityId, relationship.targetEntityId);
		}
	}

	const entityIdsByHandle = new Map<string, Set<UUID>>();
	for (const entityId of entityIds) {
		const context = contexts.get(entityId);
		if (!context) {
			continue;
		}
		for (const handle of context.handles) {
			if (CONTACT_PLATFORM_SET.has(handle.platform)) {
				continue;
			}
			const key = normalizedIdentityKey(handle.platform, handle.handle);
			const members = entityIdsByHandle.get(key) ?? new Set<UUID>();
			members.add(entityId);
			entityIdsByHandle.set(key, members);
		}
	}

	for (const members of entityIdsByHandle.values()) {
		const ids = Array.from(members.values());
		if (ids.length < 2) {
			continue;
		}
		const anchor = ids[0];
		if (!anchor) {
			continue;
		}
		for (const entityId of ids.slice(1)) {
			union(anchor, entityId);
		}
	}

	const grouped = new Map<UUID, UUID[]>();
	for (const entityId of entityIds) {
		const root = find(entityId);
		if (!grouped.has(root)) {
			grouped.set(root, []);
		}
		grouped.get(root)?.push(entityId);
	}

	const scoreEntity = (entityId: UUID): number => {
		const context = contexts.get(entityId);
		if (!context) {
			return 0;
		}
		return (
			(entityNames(context.entity).length > 0 ? 4 : 0) +
			context.handles.length * 2 +
			context.platforms.length +
			(context.contact ? 3 : 0) +
			context.emails.length +
			context.phones.length +
			context.websites.length
		);
	};

	const clusters: ClusterRecord[] = [];
	for (const memberEntityIds of grouped.values()) {
		const sortedMembers = [...memberEntityIds].sort((left, right) => {
			if (ownerEntityId) {
				if (left === ownerEntityId) {
					return -1;
				}
				if (right === ownerEntityId) {
					return 1;
				}
			}
			const scoreDiff = scoreEntity(right) - scoreEntity(left);
			if (scoreDiff !== 0) {
				return scoreDiff;
			}
			const leftLabel =
				entityNames(contexts.get(left)?.entity ?? null)[0] ?? left;
			const rightLabel =
				entityNames(contexts.get(right)?.entity ?? null)[0] ?? right;
			return leftLabel.localeCompare(rightLabel);
		});
		const primaryEntityId = sortedMembers[0];
		if (!primaryEntityId) {
			continue;
		}
		clusters.push({
			groupId: primaryEntityId,
			primaryEntityId,
			memberEntityIds: sortedMembers,
		});
	}
	return clusters;
}

async function countFacts(
	runtime: IAgentRuntime,
	entityIds: UUID[],
): Promise<Map<UUID, number>> {
	const counts = new Map<UUID, number>();
	await Promise.all(
		entityIds.map(async (entityId) => {
			const facts = await runtime.getMemories({
				tableName: "facts",
				entityId,
				limit: 500,
			});
			counts.set(entityId, facts.length);
		}),
	);
	return counts;
}

function buildSummaries(
	clusters: ClusterRecord[],
	contexts: Map<UUID, EntityContext>,
	factCounts: Map<UUID, number>,
	ownerInfo: {
		ownerEntityId: UUID | null;
		cloudUserId: string | null;
		configuredOwnerName: string | null;
	},
): RelationshipsPersonSummary[] {
	return clusters.map((cluster) => {
		const identities: RelationshipsIdentitySummary[] = [];
		const aliases = new Set<string>();
		const platforms = new Set<string>();
		const emails = new Set<string>();
		const phones = new Set<string>();
		const websites = new Set<string>();
		const categories = new Set<string>();
		const tags = new Set<string>();
		const profiles = new Map<string, RelationshipsProfile>();
		let preferredCommunicationChannel: string | null = null;
		let lastInteractionAt: string | undefined;
		let factCount = 0;
		const isOwner =
			typeof ownerInfo.ownerEntityId === "string" &&
			cluster.memberEntityIds.includes(ownerInfo.ownerEntityId);

		for (const memberEntityId of cluster.memberEntityIds) {
			const context = contexts.get(memberEntityId);
			if (!context) {
				continue;
			}
			const names = entityNames(context.entity);
			for (const name of names) {
				aliases.add(name);
			}
			for (const alias of extractContactAliases(
				context.contact?.customFields,
			)) {
				aliases.add(alias);
			}
			for (const platform of context.platforms) {
				platforms.add(platform);
			}
			for (const email of context.emails) {
				emails.add(email);
			}
			for (const phone of context.phones) {
				phones.add(phone);
			}
			for (const website of context.websites) {
				websites.add(website);
			}
			for (const category of context.contact?.categories ?? []) {
				categories.add(category);
			}
			for (const tag of context.contact?.tags ?? []) {
				tags.add(tag);
			}
			for (const profile of context.profiles) {
				upsertProfile(profiles, profile);
			}
			factCount += factCounts.get(memberEntityId) ?? 0;
			preferredCommunicationChannel =
				preferredCommunicationChannel ??
				asString(context.contact?.preferences?.preferredCommunicationChannel);
			lastInteractionAt = laterIso(
				lastInteractionAt,
				asString(context.contact?.lastModified) ?? undefined,
			);

			identities.push({
				entityId: memberEntityId,
				names,
				platforms: context.platforms,
				handles: context.handles.filter(
					(handle) => !CONTACT_PLATFORM_SET.has(handle.platform),
				),
			});
		}

		const primaryContext = contexts.get(cluster.primaryEntityId);
		const fallbackDisplayName =
			preferredContactLabel(primaryContext?.contact ?? null) ??
			entityNames(primaryContext?.entity ?? null)[0] ??
			identities.find((identity) => identity.names[0])?.names[0] ??
			identities.find((identity) => identity.handles[0])?.handles[0]?.handle ??
			emails.values().next().value ??
			cluster.primaryEntityId;
		const displayName =
			isOwner && ownerInfo.configuredOwnerName
				? ownerInfo.configuredOwnerName
				: fallbackDisplayName;

		aliases.delete(displayName);

		if (isOwner && ownerInfo.ownerEntityId) {
			upsertProfile(profiles, {
				entityId: ownerInfo.ownerEntityId,
				source: "client_chat",
				userId: ownerInfo.ownerEntityId,
				displayName,
				canonical: true,
			});
			if (ownerInfo.cloudUserId) {
				upsertProfile(profiles, {
					entityId: ownerInfo.ownerEntityId,
					source: "elizacloud",
					userId: ownerInfo.cloudUserId,
					displayName,
					canonical: true,
				});
			}
		}

		const sortedProfiles = Array.from(profiles.values()).sort((left, right) => {
			if ((left.canonical ?? false) !== (right.canonical ?? false)) {
				return left.canonical ? -1 : 1;
			}
			return preferredProfileHandle(left).localeCompare(
				preferredProfileHandle(right),
			);
		});
		for (const profile of sortedProfiles) {
			platforms.add(normalizeProfileSource(profile.source));
		}

		return {
			groupId: cluster.groupId,
			primaryEntityId: cluster.primaryEntityId,
			memberEntityIds: cluster.memberEntityIds,
			displayName,
			aliases: uniqueSorted(aliases),
			platforms: uniqueSorted(platforms),
			identities,
			emails: uniqueSorted(emails),
			phones: uniqueSorted(phones),
			websites: uniqueSorted(websites),
			preferredCommunicationChannel,
			categories: uniqueSorted(categories),
			tags: uniqueSorted(tags),
			factCount,
			relationshipCount: 0,
			isOwner,
			profiles: sortedProfiles,
			lastInteractionAt,
		};
	});
}

function graphEdgeKey(sourcePersonId: UUID, targetPersonId: UUID): string {
	return sourcePersonId.localeCompare(targetPersonId) <= 0
		? `${sourcePersonId}:${targetPersonId}`
		: `${targetPersonId}:${sourcePersonId}`;
}

function upsertGraphEdgeAccumulator(
	map: Map<string, GraphEdgeAccumulator>,
	sourcePersonId: UUID,
	targetPersonId: UUID,
): GraphEdgeAccumulator {
	const [orderedSource, orderedTarget] =
		sourcePersonId.localeCompare(targetPersonId) <= 0
			? [sourcePersonId, targetPersonId]
			: [targetPersonId, sourcePersonId];
	const key = graphEdgeKey(orderedSource, orderedTarget);
	const existing = map.get(key);
	if (existing) {
		return existing;
	}
	const created: GraphEdgeAccumulator = {
		sourcePersonId: orderedSource,
		targetPersonId: orderedTarget,
		relationshipTypes: new Set<string>(),
		sentimentCounts: {},
		strengthTotal: 0,
		strengthWeight: 0,
		interactionCount: 0,
		rawRelationshipIds: new Set<string>(),
	};
	map.set(key, created);
	return created;
}

function addGraphEdgeSample(
	map: Map<string, GraphEdgeAccumulator>,
	sample: GraphEdgeSample,
): void {
	if (sample.sourcePersonId === sample.targetPersonId) {
		return;
	}
	const accumulator = upsertGraphEdgeAccumulator(
		map,
		sample.sourcePersonId,
		sample.targetPersonId,
	);
	for (const relationshipType of sample.relationshipTypes) {
		accumulator.relationshipTypes.add(relationshipType);
	}
	accumulator.sentimentCounts[sample.sentiment] =
		(accumulator.sentimentCounts[sample.sentiment] ?? 0) + 1;
	const weight = Math.max(1, sample.strengthWeight ?? 1);
	accumulator.strengthTotal += sample.strength * weight;
	accumulator.strengthWeight += weight;
	accumulator.interactionCount += sample.interactionCount;
	accumulator.lastInteractionAt = laterIso(
		accumulator.lastInteractionAt,
		sample.lastInteractionAt,
	);
	for (const rawRelationshipId of sample.rawRelationshipIds) {
		accumulator.rawRelationshipIds.add(rawRelationshipId);
	}
}

function finalizeGraphEdges(
	accumulators: Iterable<GraphEdgeAccumulator>,
	peopleByGroupId: Map<UUID, RelationshipsPersonSummary>,
): RelationshipsGraphEdge[] {
	return Array.from(accumulators).map((accumulator) => {
		const dominantSentiment =
			Object.entries(accumulator.sentimentCounts).sort(
				(left, right) => right[1] - left[1],
			)[0]?.[0] ?? "neutral";
		return {
			id: graphEdgeKey(accumulator.sourcePersonId, accumulator.targetPersonId),
			sourcePersonId: accumulator.sourcePersonId,
			targetPersonId: accumulator.targetPersonId,
			sourcePersonName:
				peopleByGroupId.get(accumulator.sourcePersonId)?.displayName ??
				accumulator.sourcePersonId,
			targetPersonName:
				peopleByGroupId.get(accumulator.targetPersonId)?.displayName ??
				accumulator.targetPersonId,
			relationshipTypes: Array.from(accumulator.relationshipTypes),
			sentiment: dominantSentiment,
			strength:
				accumulator.strengthWeight > 0
					? accumulator.strengthTotal / accumulator.strengthWeight
					: 0.5,
			interactionCount: accumulator.interactionCount,
			lastInteractionAt: accumulator.lastInteractionAt,
			rawRelationshipIds: Array.from(accumulator.rawRelationshipIds),
		};
	});
}

function buildRelationshipEdgeMap(
	relationships: Relationship[],
	clusterByEntityId: Map<UUID, ClusterRecord>,
): Map<string, GraphEdgeAccumulator> {
	const edges = new Map<string, GraphEdgeAccumulator>();
	for (const relationship of relationships) {
		if (isIdentityLink(relationship)) {
			continue;
		}

		const sourceCluster = clusterByEntityId.get(relationship.sourceEntityId);
		const targetCluster = clusterByEntityId.get(relationship.targetEntityId);
		if (
			!sourceCluster ||
			!targetCluster ||
			sourceCluster.groupId === targetCluster.groupId
		) {
			continue;
		}
		addGraphEdgeSample(edges, {
			sourcePersonId: sourceCluster.groupId,
			targetPersonId: targetCluster.groupId,
			relationshipTypes: relationshipTypes(relationship),
			sentiment: relationshipSentiment(relationship),
			strength: relationshipStrength(relationship),
			interactionCount: relationshipInteractionCount(relationship),
			lastInteractionAt: relationshipLastInteractionAt(relationship),
			rawRelationshipIds: relationship.id ? [relationship.id] : [],
		});
	}
	return edges;
}

async function buildConversationEdgeMap(
	runtime: IAgentRuntime,
	rooms: Room[],
	clusterByEntityId: Map<UUID, ClusterRecord>,
): Promise<ConversationGraphBuildResult> {
	const edges = new Map<string, GraphEdgeAccumulator>();
	const messageCountsByGroupId = new Map<UUID, number>();
	const batchSize = 24;

	for (let index = 0; index < rooms.length; index += batchSize) {
		const roomBatch = rooms.slice(index, index + batchSize);
		await Promise.all(
			roomBatch.map(async (room) => {
				const messages = await runtime.getMemories({
					tableName: "messages",
					roomId: room.id,
					limit: 80,
				});
				if (messages.length < 2) {
					return;
				}

				const relevantMessages = [...messages]
					.filter(
						(message) =>
							typeof message.entityId === "string" &&
							clusterByEntityId.has(message.entityId),
					)
					.sort(
						(left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
					);
				if (relevantMessages.length < 2) {
					return;
				}

				const messageClusterById = new Map<UUID, UUID>();
				const activeClusterIds = new Set<UUID>();
				for (const message of relevantMessages) {
					if (!message.entityId) {
						continue;
					}
					const cluster = clusterByEntityId.get(message.entityId);
					if (!cluster) {
						continue;
					}
					activeClusterIds.add(cluster.groupId);
					messageCountsByGroupId.set(
						cluster.groupId,
						(messageCountsByGroupId.get(cluster.groupId) ?? 0) + 1,
					);
					if (message.id) {
						messageClusterById.set(message.id, cluster.groupId);
					}
				}
				if (activeClusterIds.size < 2) {
					return;
				}

				const pairStats = new Map<
					string,
					{
						sourcePersonId: UUID;
						targetPersonId: UUID;
						adjacencyCount: number;
						replyCount: number;
						lastInteractionAt?: string;
					}
				>();

				const touchPair = (
					left: UUID,
					right: UUID,
					kind: "adjacent" | "reply",
					lastInteractionAt?: string,
				) => {
					if (left === right) {
						return;
					}
					const [sourcePersonId, targetPersonId] =
						left.localeCompare(right) <= 0 ? [left, right] : [right, left];
					const key = graphEdgeKey(sourcePersonId, targetPersonId);
					if (!pairStats.has(key)) {
						pairStats.set(key, {
							sourcePersonId,
							targetPersonId,
							adjacencyCount: 0,
							replyCount: 0,
						});
					}
					const entry = pairStats.get(key);
					if (!entry) {
						return;
					}
					if (kind === "reply") {
						entry.replyCount += 1;
					} else {
						entry.adjacencyCount += 1;
					}
					entry.lastInteractionAt = laterIso(
						entry.lastInteractionAt,
						lastInteractionAt,
					);
				};

				for (
					let messageIndex = 1;
					messageIndex < relevantMessages.length;
					messageIndex += 1
				) {
					const previousMessage = relevantMessages[messageIndex - 1];
					const currentMessage = relevantMessages[messageIndex];
					if (
						!previousMessage ||
						!currentMessage ||
						!previousMessage.entityId ||
						!currentMessage.entityId
					) {
						continue;
					}
					const previousCluster = clusterByEntityId.get(
						previousMessage.entityId,
					);
					const currentCluster = clusterByEntityId.get(currentMessage.entityId);
					if (!previousCluster || !currentCluster) {
						continue;
					}
					touchPair(
						previousCluster.groupId,
						currentCluster.groupId,
						"adjacent",
						isoFromTimestamp(currentMessage.createdAt),
					);
				}

				for (const message of relevantMessages) {
					if (!message.entityId || !message.content.inReplyTo) {
						continue;
					}
					const sourceCluster = clusterByEntityId.get(message.entityId);
					const targetCluster = messageClusterById.get(
						message.content.inReplyTo,
					);
					if (!sourceCluster || !targetCluster) {
						continue;
					}
					touchPair(
						sourceCluster.groupId,
						targetCluster,
						"reply",
						isoFromTimestamp(message.createdAt),
					);
				}

				const roomType = normalizeRoomType(room);
				const roomRelationshipTypes =
					activeClusterIds.size <= 2 ||
					roomType === "dm" ||
					roomType === "direct" ||
					roomType === "private"
						? ["conversation", "direct_exchange"]
						: ["conversation", "shared_room"];

				for (const pair of pairStats.values()) {
					const interactionCount = pair.adjacencyCount + pair.replyCount * 2;
					if (interactionCount <= 0) {
						continue;
					}
					const strength = Math.min(
						1,
						0.16 +
							Math.log1p(interactionCount) / 3.2 +
							(pair.replyCount > 0 ? 0.08 : 0) +
							(roomRelationshipTypes.includes("direct_exchange") ? 0.06 : 0),
					);
					addGraphEdgeSample(edges, {
						sourcePersonId: pair.sourcePersonId,
						targetPersonId: pair.targetPersonId,
						relationshipTypes: roomRelationshipTypes,
						sentiment: "neutral",
						strength,
						strengthWeight: Math.max(1, interactionCount),
						interactionCount,
						lastInteractionAt: pair.lastInteractionAt,
						rawRelationshipIds: [`room:${room.id}`],
					});
				}
			}),
		);
	}

	return {
		edgeMap: edges,
		messageCountsByGroupId,
	};
}

function countRelationshipIndicators(
	edges: RelationshipsGraphEdge[],
): Map<UUID, number> {
	const counts = new Map<UUID, number>();
	for (const edge of edges) {
		counts.set(edge.sourcePersonId, (counts.get(edge.sourcePersonId) ?? 0) + 1);
		counts.set(edge.targetPersonId, (counts.get(edge.targetPersonId) ?? 0) + 1);
	}
	return counts;
}

function isMeaningfulRelationshipIndicator(
	edge: RelationshipsGraphEdge,
): boolean {
	const sharedRoomOnly =
		edge.relationshipTypes.includes("shared_room") &&
		!edge.relationshipTypes.includes("direct_exchange") &&
		edge.relationshipTypes.every(
			(relationshipType) =>
				relationshipType === "conversation" ||
				relationshipType === "shared_room",
		);

	return !sharedRoomOnly || edge.interactionCount > 1;
}

function filterGraphByRelevance(
	summaries: RelationshipsPersonSummary[],
	edges: RelationshipsGraphEdge[],
	messageCountsByGroupId: Map<UUID, number>,
): {
	summaries: RelationshipsPersonSummary[];
	edges: RelationshipsGraphEdge[];
	visibleGroupIds: Set<UUID>;
} {
	const ownerGroupIds = new Set(
		summaries
			.filter((summary) => summary.isOwner)
			.map((summary) => summary.groupId),
	);
	const activePosterGroupIds = new Set(
		summaries
			.filter(
				(summary) => (messageCountsByGroupId.get(summary.groupId) ?? 0) > 0,
			)
			.map((summary) => summary.groupId),
	);
	if (activePosterGroupIds.size === 0) {
		if (ownerGroupIds.size > 0) {
			return {
				summaries: summaries.filter((summary) =>
					ownerGroupIds.has(summary.groupId),
				),
				edges: [],
				visibleGroupIds: ownerGroupIds,
			};
		}

		return {
			summaries: [],
			edges: [],
			visibleGroupIds: new Set(),
		};
	}

	// Keep only people who have actually spoken and are connected to another
	// active poster through an explicit or conversation-derived edge.
	const messageBackedEdges = edges.filter(
		(edge) =>
			activePosterGroupIds.has(edge.sourcePersonId) &&
			activePosterGroupIds.has(edge.targetPersonId),
	);
	const meaningfulEdges = messageBackedEdges.filter(
		isMeaningfulRelationshipIndicator,
	);
	const relationshipIndicatorCounts =
		countRelationshipIndicators(meaningfulEdges);
	const visibleGroupIds = new Set(
		summaries
			.filter(
				(summary) =>
					ownerGroupIds.has(summary.groupId) ||
					(activePosterGroupIds.has(summary.groupId) &&
						(relationshipIndicatorCounts.get(summary.groupId) ?? 0) > 0),
			)
			.map((summary) => summary.groupId),
	);

	return {
		summaries: summaries.filter((summary) =>
			visibleGroupIds.has(summary.groupId),
		),
		edges: meaningfulEdges.filter(
			(edge) =>
				visibleGroupIds.has(edge.sourcePersonId) &&
				visibleGroupIds.has(edge.targetPersonId),
		),
		visibleGroupIds,
	};
}

function graphViewForScope(
	summaries: RelationshipsPersonSummary[],
	edges: RelationshipsGraphEdge[],
	messageCountsByGroupId: Map<UUID, number>,
	scope: RelationshipsGraphQuery["scope"],
): {
	summaries: RelationshipsPersonSummary[];
	edges: RelationshipsGraphEdge[];
	visibleGroupIds: Set<UUID>;
} {
	if (scope === "relevant") {
		return filterGraphByRelevance(summaries, edges, messageCountsByGroupId);
	}

	return {
		summaries,
		edges,
		visibleGroupIds: new Set(summaries.map((summary) => summary.groupId)),
	};
}

function matchesQuery(
	summary: RelationshipsPersonSummary,
	query: RelationshipsGraphQuery,
): boolean {
	const platform = asString(query.platform);
	if (platform && !summary.platforms.includes(platform)) {
		return false;
	}

	const search = asString(query.search)?.toLowerCase();
	if (!search) {
		return true;
	}

	const haystack = [
		summary.displayName,
		summary.primaryEntityId,
		...summary.memberEntityIds,
		...summary.aliases,
		...summary.platforms,
		...summary.emails,
		...summary.phones,
		...summary.websites,
		...(summary.isOwner ? ["owner", "canonical owner"] : []),
		...summary.identities.flatMap((identity) =>
			identity.handles.map((handle) => handle.handle),
		),
		...summary.profiles.flatMap((profile) => [
			profile.source,
			profile.handle ?? "",
			profile.userId ?? "",
			profile.displayName ?? "",
		]),
	]
		.join("\n")
		.toLowerCase();

	return haystack.includes(search);
}

function applyRelationshipCounts(
	summaries: RelationshipsPersonSummary[],
	edges: RelationshipsGraphEdge[],
): RelationshipsPersonSummary[] {
	const counts = new Map<UUID, number>();
	const lastInteraction = new Map<UUID, string | undefined>();

	for (const edge of edges) {
		counts.set(edge.sourcePersonId, (counts.get(edge.sourcePersonId) ?? 0) + 1);
		counts.set(edge.targetPersonId, (counts.get(edge.targetPersonId) ?? 0) + 1);
		lastInteraction.set(
			edge.sourcePersonId,
			laterIso(
				lastInteraction.get(edge.sourcePersonId),
				edge.lastInteractionAt,
			),
		);
		lastInteraction.set(
			edge.targetPersonId,
			laterIso(
				lastInteraction.get(edge.targetPersonId),
				edge.lastInteractionAt,
			),
		);
	}

	return summaries.map((summary) => ({
		...summary,
		relationshipCount: counts.get(summary.groupId) ?? 0,
		lastInteractionAt: laterIso(
			summary.lastInteractionAt,
			lastInteraction.get(summary.groupId),
		),
	}));
}

async function buildFacts(
	runtime: IAgentRuntime,
	contexts: Map<UUID, EntityContext>,
	memberEntityIds: UUID[],
): Promise<RelationshipsPersonFact[]> {
	const factGroups = await Promise.all(
		memberEntityIds.map(async (entityId) => {
			const context = contexts.get(entityId);
			if (!context) {
				return [];
			}

			const facts: RelationshipsPersonFact[] = [];
			for (const email of context.emails) {
				facts.push({
					id: `${entityId}:contact:email:${email}`,
					sourceType: "contact",
					field: "email",
					value: email,
					text: `Email: ${email}`,
					updatedAt: asString(context.contact?.lastModified) ?? undefined,
				});
			}
			for (const phone of context.phones) {
				facts.push({
					id: `${entityId}:contact:phone:${phone}`,
					sourceType: "contact",
					field: "phone",
					value: phone,
					text: `Phone: ${phone}`,
					updatedAt: asString(context.contact?.lastModified) ?? undefined,
				});
			}
			for (const website of context.websites) {
				facts.push({
					id: `${entityId}:contact:website:${website}`,
					sourceType: "contact",
					field: "website",
					value: website,
					text: `Website: ${website}`,
					updatedAt: asString(context.contact?.lastModified) ?? undefined,
				});
			}

			const memories = await runtime.getMemories({
				tableName: "facts",
				entityId,
				limit: 100,
			});
			for (const memory of memories) {
				const metadata = asRecord(memory.metadata) ?? {};
				const provenance = factProvenanceFromMetadata(metadata);
				const extractedInformation =
					factExtractedInformationFromMetadata(metadata);
				const evidenceMessageIds =
					provenance && provenance.evidenceMessageIds.length > 0
						? provenance.evidenceMessageIds
						: undefined;
				facts.push({
					id: memory.id ?? `${entityId}:fact:${facts.length}`,
					sourceType: "memory",
					text: memoryText(memory) ?? "",
					scope: extractedInformation?.scope,
					confidence: asNumber(metadata?.confidence) ?? undefined,
					updatedAt: isoFromTimestamp(memory.createdAt),
					lastReinforced: provenance?.lastReinforced,
					evidenceMessageIds,
					provenance,
					extractedInformation,
				});
			}

			return facts;
		}),
	);
	const facts = factGroups.flat();

	return facts.sort((left, right) => {
		const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
		const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
		return rightTime - leftTime;
	});
}

async function buildRecentConversations(
	runtime: IAgentRuntime,
	memberEntityIds: UUID[],
	contexts: Map<UUID, EntityContext>,
): Promise<RelationshipsConversationSnippet[]> {
	const roomIds = Array.from(
		new Set(await runtime.getRoomsForParticipants(memberEntityIds)),
	);
	const rooms = roomIds.length > 0 ? await runtime.getRoomsByIds(roomIds) : [];
	const roomNameById = new Map(rooms.map((room) => [room.id, room.name]));
	const entityNameCache = new Map<UUID, string>();

	const resolveSpeaker = async (entityId?: UUID): Promise<string> => {
		if (!entityId) {
			return "Unknown";
		}
		if (entityNameCache.has(entityId)) {
			return entityNameCache.get(entityId) ?? entityId;
		}
		const context = contexts.get(entityId);
		if (context) {
			const name =
				entityNames(context.entity)[0] ??
				context.handles[0]?.handle ??
				context.entityId;
			entityNameCache.set(entityId, name);
			return name;
		}
		const entity = await runtime.getEntityById(entityId);
		const name = entityNames(entity)[0] ?? entityId;
		entityNameCache.set(entityId, name);
		return name;
	};

	const snippets = await Promise.all(
		roomIds.map(
			async (roomId): Promise<RelationshipsConversationSnippet | null> => {
				const messages = await runtime.getMemories({
					tableName: "messages",
					roomId,
					limit: 6,
				});
				if (messages.length === 0) {
					return null;
				}
				const sortedMessages = [...messages].sort(
					(left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
				);
				const snippetMessages = await Promise.all(
					sortedMessages.slice(-3).map(async (message) => ({
						id: message.id ?? `${roomId}:${message.createdAt ?? 0}`,
						entityId: message.entityId,
						speaker: await resolveSpeaker(message.entityId),
						text: asString(message.content.text) ?? "",
						createdAt: message.createdAt,
					})),
				);
				const latest = sortedMessages[sortedMessages.length - 1];
				return {
					roomId,
					roomName: roomNameById.get(roomId) ?? roomId,
					lastActivityAt: isoFromTimestamp(latest?.createdAt),
					messages: snippetMessages,
				} satisfies RelationshipsConversationSnippet;
			},
		),
	);

	return snippets
		.filter(
			(snippet): snippet is RelationshipsConversationSnippet =>
				snippet !== null,
		)
		.sort((left, right) => {
			const rightTime = right.lastActivityAt
				? Date.parse(right.lastActivityAt)
				: 0;
			const leftTime = left.lastActivityAt
				? Date.parse(left.lastActivityAt)
				: 0;
			return rightTime - leftTime;
		})
		.slice(0, 5);
}

async function buildRelevantMemories(
	runtime: IAgentRuntime,
	memberEntityIds: UUID[],
	contexts: Map<UUID, EntityContext>,
	fallbackSpeaker: string,
): Promise<RelationshipsRelevantMemory[]> {
	if (memberEntityIds.length === 0) {
		return [];
	}

	const limitPerEntity = Math.max(
		6,
		Math.ceil(PERSON_RELEVANT_MEMORIES_LIMIT / memberEntityIds.length),
	);
	const batches = await Promise.all(
		memberEntityIds.map((entityId) =>
			runtime.getMemories({
				tableName: "messages",
				entityId,
				limit: limitPerEntity,
				orderBy: "createdAt",
				orderDirection: "desc",
			}),
		),
	);
	const recentMessages = dedupeMemoriesById(batches.flat()).filter((memory) =>
		Boolean(memoryText(memory)),
	);
	const roomIds = Array.from(
		new Set(
			recentMessages
				.map((memory) => memory.roomId)
				.filter((roomId): roomId is UUID => typeof roomId === "string"),
		),
	);
	const rooms = roomIds.length > 0 ? await runtime.getRoomsByIds(roomIds) : [];
	const roomNameById = new Map(rooms.map((room) => [room.id, room.name]));

	return recentMessages
		.map((memory) => {
			const entityId =
				typeof memory.entityId === "string" ? memory.entityId : undefined;
			const context = entityId ? contexts.get(entityId) : null;
			const speaker =
				entityId &&
				(entityNames(context?.entity ?? null)[0] ??
					context?.handles[0]?.handle ??
					entityId);

			return {
				id:
					memory.id ??
					`${entityId ?? "unknown"}:${memory.roomId ?? "room"}:${memory.createdAt ?? 0}`,
				sourceType: "message",
				entityId,
				roomId: typeof memory.roomId === "string" ? memory.roomId : undefined,
				roomName:
					typeof memory.roomId === "string"
						? (roomNameById.get(memory.roomId) ?? null)
						: null,
				speaker: speaker ?? fallbackSpeaker,
				text: memoryText(memory) ?? "",
				createdAt: isoFromTimestamp(memory.createdAt),
				source: memorySource(memory),
			} satisfies RelationshipsRelevantMemory;
		})
		.sort((left, right) => {
			const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
			const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
			return rightTime - leftTime;
		})
		.slice(0, PERSON_RELEVANT_MEMORIES_LIMIT);
}

async function buildUserPersonalityPreferences(
	runtime: IAgentRuntime,
	memberEntityIds: UUID[],
): Promise<RelationshipsUserPersonalityPreference[]> {
	if (memberEntityIds.length === 0) {
		return [];
	}

	const batches = await Promise.all(
		memberEntityIds.map((entityId) =>
			runtime.getMemories({
				tableName: USER_PERSONALITY_PREFERENCES_TABLE,
				entityId,
				roomId: runtime.agentId,
				limit: USER_PERSONALITY_PREFERENCES_LIMIT,
				orderBy: "createdAt",
				orderDirection: "desc",
			}),
		),
	);
	const preferences: RelationshipsUserPersonalityPreference[] = [];
	const seen = new Set<string>();

	for (const memory of batches.flat()) {
		const entityId =
			typeof memory.entityId === "string" ? memory.entityId : null;
		const text = memoryText(memory);
		if (!entityId || !text) {
			continue;
		}
		const metadata = asRecord(memory.metadata) ?? {};
		const key = `${text.toLowerCase()}:${asString(metadata.category) ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		preferences.push({
			id: memory.id ?? `${entityId}:preference:${preferences.length}`,
			entityId,
			text,
			category: asString(metadata.category) ?? undefined,
			originalRequest: asString(metadata.originalRequest) ?? undefined,
			source: memorySource(memory),
			createdAt: isoFromTimestamp(memory.createdAt),
		});
	}

	return preferences.sort((left, right) => {
		const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
		const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
		return rightTime - leftTime;
	});
}

async function buildGraphModel(
	runtime: IAgentRuntime,
	relationshipsService: RelationshipsServiceLike,
	resolvers: GraphResolvers,
): Promise<{
	summaries: RelationshipsPersonSummary[];
	edges: RelationshipsGraphEdge[];
	clusters: Map<UUID, ClusterRecord>;
	contexts: Map<UUID, EntityContext>;
	identityRelationships: Relationship[];
	messageCountsByGroupId: Map<UUID, number>;
}> {
	const rooms = await getWorkspaceRooms(runtime);
	const entityIds = await collectWorkspaceEntityIds(
		runtime,
		relationshipsService,
		rooms,
	);
	const ownerEntityId = (await resolvers
		.resolveOwnerEntityId(runtime)
		.catch(() => null)) as UUID | null;
	const cloudAuth = runtime.getService("CLOUD_AUTH") as {
		getUserId?: () => string | undefined;
	} | null;
	const cloudUserId = asString(cloudAuth?.getUserId?.()) ?? null;
	const configuredOwnerName = await resolvers
		.fetchConfiguredOwnerName()
		.catch(() => null);
	const entityContexts = new Map<UUID, EntityContext>();

	await Promise.all(
		entityIds.map(async (entityId) => {
			const [entity, contact] = await Promise.all([
				runtime.getEntityById(entityId),
				typeof relationshipsService.getContact === "function"
					? relationshipsService.getContact(entityId)
					: Promise.resolve(null),
			]);
			entityContexts.set(
				entityId,
				buildEntityContext(entityId, entity, contact ?? null),
			);
		}),
	);

	const relationships =
		entityIds.length > 0
			? await runtime.getRelationships({ entityIds, limit: 10000 })
			: [];
	const factCounts = await countFacts(runtime, entityIds);
	const clustersList = buildClusters(
		entityIds,
		relationships,
		entityContexts,
		ownerEntityId,
	);
	const clusters = new Map(
		clustersList.map((cluster) => [cluster.groupId, cluster]),
	);
	const clusterByEntityId = new Map<UUID, ClusterRecord>();
	for (const cluster of clustersList) {
		for (const entityId of cluster.memberEntityIds) {
			clusterByEntityId.set(entityId, cluster);
		}
	}

	const summaries = buildSummaries(clustersList, entityContexts, factCounts, {
		ownerEntityId,
		cloudUserId,
		configuredOwnerName,
	});
	const peopleByGroupId = new Map(
		summaries.map((summary) => [summary.groupId, summary]),
	);
	const explicitEdgeMap = buildRelationshipEdgeMap(
		relationships,
		clusterByEntityId,
	);
	const conversationGraph = await buildConversationEdgeMap(
		runtime,
		rooms,
		clusterByEntityId,
	);
	for (const conversationEdge of conversationGraph.edgeMap.values()) {
		addGraphEdgeSample(explicitEdgeMap, {
			sourcePersonId: conversationEdge.sourcePersonId,
			targetPersonId: conversationEdge.targetPersonId,
			relationshipTypes: Array.from(conversationEdge.relationshipTypes),
			sentiment:
				Object.entries(conversationEdge.sentimentCounts).sort(
					(left, right) => right[1] - left[1],
				)[0]?.[0] ?? "neutral",
			strength:
				conversationEdge.strengthWeight > 0
					? conversationEdge.strengthTotal / conversationEdge.strengthWeight
					: 0.5,
			strengthWeight: conversationEdge.strengthWeight,
			interactionCount: conversationEdge.interactionCount,
			lastInteractionAt: conversationEdge.lastInteractionAt,
			rawRelationshipIds: Array.from(conversationEdge.rawRelationshipIds),
		});
	}
	const edges = finalizeGraphEdges(explicitEdgeMap.values(), peopleByGroupId);

	return {
		summaries,
		edges,
		clusters,
		contexts: entityContexts,
		identityRelationships: relationships.filter(isIdentityLink),
		messageCountsByGroupId: conversationGraph.messageCountsByGroupId,
	};
}

/** TTL cache for the expensive graph model build. */
const MODEL_CACHE_TTL_MS = 30_000; // 30 seconds

type CachedModel = Awaited<ReturnType<typeof buildGraphModel>>;
type ModelCache = { model: CachedModel; timestamp: number };

export interface GraphResolvers {
	resolveOwnerEntityId: (
		runtime: IAgentRuntime,
	) => Promise<UUID | string | null>;
	fetchConfiguredOwnerName: () => Promise<string | null>;
}

const DEFAULT_GRAPH_RESOLVERS: GraphResolvers = {
	resolveOwnerEntityId: async () => null,
	fetchConfiguredOwnerName: async () => null,
};

export function createNativeRelationshipsGraphService(
	runtime: IAgentRuntime,
	relationshipsService: RelationshipsServiceLike,
	resolvers: GraphResolvers = DEFAULT_GRAPH_RESOLVERS,
): RelationshipsGraphService {
	let modelCache: ModelCache | null = null;
	let modelBuildPromise: Promise<CachedModel> | null = null;

	async function getCachedModel(): Promise<CachedModel> {
		const now = Date.now();
		if (modelCache && now - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
			return modelCache.model;
		}
		// Deduplicate concurrent builds.
		if (!modelBuildPromise) {
			modelBuildPromise = buildGraphModel(
				runtime,
				relationshipsService,
				resolvers,
			)
				.then((model) => {
					modelCache = { model, timestamp: Date.now() };
					modelBuildPromise = null;
					return model;
				})
				.catch((err) => {
					modelBuildPromise = null;
					throw err;
				});
		}
		return modelBuildPromise;
	}

	function invalidateModelCache(): void {
		modelCache = null;
		modelBuildPromise = null;
	}

	function applyOwnerName(
		summaries: RelationshipsPersonSummary[],
		ownerName: string | null,
	): RelationshipsPersonSummary[] {
		if (!ownerName) return summaries;
		return summaries.map((summary) =>
			summary.isOwner ? { ...summary, displayName: ownerName } : summary,
		);
	}

	return {
		async getGraphSnapshot(query = {}): Promise<RelationshipsGraphSnapshot> {
			const [model, ownerName] = await Promise.all([
				getCachedModel(),
				resolvers.fetchConfiguredOwnerName().catch(() => null),
			]);
			const scopedGraph = graphViewForScope(
				model.summaries,
				model.edges,
				model.messageCountsByGroupId,
				query.scope,
			);
			const matchingSummaries = scopedGraph.summaries.filter((summary) =>
				matchesQuery(summary, query),
			);
			const matchingGroupIds = new Set(
				matchingSummaries.map((summary) => summary.groupId),
			);
			const filteredEdges = scopedGraph.edges.filter(
				(edge) =>
					matchingGroupIds.has(edge.sourcePersonId) &&
					matchingGroupIds.has(edge.targetPersonId),
			);
			const decoratedSummaries = applyOwnerName(
				applyRelationshipCounts(matchingSummaries, filteredEdges),
				ownerName,
			);
			const offset = Math.max(0, query.offset ?? 0);
			const limit =
				typeof query.limit === "number" && query.limit > 0
					? query.limit
					: decoratedSummaries.length;
			const visibleSummaries = decoratedSummaries.slice(offset, offset + limit);
			const visibleGroupIds = new Set(
				visibleSummaries.map((summary) => summary.groupId),
			);
			const visibleEdges = filteredEdges.filter(
				(edge) =>
					visibleGroupIds.has(edge.sourcePersonId) &&
					visibleGroupIds.has(edge.targetPersonId),
			);

			const candidateMerges = (
				typeof relationshipsService.getCandidateMerges === "function"
					? await relationshipsService.getCandidateMerges()
					: []
			) as RelationshipsMergeCandidate[];

			return {
				people: visibleSummaries,
				relationships: visibleEdges,
				stats: {
					totalPeople: decoratedSummaries.length,
					totalRelationships: filteredEdges.length,
					totalIdentities: decoratedSummaries.reduce(
						(sum, summary) => sum + summary.memberEntityIds.length,
						0,
					),
				},
				candidateMerges,
			};
		},

		async getPersonDetail(
			primaryEntityId: UUID,
		): Promise<RelationshipsPersonDetail | null> {
			const [model, ownerName] = await Promise.all([
				getCachedModel(),
				resolvers.fetchConfiguredOwnerName().catch(() => null),
			]);
			const cluster =
				Array.from(model.clusters.values()).find(
					(entry) =>
						entry.primaryEntityId === primaryEntityId ||
						entry.memberEntityIds.includes(primaryEntityId),
				) ?? null;
			if (!cluster) {
				return null;
			}

			const summary = applyOwnerName(
				applyRelationshipCounts(
					model.summaries.filter((entry) => entry.groupId === cluster.groupId),
					model.edges.filter(
						(edge) =>
							edge.sourcePersonId === cluster.groupId ||
							edge.targetPersonId === cluster.groupId,
					),
				),
				ownerName,
			)[0];
			if (!summary) {
				return null;
			}

			const memberSet = new Set(cluster.memberEntityIds);
			const identityEdges = model.identityRelationships
				.filter(
					(relationship) =>
						memberSet.has(relationship.sourceEntityId) &&
						memberSet.has(relationship.targetEntityId),
				)
				.map((relationship) => ({
					id:
						relationship.id ??
						`${relationship.sourceEntityId}:${relationship.targetEntityId}`,
					sourceEntityId: relationship.sourceEntityId,
					targetEntityId: relationship.targetEntityId,
					confidence: relationshipConfidence(relationship),
					status: relationshipStatus(relationship),
				}));

			const [
				facts,
				recentConversations,
				relevantMemories,
				userPersonalityPreferences,
			] = await Promise.all([
				buildFacts(runtime, model.contexts, cluster.memberEntityIds),
				buildRecentConversations(
					runtime,
					cluster.memberEntityIds,
					model.contexts,
				),
				buildRelevantMemories(
					runtime,
					cluster.memberEntityIds,
					model.contexts,
					summary.displayName,
				),
				buildUserPersonalityPreferences(runtime, cluster.memberEntityIds),
			]);

			return {
				...summary,
				facts,
				recentConversations,
				relevantMemories,
				relationships: model.edges
					.filter(
						(edge) =>
							edge.sourcePersonId === cluster.groupId ||
							edge.targetPersonId === cluster.groupId,
					)
					.sort((left, right) => right.strength - left.strength),
				identityEdges,
				userPersonalityPreferences,
			};
		},

		async getCandidateMerges(): Promise<RelationshipsMergeCandidate[]> {
			if (typeof relationshipsService.getCandidateMerges !== "function") {
				return [];
			}
			return (await relationshipsService.getCandidateMerges()) as RelationshipsMergeCandidate[];
		},

		async acceptMerge(candidateId: UUID): Promise<void> {
			if (typeof relationshipsService.acceptMerge !== "function") {
				throw new Error(
					"RelationshipsService does not support merge acceptance",
				);
			}
			await relationshipsService.acceptMerge(candidateId);
			invalidateModelCache();
		},

		async rejectMerge(candidateId: UUID): Promise<void> {
			if (typeof relationshipsService.rejectMerge !== "function") {
				throw new Error(
					"RelationshipsService does not support merge rejection",
				);
			}
			await relationshipsService.rejectMerge(candidateId);
			invalidateModelCache();
		},

		async proposeMerge(
			entityA: UUID,
			entityB: UUID,
			evidence: RelationshipsMergeProposalEvidence,
		): Promise<UUID> {
			if (typeof relationshipsService.proposeMerge !== "function") {
				throw new Error(
					"RelationshipsService does not support merge proposals",
				);
			}
			const candidateId = await relationshipsService.proposeMerge(
				entityA,
				entityB,
				evidence,
			);
			invalidateModelCache();
			return candidateId;
		},
	};
}

// ---------------------------------------------------------------------------
// Cluster-aware memory helpers
// ---------------------------------------------------------------------------
//
// Consumers like the LifeOps dossier service and cross-channel follow-ups
// need to fan a memory lookup out across every entity in a person's
// identity cluster (Jill-on-Discord, Jill-on-Telegram, jill@example.com)
// instead of a single entityId. These helpers resolve the cluster via the
// RelationshipsService (authoritative for cluster membership) and then
// dispatch getMemories / searchMemories once per member, merging and
// deduplicating the results.

export type ClusterMemoriesQuery = {
	tableName: string;
	roomId?: UUID;
	worldId?: UUID;
	count?: number;
	limit?: number;
	offset?: number;
	unique?: boolean;
	start?: number;
	end?: number;
	metadata?: Record<string, unknown>;
	orderBy?: "createdAt";
	orderDirection?: "asc" | "desc";
};

export type ClusterSearchQuery = {
	tableName: string;
	embedding: number[];
	match_threshold?: number;
	limit?: number;
	unique?: boolean;
	query?: string;
	roomId?: UUID;
	worldId?: UUID;
};

type ClusterResolver = {
	getMemberEntityIds: (primaryEntityId: UUID) => Promise<UUID[]>;
};

function getClusterResolver(runtime: IAgentRuntime): ClusterResolver | null {
	const service = runtime.getService("relationships");
	if (!service) return null;
	const candidate = service as unknown as Partial<ClusterResolver>;
	if (typeof candidate.getMemberEntityIds !== "function") {
		return null;
	}
	return candidate as ClusterResolver;
}

function dedupeMemoriesById(memories: Memory[]): Memory[] {
	const seen = new Set<string>();
	const unique: Memory[] = [];
	for (const memory of memories) {
		const id = memory.id as string | undefined;
		if (!id) {
			unique.push(memory);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		unique.push(memory);
	}
	return unique;
}

/**
 * Return memories authored by any member of the identity cluster rooted at
 * `primaryEntityId`. If the RelationshipsService cannot be resolved (no
 * cluster lookup available) we fall through to the single-entity query so
 * callers still get results — the caller is responsible for surfacing the
 * degradation via its own `degraded` flag.
 */
export async function getMemoriesForCluster(
	runtime: IAgentRuntime,
	primaryEntityId: UUID,
	params: ClusterMemoriesQuery,
): Promise<Memory[]> {
	const resolver = getClusterResolver(runtime);
	const memberIds = resolver
		? await resolver.getMemberEntityIds(primaryEntityId)
		: [primaryEntityId];
	const ids = memberIds.length > 0 ? memberIds : [primaryEntityId];

	const results = await Promise.all(
		ids.map((entityId) =>
			runtime.getMemories({
				...params,
				entityId,
			}),
		),
	);
	const flat = results.flat();
	return dedupeMemoriesById(flat);
}

/**
 * Semantic-search variant of {@link getMemoriesForCluster}. Runs one
 * `searchMemories` per cluster member with the same embedding/query
 * parameters and deduplicates the union on memory id.
 */
export async function searchMemoriesForCluster(
	runtime: IAgentRuntime,
	primaryEntityId: UUID,
	params: ClusterSearchQuery,
): Promise<Memory[]> {
	const resolver = getClusterResolver(runtime);
	const memberIds = resolver
		? await resolver.getMemberEntityIds(primaryEntityId)
		: [primaryEntityId];
	const ids = memberIds.length > 0 ? memberIds : [primaryEntityId];

	const results = await Promise.all(
		ids.map((entityId) =>
			runtime.searchMemories({
				...params,
				entityId,
			}),
		),
	);
	const flat = results.flat();
	return dedupeMemoriesById(flat);
}
