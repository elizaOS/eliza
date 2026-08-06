/**
 * Canonical provenance envelope for stored connector messages: which surface a
 * memory came from, under which connector account, in which room, from which
 * sender, when, and how well attested — derived strictly from metadata the
 * connectors already stamp, never fabricated.
 *
 * Three separable concerns live here, deliberately small:
 *
 * 1. {@link deriveCanonicalProvenance} — reads source / account / room / sender
 *    / timestamp / trust / scope off a stored {@link Memory} using the metadata
 *    the connectors stamp (`metadata.provider`, `metadata.accountId`, the
 *    nested `metadata[source]` identity object). The source is normalized
 *    through the connector-source registry so `discord-local` and `discord`
 *    are one surface. Missing required fields return a typed invalid result
 *    and the item is withheld from recall — nothing defaults to `global`.
 *
 * 2. {@link canonicalDedupeKey} — `source:account:platformRecordId`. Two
 *    deliveries of the same webhook collapse; the same text from two connector
 *    accounts does not, because the account segment differs. Account identity
 *    is part of the key, never squashed.
 *
 * 3. {@link searchCanonicalConversationMemories} — the production retrieval
 *    for conversation-mode message search. It runs, in order: provenance
 *    validation, the mandatory scope ladder (`./filter.ts`), and same-room
 *    containment. Cross-room recall is DENIED here unconditionally: deciding
 *    that a recalled item may cross into a different destination is audience
 *    policy, and audience policy is owned by the trusted-delivery-audience
 *    layer (PR #17206), which attests the destination from `runtime.getRoom` +
 *    `getParticipantsForRoom` rather than anything a caller declares. When
 *    that layer wants to authorize a wider audience it does so at its own
 *    seams; this module never grows a policy knob for callers to widen.
 *
 * Composes with — never duplicates — `./filter.ts`: that ladder gates a single
 * memory's {@link MemoryScope} against the requester's role; the same-room rule
 * here additionally pins the item to the room it already lives in, so recall
 * discloses nothing a destination does not already hold.
 */
import { normalizeConnectorSource } from "../connectors";
import type {
	AccessContext,
	IAgentRuntime,
	Memory,
	MemoryScope,
	MessageChatType,
	UUID,
} from "../types";
import { actorFromAccessContext, canReadScope } from "./filter";

/**
 * How strongly the stored memory's sender identity is attested.
 *
 * - `self`: the agent's own message (entity is the agent).
 * - `connector-verified`: the connector stamped a stable platform identity
 *   (a nested `metadata[source]` object carrying `userId`/`id`) — the same
 *   evidence `roles.ts` is willing to resolve a role from.
 * - `unverified`: no stable connector identity was recorded. Content-supplied
 *   metadata from a chat client lands here and must never be promoted.
 */
export type CanonicalTrust = "self" | "connector-verified" | "unverified";

/**
 * The provenance envelope carried alongside every canonically-recalled item.
 */
export interface CanonicalProvenance {
	/** Canonical connector source (registry-normalized, e.g. `discord`). */
	source: string;
	/** Raw `source` string as stored, before normalization. */
	rawSource?: string;
	/** Connector account this arrived under. Distinguishes two accounts on one surface. */
	accountId: string;
	/** Room the memory belongs to. */
	roomId: UUID;
	/** World/tenant scope, when the memory recorded one. */
	worldId?: UUID;
	/** Entity id of the sender. */
	senderId: UUID;
	/** Sender's display name, when the connector recorded one. */
	senderDisplayName?: string;
	/** Sender's stable platform id, when the connector stamped one. */
	senderPlatformId?: string;
	/** Creation timestamp in epoch ms. */
	timestampMs: number;
	/** Attestation strength of the sender identity. */
	trust: CanonicalTrust;
	/** Chat type recorded by the connector (`dm`, `group`, …), when present. */
	chatType?: MessageChatType;
	/** Platform-native message id, when the connector stamped one. */
	platformMessageId: string;
	/** Explicit memory scope stamped by the ingesting connector. */
	scope: MemoryScope;
}

/** Machine-readable reason a candidate was withheld from recall. */
export type RecallDenyCode =
	/** The stored memory is missing provenance required for fail-closed recall. */
	| "invalid_provenance"
	/** The item's own scope forbids this requester (delegated to the scope ladder). */
	| "scope_denied"
	/**
	 * The item lives in a different room than the destination. Cross-room
	 * disclosure is audience policy and is owned by the trusted-delivery-audience
	 * layer (#17206), not by this envelope.
	 */
	| "cross_room_denied";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readString(
	record: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = record?.[key];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	// Platform ids are frequently numeric (Telegram chat/user ids).
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}

