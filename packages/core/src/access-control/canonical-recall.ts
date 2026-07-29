/**
 * Canonical cross-surface recall: the provenance envelope every connector's
 * memory must carry, the de-duplication key that makes redelivery idempotent,
 * and the **destination-policy seam** retrieval consults before an item may
 * land in a room.
 *
 * Three separable concerns live here, deliberately small:
 *
 * 1. {@link deriveCanonicalProvenance} — reads source / account / room / sender
 *    / timestamp / trust off a stored {@link Memory} using the metadata the
 *    connectors already stamp (`metadata.provider`, `metadata.accountId`, the
 *    nested `metadata[source]` identity object). It normalizes the source
 *    through the connector-source registry so `discord-local` and `discord`
 *    are one surface. It does not invent required fields: missing provenance
 *    returns a typed invalid result and is withheld from recall.
 *
 * 2. {@link canonicalDedupeKey} — `source:account:platformRecordId`. Two deliveries
 *    of the same webhook collapse; the same text from two connector accounts
 *    does not, because the account segment differs. Account identity is part
 *    of the key, never squashed.
 *
 * 3. {@link CanonicalRecallPolicy} — the seam that binds **who is asking** to
 *    **where the answer lands**. This module does not implement audience
 *    policy; it defines the contract and ships
 *    {@link failClosedRecallPolicy}, which allows same-room recall only and
 *    denies cross-room recall with `policy_contract_pending`. That is the
 *    fail-closed placeholder until the audience-policy work supplies a real
 *    implementation, at which point callers swap the policy object and the
 *    denial code disappears on its own.
 *
 * Composes with — never duplicates — `./filter.ts`. That gates a single
 * memory's {@link MemoryScope} against the requester's role; this gates the
 * *destination* the recalled item is about to be spoken into. A retrieval that
 * passes the scope ladder can still be denied here because the room is wrong.
 */
import { normalizeConnectorSource } from "../connectors";
import type {
	AccessContext,
	IAgentRuntime,
	Memory,
	MemoryScope,
	MessageChatType,
	Room,
	UUID,
} from "../types";
import { ChannelType } from "../types";
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
 * The provenance envelope carried alongside every canonically-recalled item:
 * which surface it came from, under which connector account, in which room,
 * from which sender, when, and how well attested.
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

/** Destination a recalled item is about to be rendered into, resolved by the runtime. */
export interface ResolvedRecallDestination {
	/** Room the answer will land in. */
	roomId: UUID;
	/** Trusted room record from `runtime.getRoom`. */
	room: Room;
	/** World the destination room belongs to. */
	worldId?: UUID;
	/** Chat type of the destination, when resolvable. */
	chatType: MessageChatType;
	/** Whether the trusted room metadata marks the destination as multi-party. */
	isGroup: boolean;
	/** Participants of the destination room, when enumerable. */
	participantEntityIds: UUID[];
}

/** Machine-readable reason a candidate was withheld. */
export type RecallDenyCode =
	/**
	 * A destination-aware audience policy has not been supplied, so a
	 * cross-room disclosure cannot be authorized. Fail-closed placeholder.
	 */
	| "policy_contract_pending"
	/** The destination room / chat type could not be resolved at all. */
	| "destination_unresolved"
	/** The item's own scope forbids this requester (delegated to the scope ladder). */
	| "scope_denied"
	/** The stored memory is missing provenance required for fail-closed recall. */
	| "invalid_provenance";

export type RecallDecision =
	| { allow: true }
	| { allow: false; code: RecallDenyCode; reason: string };

export interface RecallPolicyInput {
	/** The stored memory under consideration. */
	candidate: Memory;
	/** Provenance derived from that memory. */
	provenance: CanonicalProvenance;
	/** Who is asking. */
	requester: AccessContext;
	/** Where the answer will land. */
	destination: ResolvedRecallDestination;
}

/**
 * The destination-aware audience contract. Implementations decide whether a
 * candidate memory may be disclosed into `destination` for `requester`.
 *
 * Retrieval callers depend on this interface, never on a concrete policy, so
 * the real audience implementation can be dropped in without touching call
 * sites. Until one is supplied, {@link failClosedRecallPolicy} is the default
 * and refuses to guess.
 */
