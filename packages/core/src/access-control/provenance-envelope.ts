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
 *    are one surface. Missing or conflicting required fields return a typed
 *    invalid result and the item is withheld from recall — nothing defaults to
 *    `global`. Sender attestation is recorded as a structural fact
 *    (`sender-stamped`), never labelled "connector-verified": a nested
 *    metadata object is present at ingestion, but that is not an unforgeable
 *    attestation of the platform identity it carries.
 *
 * 2. {@link canonicalDedupeKey} — `source:account:room:platformRecordId`. Two
 *    deliveries of the same webhook collapse; the same text from two connector
 *    accounts does not, because the account segment differs. Room identity is
 *    part of the key because platform message ids are room-local (Telegram
 *    message ids are scoped to a chat, so two chats can legitimately reuse an
 *    id without being the same record). Account identity is part of the key,
 *    never squashed.
 *
 * 3. {@link searchCanonicalConversationMemories} — the production retrieval
 *    for conversation-mode message search. Requester identity and destination
 *    are derived ONLY from process-bound trusted delivery-audience evidence
 *    minted for the exact runtime/turn ({@link deliveryMessage}); the adapter
 *    vector scan is constrained by the attested room before ranking so a
 *    global top-K cannot starve eligible same-room rows. It then runs, in
 *    order: provenance validation, the mandatory scope ladder
 *    (`./filter.ts`), and destination containment. Adapter errors and
 *    access-context lookup failures propagate as a typed `unavailable`
 *    availability — never an empty "complete" result.
 *
 * Composes with — never duplicates — `./filter.ts`: that ladder gates a single
 * memory's {@link MemoryScope} against the requester's role; this module then
 * pins disclosure to the destination unless the trusted delivery-audience layer
 * has revalidated the live room type and participants for owner-only recall.
 */

import { normalizeConnectorSource } from "../connectors";
import { ElizaError } from "../errors";
import {
	evaluateOwnerExclusiveDisclosure,
	INTERNAL_AGENT_TURN_DISCLOSURE_BASIS,
	markOwnerExclusiveDisclosureUsed,
	OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
	type OwnerExclusiveDisclosureDecision,
	type OwnerExclusiveDisclosureDenial,
	revalidateOwnerExclusiveDisclosure,
	trustedDeliveryAudienceIsBoundToRuntime,
} from "../security/trusted-delivery-audience";
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
 * - `sender-stamped`: the ingesting connector wrote a nested
 *   `metadata[source]` identity object carrying `userId`/`id`. This records the
 *   structural fact that a stable identity was stamped at ingestion — the same
 *   evidence `roles.ts` reads. It is NOT labelled "connector-verified" because
 *   ordinary stored metadata is not an unforgeable attestation.
 * - `unverified`: no stable connector identity was recorded. Content-supplied
 *   metadata from a chat client lands here and must never be promoted.
 */
export type CanonicalTrust = "self" | "sender-stamped" | "unverified";

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
	/** The stored memory is missing or has conflicting provenance required for fail-closed recall. */
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
 * Optional display fields may remain absent; missing required provenance, or
 * conflicting provenance fields (a source recorded under more than one path),
 * returns a typed invalid result. This derives stored facts and never
 * fabricates them. Sender attestation is recorded as a structural fact
 * (`sender-stamped`), never promoted to "connector-verified".
 */