const VALID_MEMORY_SCOPES: ReadonlySet<MemoryScope> = new Set<MemoryScope>([
	"shared",
	"private",
	"room",
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);

function readScope(value: unknown): MemoryScope | undefined {
	return typeof value === "string" &&
		VALID_MEMORY_SCOPES.has(value as MemoryScope)
		? (value as MemoryScope)
		: undefined;
}

function isValidSourceKey(source: string): boolean {
	return /^[a-z0-9][a-z0-9_-]*$/.test(source);
}

function scopedEntityIdForMemory(memory: Memory): UUID {
	const meta = asRecord(memory.metadata);
	const scopedTo = meta?.scopedToEntityId;
	const addedBy = meta?.addedBy;
	return typeof scopedTo === "string"
		? (scopedTo as UUID)
		: typeof addedBy === "string"
			? (addedBy as UUID)
			: memory.entityId;
}

export type CanonicalProvenanceResult =
	| { valid: true; provenance: CanonicalProvenance }
	| {
			valid: false;
			code: "invalid_provenance";
			source?: string;
			reason: string;
	  };

/**
 * Read source / account / room / sender / timestamp / trust / scope off a
 * stored memory, normalizing the surface through the connector-source registry.
 *
 * `agentId` identifies the agent so its own messages resolve to `self` trust.
 * Optional display fields may remain absent; missing required provenance
 * returns a typed invalid result. This derives stored facts and never
 * fabricates them.
 */
export function deriveCanonicalProvenance(
	memory: Memory,
	agentId: UUID,
): CanonicalProvenanceResult {
	const metadata = asRecord(memory.metadata);
	const content = asRecord(memory.content);

	const rawSource =
		readString(metadata, "provider") ??
		readString(content, "source") ??
		readString(asRecord(metadata?.base), "source");
	const source = rawSource ? normalizeConnectorSource(rawSource) : undefined;
	if (!source || !isValidSourceKey(source)) {
		return {
			valid: false,
			code: "invalid_provenance",
			reason: "stored memory is missing a valid source",
		};
	}

	// The connector's nested identity object — the same evidence role
	// resolution is willing to trust. Look it up under both the raw and the
	// canonical source key, since connectors stamp the raw one.
	const nested =
		asRecord(rawSource ? metadata?.[rawSource] : undefined) ??
		asRecord(source ? metadata?.[source] : undefined);

	const senderPlatformId =
		readString(nested, "userId") ?? readString(nested, "id");

	const sender = asRecord(metadata?.sender);
	const senderDisplayName =
		readString(sender, "name") ??
		readString(sender, "username") ??
		readString(nested, "name") ??
		readString(nested, "username") ??
		readString(metadata, "entityName");

	const trust: CanonicalTrust =
		memory.entityId === agentId
			? "self"
			: senderPlatformId
				? "connector-verified"
				: "unverified";

	const accountId =
		readString(metadata, "accountId") ?? readString(nested, "accountId");
	if (!accountId) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason: "stored memory is missing a connector account id",
		};
	}

	const platformMessageId =
		readString(metadata, "platformMessageId") ??
		readString(metadata, "messageIdFull") ??
		readString(nested, "messageId") ??
		readString(metadata, "sourceId");
	if (!platformMessageId) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason: "stored memory is missing a platform record id",
		};
	}

	const timestampMs = memory.createdAt;
	if (
		typeof timestampMs !== "number" ||
		!Number.isFinite(timestampMs) ||
		timestampMs <= 0
	) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason: "stored memory is missing a valid timestamp",
		};
	}

	const scope =
		readScope(asRecord(metadata?.base)?.scope) ?? readScope(metadata?.scope);
	if (!scope) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason: "stored memory is missing a valid scope",
		};
	}

	return {
		valid: true,
		provenance: {
			source,
			rawSource,
			accountId,
			roomId: memory.roomId,
			worldId: memory.worldId,
			senderId: memory.entityId,
			senderDisplayName,
			senderPlatformId,
			timestampMs,
			trust,
			chatType: readString(metadata, "chatType") as MessageChatType | undefined,
			platformMessageId,
			scope,
		},
	};
}

/**
 * Stable idempotency key for a canonical item: `source:account:platformRecordId`.
 *
 * Redelivery of one webhook collapses to one key. The same text arriving under
 * two connector accounts yields two keys, so account identity survives
 * de-duplication instead of being merged away.
 */
export function canonicalDedupeKey(provenance: CanonicalProvenance): string {
	return `${provenance.source}:${provenance.accountId}:${provenance.platformMessageId}`;
}

/** One item that survived provenance validation, the scope ladder, and containment. */
export interface RecalledItem {
	memory: Memory;
	provenance: CanonicalProvenance;
	dedupeKey: string;
}

/** An item that was found but withheld, with the reason it was withheld. */
export interface WithheldItem {
	dedupeKey?: string;
	source?: string;
	code: RecallDenyCode;
	reason: string;
}

/**
 * Whether the answer is trustworthy as a complete picture. `partial` and
 * `unavailable` exist so a caller can never render a degraded result as a
 * confident empty state.
 */
export type RecallAvailability = "complete" | "partial" | "unavailable";