export interface CanonicalRecallPolicy {
	/** Stable identifier, surfaced in receipts so a run records which policy ran. */
	readonly id: string;
	decide(input: RecallPolicyInput): RecallDecision;
}

/**
 * The conservative default policy: same-room recall of any readable item is
 * allowed and every cross-room recall is denied.
 *
 * This is intentionally not an audience implementation. It reports
 * `policy_contract_pending` so a caller can tell "withheld pending policy"
 * apart from "genuinely nothing to say" while PR #17212 supplies the real
 * destination policy.
 */
export const failClosedRecallPolicy: CanonicalRecallPolicy = {
	id: "fail-closed-pending-audience-policy",
	decide({ provenance, destination }): RecallDecision {
		// Same-room recall discloses nothing the room does not already hold.
		if (destination.roomId === provenance.roomId) {
			return { allow: true };
		}

		// #17212 owns the richer audience policy. Until it lands, default recall
		// denies every cross-room disclosure after mandatory scope authorization.
		return {
			allow: false,
			code: "policy_contract_pending",
			reason:
				"cross-room recall requires a destination-aware audience policy, which is not installed",
		};
	},
};

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
	return typeof value === "string" && VALID_MEMORY_SCOPES.has(value as MemoryScope)
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
 * Read source / account / room / sender / timestamp / trust off a stored
 * memory, normalizing the surface through the connector-source registry.
 *
 * `agentId` identifies the agent so its own messages resolve to `self` trust.
 * Optional display fields may remain absent; missing required provenance returns
 * a typed invalid result. This derives stored facts and never fabricates them.
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

/** Liveness of one contributing source in a recall. */
export interface RecallSourceHealth {
	source: string;
	state: "ok" | "degraded" | "unavailable";
	/** Operator-facing explanation when not `ok`. */
	reason?: string;
	/** Age of the freshest item this source contributed, in ms. */
	freshnessMs?: number;
}

/** One item that survived both the scope ladder and the destination policy. */
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
 * Whether the answer is trustworthy as a complete picture.
 *
 * `partial` and `unavailable` exist so a caller can never render a degraded
 * result as a confident empty state.
 */
export type RecallAvailability = "complete" | "partial" | "unavailable";

export interface CanonicalRecallResult {
	items: RecalledItem[];
	withheld: WithheldItem[];
	sources: RecallSourceHealth[];
	availability: RecallAvailability;
	/** Id of the policy that produced the decisions, for the receipt. */
	policyId: string;
}

export interface CanonicalRecallInput {
	/** Candidate memories already fetched from the store. */
	candidates: Memory[];
	/** The agent performing the recall. */
	agentId: UUID;
	/** Who is asking. */
	requester: AccessContext;
	/** Where the answer will land. */
	destination: ResolvedRecallDestination | null;
	/** Destination policy. Defaults to {@link failClosedRecallPolicy}. */
	policy?: CanonicalRecallPolicy;
}

/**
 * Normalize, de-duplicate, and destination-filter a set of candidate memories
 * into one canonical recall result.
 *
 * De-duplication keeps the earliest-created member of each
 * {@link canonicalDedupeKey} group, so a redelivered webhook does not
 * double-count and does not reorder the transcript.
 *
 * This pure evaluator intentionally has no source-health input: only the
 * production adapter-owning retrieval function may attach health. That prevents
 * callers from presenting declared connector state as observed availability.
 */