export function deriveCanonicalProvenance(
	memory: Memory,
	agentId: UUID,
): CanonicalProvenanceResult {
	const metadata = asRecord(memory.metadata);
	const content = asRecord(memory.content);

	// Source must come from exactly one path. Connectors stamp
	// `metadata.provider`; the raw content `source` field and the nested
	// `metadata.base.source` are secondary. When two paths disagree the record
	// is contradictory and must be withheld rather than silently picking the
	// first one.
	const providerSource = readString(metadata, "provider");
	const contentSource = readString(content, "source");
	const baseSource = readString(asRecord(metadata?.base), "source");
	const sourceCandidates = [providerSource, contentSource, baseSource].filter(
		(value): value is string => value !== undefined,
	);
	const distinctRawSources = new Set(
		sourceCandidates.map((value) => normalizeConnectorSource(value) ?? value),
	);
	if (distinctRawSources.size > 1) {
		return {
			valid: false,
			code: "invalid_provenance",
			reason:
				"stored memory records conflicting source fields; cannot determine a single canonical surface",
		};
	}
	const rawSource = providerSource ?? contentSource ?? baseSource;
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
				? "sender-stamped"
				: "unverified";

	// Account id must be consistent across paths. When both the top-level
	// metadata.accountId and the nested identity object's accountId are
	// present and differ, the record is contradictory — reject instead of
	// silently picking the first one.
	const metadataAccountId = readString(metadata, "accountId");
	const nestedAccountId = readString(nested, "accountId");
	if (
		metadataAccountId !== undefined &&
		nestedAccountId !== undefined &&
		metadataAccountId !== nestedAccountId
	) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason:
				"stored memory records conflicting connector account id fields; cannot determine a single canonical account",
		};
	}
	const accountId = metadataAccountId ?? nestedAccountId;
	if (!accountId) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason: "stored memory is missing a connector account id",
		};
	}

	// The authoritative platform-record-id paths must agree when co-present.
	// Each connector may stamp the same id under more than one of these keys;
	// when two are present and differ the record is contradictory — reject
	// instead of first-wins. `metadata.sourceId` is deliberately NOT in this
	// set: it is a derived/internal identifier (e.g. the synthesized memory
	// source UUID the Discord connector writes), not the platform record id, so
	// it only serves as a last-resort fallback and must never be diffed against
	// a real message id.
	const pmiCandidates = [
		readString(metadata, "platformMessageId"),
		readString(metadata, "messageIdFull"),
		readString(nested, "messageId"),
	].filter((value): value is string => value !== undefined);
	const distinctPmi = new Set(pmiCandidates);
	if (distinctPmi.size > 1) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason:
				"stored memory records conflicting platform message id fields; cannot determine a single canonical record id",
		};
	}
	const platformMessageId =
		(distinctPmi.size === 1 ? [...distinctPmi][0] : undefined) ??
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

	// Scope must be consistent across paths. When both metadata.base.scope
	// and metadata.scope are present and differ, the record is contradictory
	// — reject instead of first-wins.
	const baseScope = readScope(asRecord(metadata?.base)?.scope);
	const metadataScope = readScope(metadata?.scope);
	if (baseScope && metadataScope && baseScope !== metadataScope) {
		return {
			valid: false,
			code: "invalid_provenance",
			source,
			reason:
				"stored memory records conflicting scope fields; cannot determine a single canonical scope",
		};
	}
	const scope = baseScope ?? metadataScope;
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
 * Stable idempotency key for a canonical item. Separator-free identifiers keep
 * the legacy `source:account:room:platformRecordId` form; delimiter-bearing
 * account or record identifiers use a versioned JSON tuple so distinct tuples
 * cannot serialize to the same key.
 *
 * Redelivery of one webhook collapses to one key. The same text arriving under
 * two connector accounts yields two keys, so account identity survives
 * de-duplication instead of being merged away. Room identity is part of the
 * key because platform message ids are room-local: a Telegram message id is
 * scoped to a chat, so the same id in two chats is two records, not one.
 */
export function canonicalDedupeKey(provenance: CanonicalProvenance): string {
	if (
		provenance.accountId.includes(":") ||
		provenance.platformMessageId.includes(":")
	) {
		// The legacy key is retained byte-for-byte for its unambiguous input
		// domain. Delimiter-bearing identifiers use a versioned JSON tuple: JSON
		// string encoding is injective for strings, and `|` cannot occur in a
		// validated canonical source, so a v2 key cannot collide with a legacy key.
		return `v2|${JSON.stringify([
			provenance.source,
			provenance.accountId,
			provenance.roomId,
			provenance.platformMessageId,
		])}`;
	}
	return `${provenance.source}:${provenance.accountId}:${provenance.roomId}:${provenance.platformMessageId}`;
}

/** One item that survived provenance validation, the scope ladder, and containment. */
export interface RecalledItem {
	memory: Memory;
	provenance: CanonicalProvenance;
	dedupeKey: string;
}

/**
 * An item that was found but withheld. Carries only the machine-readable deny
 * code and an aggregate, identifier-free reason — never the source, account,
 * platform record id, or dedupe key of the withheld memory, which would leak
 * account/platform identifiers to a caller that was not authorized to read
 * them.
 */