export interface CanonicalRecallResult {
	items: RecalledItem[];
	withheld: WithheldItem[];
	availability: RecallAvailability;
}

export interface CanonicalRecallInput {
	/** Candidate memories already fetched from the store. */
	candidates: Memory[];
	/** The agent performing the recall. */
	agentId: UUID;
	/** Who is asking. */
	requester: AccessContext;
	/** Room the answer will land in (the inbound message's connector-stamped room). */
	destinationRoomId: UUID;
}

/**
 * Normalize, authorize, contain, and de-duplicate a set of candidate memories
 * into one canonical recall result.
 *
 * Order is load-bearing: provenance validation, then the MANDATORY scope
 * ladder, then same-room containment, then dedupe. There is no policy object
 * to swap and therefore no way for a caller to widen the audience; cross-room
 * authorization belongs to the trusted-delivery-audience layer (#17206).
 *
 * De-duplication keeps the earliest-created member of each
 * {@link canonicalDedupeKey} group, so a redelivered webhook does not
 * double-count and does not reorder the transcript.
 */
export function buildCanonicalRecall(
	input: CanonicalRecallInput,
): Omit<CanonicalRecallResult, "availability"> {
	const actor = actorFromAccessContext(input.requester, input.agentId);

	const byKey = new Map<string, RecalledItem>();
	const withheld: WithheldItem[] = [];
	const withholdOnce = (entry: WithheldItem): void => {
		if (
			entry.dedupeKey === undefined ||
			!withheld.some((existing) => existing.dedupeKey === entry.dedupeKey)
		) {
			withheld.push(entry);
		}
	};

	for (const memory of input.candidates) {
		const provenanceResult = deriveCanonicalProvenance(memory, input.agentId);
		if (!provenanceResult.valid) {
			withheld.push({
				source: provenanceResult.source,
				code: provenanceResult.code,
				reason: provenanceResult.reason,
			});
			continue;
		}
		const provenance = provenanceResult.provenance;
		const dedupeKey = canonicalDedupeKey(provenance);

		if (
			!canReadScope(provenance.scope, scopedEntityIdForMemory(memory), actor)
		) {
			withholdOnce({
				dedupeKey,
				source: provenance.source,
				code: "scope_denied",
				reason: "requester is not authorized to read the memory scope",
			});
			continue;
		}

		if (provenance.roomId !== input.destinationRoomId) {
			withholdOnce({
				dedupeKey,
				source: provenance.source,
				code: "cross_room_denied",
				reason:
					"cross-room recall requires the trusted delivery-audience layer; this envelope only recalls into the item's own room",
			});
			continue;
		}

		const existing = byKey.get(dedupeKey);
		if (!existing || provenance.timestampMs < existing.provenance.timestampMs) {
			byKey.set(dedupeKey, { memory, provenance, dedupeKey });
		}
	}

	const items = [...byKey.values()].sort(
		(a, b) => a.provenance.timestampMs - b.provenance.timestampMs,
	);

	return { items, withheld };
}

export interface CanonicalMemorySearchInput {
	runtime: IAgentRuntime;
	embedding: number[];
	query?: string;
	agentId: UUID;
	requester: AccessContext;
	destinationRoomId: UUID;
	count: number;
	matchThreshold?: number;
	entityId?: UUID;
	/** Optional connector-source filter, normalized through the registry. */
	source?: string;
}

/**
 * Production retrieval for canonical conversation recall: owns the adapter
 * call (passing the requester's {@link AccessContext} through to storage) and
 * evaluates the candidates through {@link buildCanonicalRecall}. Adapter
 * failures propagate to the caller — an error is an error, never an empty
 * "complete" result.
 */
export async function searchCanonicalConversationMemories(
	input: CanonicalMemorySearchInput,
): Promise<CanonicalRecallResult> {
	const candidates = await input.runtime.searchMemories({
		embedding: input.embedding,
		tableName: "messages",
		match_threshold: input.matchThreshold,
		count: input.count,
		...(input.query ? { query: input.query } : {}),
		...(input.entityId ? { entityId: input.entityId } : {}),
		accessContext: input.requester,
	});

	const evaluated = buildCanonicalRecall({
		candidates,
		agentId: input.agentId,
		requester: input.requester,
		destinationRoomId: input.destinationRoomId,
	});

	// A source filter narrows what the caller asked to see; it never narrows
	// the honesty of the withheld list for that source.
	const normalizedSource = input.source
		? normalizeConnectorSource(input.source)
		: undefined;
	const items = normalizedSource
		? evaluated.items.filter(
				(item) => item.provenance.source === normalizedSource,
			)
		: evaluated.items;
	const withheld = normalizedSource
		? evaluated.withheld.filter(
				(item) => item.source === undefined || item.source === normalizedSource,
			)
		: evaluated.withheld;

	const availability: RecallAvailability =
		withheld.length > 0
			? items.length > 0
				? "partial"
				: "unavailable"
			: "complete";

	return { items, withheld, availability };
}