function buildCanonicalRecall(
	input: CanonicalRecallInput,
): Omit<CanonicalRecallResult, "sources" | "availability"> {
	const policy = input.policy ?? failClosedRecallPolicy;
	const actor = actorFromAccessContext(input.requester, input.agentId);

	const byKey = new Map<string, RecalledItem>();
	const withheld: WithheldItem[] = [];

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

		if (!canReadScope(provenance.scope, scopedEntityIdForMemory(memory), actor)) {
			if (!withheld.some((entry) => entry.dedupeKey === dedupeKey)) {
				withheld.push({
					dedupeKey,
					source: provenance.source,
					code: "scope_denied",
					reason: "requester is not authorized to read the memory scope",
				});
			}
			continue;
		}

		if (!input.destination) {
			if (!withheld.some((entry) => entry.dedupeKey === dedupeKey)) {
				withheld.push({
					dedupeKey,
					source: provenance.source,
					code: "destination_unresolved",
					reason:
						"destination room is unresolved; cannot authorize a disclosure without knowing where it lands",
				});
			}
			continue;
		}

		const decision = policy.decide({
			candidate: memory,
			provenance,
			requester: input.requester,
			destination: input.destination,
		});

		if (!decision.allow) {
			if (!withheld.some((entry) => entry.dedupeKey === dedupeKey)) {
				withheld.push({
					dedupeKey,
					source: provenance.source,
					code: decision.code,
					reason: decision.reason,
				});
			}
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

	return { items, withheld, policyId: policy.id };
}

function isGroupRoomType(type: Room["type"]): boolean {
	return (
		type === ChannelType.GROUP ||
		type === ChannelType.VOICE_GROUP ||
		type === ChannelType.FEED ||
		type === ChannelType.THREAD ||
		type === ChannelType.FORUM ||
		type === ChannelType.WORLD
	);
}

export async function resolveRecallDestination(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<ResolvedRecallDestination | null> {
	const room = await runtime.getRoom(roomId);
	if (!room) return null;
	const participants = await runtime.getParticipantsForRoom(room.id);
	return {
		roomId: room.id,
		room,
		worldId: room.worldId,
		chatType: room.type,
		isGroup: isGroupRoomType(room.type),
		participantEntityIds: participants,
	};
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
	source?: string;
	policy?: CanonicalRecallPolicy;
	now?: () => number;
}

/**
 * Production retrieval for canonical conversation recall. It owns the adapter
 * call and destination resolution so source health reflects real storage
 * availability, while #17212 can later replace only the destination policy seam.
 */
export async function searchCanonicalConversationMemories(
	input: CanonicalMemorySearchInput,
): Promise<CanonicalRecallResult> {
	// Health is attributed to the adapter actually queried, never to a
	// caller-supplied connector filter. A `source=discord` filter does not prove
	// that a Discord connector is healthy; it only filters rows returned by the
	// messages adapter.
	const adapterSource = "messages";
	let candidates: Memory[];
	try {
		candidates = await input.runtime.searchMemories({
			embedding: input.embedding,
			tableName: "messages",
			match_threshold: input.matchThreshold,
			count: input.count,
			...(input.query ? { query: input.query } : {}),
			...(input.entityId ? { entityId: input.entityId } : {}),
			accessContext: input.requester,
		});
	} catch (error) {
		return {
			items: [],
			withheld: [],
			sources: [
				{
					source: adapterSource,
					state: "unavailable",
					reason: error instanceof Error ? error.message : String(error),
				},
			],
			availability: "unavailable",
			policyId: (input.policy ?? failClosedRecallPolicy).id,
		};
	}

	let destination: ResolvedRecallDestination | null;
	try {
		destination = await resolveRecallDestination(
			input.runtime,
			input.destinationRoomId,
		);
	} catch {
		destination = null;
	}

	const evaluated = buildCanonicalRecall({
		candidates,
		agentId: input.agentId,
		requester: input.requester,
		destination,
		policy: input.policy,
	});

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
	const freshestTimestamp = items.reduce<number | undefined>(
		(newest, item) =>
			newest === undefined || item.provenance.timestampMs > newest
				? item.provenance.timestampMs
				: newest,
		undefined,
	);
	const sources: RecallSourceHealth[] = [
		{
			source: adapterSource,
			state: "ok",
			...(freshestTimestamp === undefined
				? {}
				: {
						freshnessMs: Math.max(
							0,
							(input.now ?? Date.now)() - freshestTimestamp,
						),
					}),
		},
	];
	const availability: RecallAvailability =
		withheld.length > 0
			? items.length > 0
				? "partial"
				: "unavailable"
			: "complete";

	return {
		...evaluated,
		items,
		withheld,
		sources,
		availability,
	};
}