export interface WithheldItem {
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
	/**
	 * Whether the adapter candidate window covered the full eligible set. When
	 * `false`, closer ineligible rows (wrong room, wrong source, malformed
	 * provenance, duplicates) may have starved eligible results out of the
	 * bounded top-K window, so the answer is honestly incomplete even if no
	 * item was individually withheld.
	 */
	candidateWindowComplete: boolean;
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

interface CanonicalRecallEvaluationInput extends CanonicalRecallInput {
	/** Derived only inside this module from process-local trusted audience evidence. */
	crossRoomGate: CrossRoomRecallGate;
}

type CrossRoomRecallGate =
	| { allowed: true }
	| { allowed: false; reason: string };

function assertNever(value: never): never {
	throw new Error(`Unhandled owner-exclusive disclosure basis: ${value}`);
}

function deniedCrossRoomGateReason(
	decision: OwnerExclusiveDisclosureDecision,
): string {
	if (!decision.allowed) {
		return `cross-room recall denied by trusted delivery audience: ${decision.reason}`;
	}
	switch (decision.basis) {
		case OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS:
			return "cross-room recall is allowed";
		case INTERNAL_AGENT_TURN_DISCLOSURE_BASIS:
			return "cross-room recall requires a verified owner-private destination, not an internal agent turn";
		default:
			return assertNever(decision.basis);
	}
}

function crossRoomRecallGate(
	decision: OwnerExclusiveDisclosureDecision,
): CrossRoomRecallGate {
	return decision.allowed &&
		decision.basis === OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
		? { allowed: true }
		: { allowed: false, reason: deniedCrossRoomGateReason(decision) };
}

/**
 * Normalize, authorize, contain, and de-duplicate a set of candidate memories
 * into one canonical recall result.
 *
 * Order is load-bearing: provenance validation, then the MANDATORY scope
 * ladder, then destination containment, then dedupe. Cross-room authorization
 * must be proved by the trusted-delivery-audience layer before this function is
 * called; absent that proof, same-room containment is the fail-closed default.
 *
 * De-duplication keeps the earliest-created member of each
 * {@link canonicalDedupeKey} group, so a redelivered webhook does not
 * double-count and does not reorder the transcript.
 *
 * Withheld entries carry only an aggregate, identifier-free reason — never the
 * source, account, platform record id, or dedupe key of the withheld memory.
 */
function evaluateCanonicalRecall(
	input: CanonicalRecallEvaluationInput,
): Omit<CanonicalRecallResult, "availability" | "candidateWindowComplete"> {
	const actor = actorFromAccessContext(input.requester, input.agentId);

	const byKey = new Map<string, RecalledItem>();
	const withheld: WithheldItem[] = [];
	// Track the deny codes seen so the withheld list is an aggregate (one entry
	// per code) rather than a per-item leak of account/platform identifiers.
	const seenDenyCodes = new Set<RecallDenyCode>();
	const recordDenial = (code: RecallDenyCode, reason: string): void => {
		if (!seenDenyCodes.has(code)) {
			seenDenyCodes.add(code);
			withheld.push({ code, reason });
		}
	};

	for (const memory of input.candidates) {
		const provenanceResult = deriveCanonicalProvenance(memory, input.agentId);
		if (!provenanceResult.valid) {
			recordDenial(provenanceResult.code, provenanceResult.reason);
			continue;
		}
		const provenance = provenanceResult.provenance;
		const dedupeKey = canonicalDedupeKey(provenance);

		if (
			!canReadScope(provenance.scope, scopedEntityIdForMemory(memory), actor)
		) {
			recordDenial(
				"scope_denied",
				"one or more candidates were withheld because the requester is not authorized to read their scope",
			);
			continue;
		}

		if (
			!input.crossRoomGate.allowed &&
			provenance.roomId !== input.destinationRoomId
		) {
			recordDenial("cross_room_denied", input.crossRoomGate.reason);
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

export function buildCanonicalRecall(
	input: CanonicalRecallInput,
): Omit<CanonicalRecallResult, "availability" | "candidateWindowComplete"> {
	return evaluateCanonicalRecall({
		...input,
		crossRoomGate: {
			allowed: false,
			reason: "cross-room recall is disabled for direct canonical evaluation",
		},
	});
}

interface CanonicalMemorySearchBaseInput {
	runtime: IAgentRuntime;
	embedding: number[];
	query?: string;
	/** @deprecated Production recall derives the agent from `runtime.agentId`. */
	agentId?: UUID;
	count: number;
	matchThreshold?: number;
	entityId?: UUID;
	/** Optional connector-source filter, normalized through the registry. */
	source?: string;
}

/**
 * Production retrieval for canonical conversation recall. Requester identity
 * and destination are derived ONLY from the exact in-memory delivery turn
 * ({@link CanonicalMemorySearchDeliveryInput.deliveryMessage}) — the same
 * process-bound trusted delivery-audience evidence the disclosure gate uses.
 * Caller-supplied `requester` / `destinationRoomId` are NOT accepted: a caller
 * cannot mint authority over who is asking or where the answer lands.
 *
 * The adapter vector scan is constrained by the attested room before ranking,
 * so a global top-K cannot starve eligible same-room rows. When cross-room
 * recall is authorized by the trusted-delivery-audience layer the scan is not
 * room-constrained, but the bounded candidate window is refilled honestly and
 * a truncated window is never reported as complete.
 *
 * Adapter failures and access-context lookup failures propagate as a typed
 * `unavailable` availability — an error is an error, never an empty
 * "complete" result.
 */
export type CanonicalMemorySearchInput = CanonicalMemorySearchBaseInput & {
	/** Exact in-memory delivery turn the recalled context will render into. */
	deliveryMessage: Memory;
};

export interface CanonicalMemorySearchDeliveryInput {
	/** Exact in-memory delivery turn the recalled context will render into. */
	deliveryMessage: Memory;
}

/** Validate the exact delivery turn's process-local runtime binding. */
function trustedDeliveryTurnDenial(
	runtime: IAgentRuntime,
	deliveryMessage: Memory,
): OwnerExclusiveDisclosureDenial | undefined {
	if (!trustedDeliveryAudienceIsBoundToRuntime(deliveryMessage, runtime)) {
		return "runtime_mismatch";
	}
	const decision = evaluateOwnerExclusiveDisclosure(deliveryMessage);
	if (decision.allowed) return undefined;

	// A valid shared/group audience is sufficient for same-room recall even
	// though it cannot authorize owner-private cross-room disclosure. All
	// binding, freshness, actor, agent, and room failures fail closed here.
	switch (decision.reason) {
		case "owner_mismatch":
		case "participant_mismatch":
		case "destination_not_private":
			return undefined;
		default:
			return decision.reason;
	}
}

async function resolveRequesterAccessContext(
	runtime: IAgentRuntime,
	deliveryMessage: Memory,
): Promise<
	{ ok: true; context: AccessContext } | { ok: false; cause: unknown }
> {
	try {
		// buildAccessContext is the same composition the disclosure gate trusts:
		// it resolves role/isOwner/worldId against the single world the message
		// belongs to. Delegating here keeps requester identity derived from the
		// same process-bound evidence, not caller-supplied fields.
		const { buildAccessContext } = await import("../access-context");
		const context = await buildAccessContext(runtime, deliveryMessage);
		return { ok: true, context };
	} catch (cause) {
		return { ok: false, cause };
	}
}

/**
 * Search canonical conversation memories, deriving requester and destination
 * only from the exact trusted delivery turn. See
 * {@link CanonicalMemorySearchInput}.
 */
export async function searchCanonicalConversationMemories(
	input: CanonicalMemorySearchInput,
): Promise<CanonicalRecallResult> {
	const { deliveryMessage } = input;
	const destinationRoomId = deliveryMessage.roomId;
	const deliveryTurnDenial = trustedDeliveryTurnDenial(
		input.runtime,
		deliveryMessage,
	);
	if (deliveryTurnDenial) {
		return {
			items: [],
			withheld: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		};
	}

	// Revalidate the attested audience against live room state BEFORE any
	// retrieval. A changed audience or failed lookup is a hard stop — no
	// same-room or cross-room recall proceeds. This satisfies the issue's
	// requirement that changed turn evidence is rejected before any retrieval.
	const revalidated = await revalidateOwnerExclusiveDisclosure(
		input.runtime,
		deliveryMessage,
	);
	if (
		!revalidated.allowed &&
		(revalidated.reason === "audience_changed" ||
			revalidated.reason === "audience_lookup_failed")
	) {
		return {
			items: [],
			withheld: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		};
	}

	const requesterResult = await resolveRequesterAccessContext(
		input.runtime,
		deliveryMessage,
	);
	if (!requesterResult.ok) {
		input.runtime.reportError(
			"CanonicalRecall.accessContext",
			new ElizaError(
				"Could not resolve the requester access context for canonical conversation recall.",
				{
					code: "CANONICAL_RECALL_ACCESS_CONTEXT_FAILED",
					cause: requesterResult.cause,
					context: { roomId: destinationRoomId },
				},
			),
		);
		return {
			items: [],
			withheld: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		};
	}
	const requester = requesterResult.context;

	const crossRoomGate: CrossRoomRecallGate = crossRoomRecallGate(revalidated);

	// Constrain the vector scan by the attested room BEFORE ranking so a global
	// top-K cannot starve eligible same-room rows. When cross-room recall is
	// authorized the scan is not room-constrained, but the bounded window is
	// still refilled honestly and a truncated window is never reported as
	// complete.
	const roomConstrained = !crossRoomGate.allowed;

	// Bounded advancing refill: instead of a single over-fetched query,
	// request in windows and advance until enough valid items are collected
	// or the adapter exhausts the eligible set. This prevents closer
	// wrong-source/malformed/denied rows from starving valid rows.
	const overfetchFactor = 3;
	const maxRefillRounds = 3;
	const allCandidates: Memory[] = [];
	let candidateWindowComplete = true;
	let accumulatedValid = 0;
	const seenIds = new Set<string>();

	for (let round = 0; round < maxRefillRounds; round++) {
		const roundCount = Math.max(
			input.count,
			input.count * overfetchFactor * (round + 1),
		);
		let roundCandidates: Memory[];
		try {
			roundCandidates = await input.runtime.searchMemories({
				embedding: input.embedding,
				tableName: "messages",
				match_threshold: input.matchThreshold,
				count: roundCount,
				...(input.query ? { query: input.query } : {}),
				...(input.entityId ? { entityId: input.entityId } : {}),
				...(roomConstrained ? { roomId: destinationRoomId } : {}),
				accessContext: requester,
			});
		} catch (cause) {
			input.runtime.reportError(
				"CanonicalRecall.adapter",
				new ElizaError("Canonical conversation recall adapter query failed.", {
					code: "CANONICAL_RECALL_ADAPTER_FAILED",
					cause,
					context: { roomId: destinationRoomId },
				}),
			);
			return {
				items: [],
				withheld: [],
				availability: "unavailable",
				candidateWindowComplete: false,
			};
		}

		// Track whether the adapter returned a full window (possible
		// truncation) or fewer rows (exhaustion of eligible set).
		if (roundCandidates.length >= roundCount) {
			candidateWindowComplete = false;
		}

		// Deduplicate against what we already have and accumulate.
		for (const mem of roundCandidates) {
			const memId = mem.id?.toString();
			if (memId && seenIds.has(memId)) continue;
			if (memId) seenIds.add(memId);
			allCandidates.push(mem);
		}

		// Quick-check: if this round added enough candidates to potentially
		// satisfy the requested count after filtering, we can stop early.
		// We check the raw count since we don't know the filter ratio yet.
		const evaluated = evaluateCanonicalRecall({
			candidates: allCandidates,
			agentId: input.runtime.agentId,
			requester,
			destinationRoomId,
			crossRoomGate,
		});
		accumulatedValid = evaluated.items.length;

		if (
			accumulatedValid >= input.count ||
			roundCandidates.length < roundCount
		) {
			// Either we have enough valid items, or the adapter returned
			// fewer than requested — it exhausted the eligible set.
			if (roundCandidates.length < roundCount) {
				candidateWindowComplete = true;
			}
			break;
		}
	}

	const candidates = allCandidates;

	const evaluated = evaluateCanonicalRecall({
		candidates,
		agentId: input.runtime.agentId,
		requester,
		destinationRoomId,
		crossRoomGate,
	});

	// A source filter narrows what the caller asked to see; it never narrows
	// the honesty of the withheld list.
	const normalizedSource = input.source
		? normalizeConnectorSource(input.source)
		: undefined;
	const items = (
		normalizedSource
			? evaluated.items.filter(
					(item) => item.provenance.source === normalizedSource,
				)
			: evaluated.items
	).slice(0, input.count);

	if (
		deliveryMessage &&
		items.some((item) => item.provenance.roomId !== deliveryMessage.roomId)
	) {
		markOwnerExclusiveDisclosureUsed(deliveryMessage);
	}

	const withheld = evaluated.withheld;
	let availability: RecallAvailability;
	if (withheld.length > 0) {
		availability = items.length > 0 ? "partial" : "unavailable";
	} else if (!candidateWindowComplete) {
		// No item was individually withheld, but the candidate window was
		// truncated: closer ineligible rows may have starved eligible results,
		// so the answer is honestly partial.
		availability = items.length > 0 ? "partial" : "unavailable";
	} else {
		availability = "complete";
	}

	return {
		items,
		withheld,
		availability,
		candidateWindowComplete,
	};
}
