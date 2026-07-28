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
 *    are one surface. It does not invent fields: anything a connector did not
 *    record comes back `undefined`, and the trust ladder degrades accordingly.
 *
 * 2. {@link canonicalDedupeKey} — `source:account:platformRecordId`. Two deliveries
 *    of the same webhook collapse; the same text from two connector accounts
 *    does not, because the account segment differs. Account identity is part
 *    of the key, never squashed.
 *
 * 3. {@link CanonicalRecallPolicy} — the seam that binds **who is asking** to
 *    **where the answer lands**. This module does not implement audience
 *    policy; it defines the contract and ships
 *    {@link failClosedRecallPolicy}, which denies cross-room recall into an
 *    unresolved or group destination with `policy_contract_pending`. That is
 *    the fail-closed placeholder until the audience-policy work supplies a real
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
	Memory,
	MemoryScope,
	MessageChatType,
	UUID,
} from "../types";

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
	accountId?: string;
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
	platformMessageId?: string;
	/** Memory scope, defaulting to `global` exactly as the scope filter does. */
	scope: MemoryScope;
}

/** Destination a recalled item is about to be rendered into. */
export interface RecallDestination {
	/** Room the answer will land in. */
	roomId?: UUID;
	/** World the destination room belongs to. */
	worldId?: UUID;
	/** Chat type of the destination, when resolvable. */
	chatType?: MessageChatType;
	/**
	 * Whether the destination is a multi-party room. Left `undefined` when the
	 * caller could not resolve it — which every policy here treats as unsafe,
	 * not as "probably a DM".
	 */
	isGroup?: boolean;
	/** Participants of the destination room, when enumerable. */
	participantEntityIds?: UUID[];
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
	| "scope_denied";

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
	destination: RecallDestination;
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

/** Scopes that are inherently disclosable anywhere the requester can already read. */
const OPEN_SCOPES: ReadonlySet<MemoryScope> = new Set<MemoryScope>([
	"global",
	"shared",
	"room",
]);

/**
 * The conservative default policy: same-room recall of any readable item is
 * allowed, and **cross-room** recall is allowed only into a destination that is
 * positively resolved as non-group. Anything else is denied.
 *
 * This is intentionally not an audience implementation. It encodes only the
 * invariant that a private-surface fact must not cross into a group room while
 * the real policy is absent, and reports `policy_contract_pending` so a caller
 * can tell "withheld pending policy" apart from "genuinely nothing to say".
 */
export const failClosedRecallPolicy: CanonicalRecallPolicy = {
	id: "fail-closed-pending-audience-policy",
	decide({ provenance, destination }): RecallDecision {
		if (!destination.roomId) {
			return {
				allow: false,
				code: "destination_unresolved",
				reason:
					"destination room is unresolved; cannot authorize a disclosure without knowing where it lands",
			};
		}

		// Same-room recall discloses nothing the room does not already hold.
		if (destination.roomId === provenance.roomId) {
			return { allow: true };
		}

		if (destination.isGroup === undefined) {
			return {
				allow: false,
				code: "destination_unresolved",
				reason:
					"destination audience is unknown; cross-room recall requires a resolved audience",
			};
		}

		if (destination.isGroup) {
			// Openly-scoped items are not private context and may cross.
			if (OPEN_SCOPES.has(provenance.scope)) return { allow: true };
			return {
				allow: false,
				code: "policy_contract_pending",
				reason:
					"cross-surface recall into a group destination requires a destination-aware audience policy, which is not installed",
			};
		}

		return { allow: true };
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

/**
 * Read source / account / room / sender / timestamp / trust off a stored
 * memory, normalizing the surface through the connector-source registry.
 *
 * `agentId` identifies the agent so its own messages resolve to `self` trust.
 * Fields the connector never recorded stay `undefined` — this derives, it does
 * not fabricate.
 */
export function deriveCanonicalProvenance(
	memory: Memory,
	agentId: UUID,
): CanonicalProvenance {
	const metadata = asRecord(memory.metadata);
	const content = asRecord(memory.content);

	const rawSource =
		readString(metadata, "provider") ??
		readString(content, "source") ??
		readString(asRecord(metadata?.base), "source");
	const source = rawSource ? normalizeConnectorSource(rawSource) : "";

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

	const scope =
		(asRecord(metadata?.base)?.scope as MemoryScope | undefined) ??
		(metadata?.scope as MemoryScope | undefined) ??
		"global";

	return {
		source: source || rawSource || "unknown",
		rawSource,
		accountId:
			readString(metadata, "accountId") ?? readString(nested, "accountId"),
		roomId: memory.roomId,
		worldId: memory.worldId,
		senderId: memory.entityId,
		senderDisplayName,
		senderPlatformId,
		timestampMs: memory.createdAt ?? 0,
		trust,
		chatType: readString(metadata, "chatType") as MessageChatType | undefined,
		platformMessageId:
			readString(metadata, "messageIdFull") ??
			readString(nested, "messageId") ??
			readString(metadata, "sourceId"),
		scope,
	};
}

/**
 * Stable idempotency key for a canonical item: `source:account:platformRecordId`.
 *
 * Redelivery of one webhook collapses to one key. The same text arriving under
 * two connector accounts yields two keys, so account identity survives
 * de-duplication instead of being merged away. Falls back to the room+sender+
 * timestamp triple when the connector recorded no platform message id, which
 * still separates accounts but cannot claim cross-delivery idempotency.
 */
export function canonicalDedupeKey(provenance: CanonicalProvenance): string {
	const account = provenance.accountId ?? "_";
	if (provenance.platformMessageId) {
		return `${provenance.source}:${account}:${provenance.platformMessageId}`;
	}
	return `${provenance.source}:${account}:${provenance.roomId}:${provenance.senderId}:${provenance.timestampMs}`;
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
	dedupeKey: string;
	source: string;
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
	destination: RecallDestination;
	/** Health of each source that was consulted, including ones that failed. */
	sources: RecallSourceHealth[];
	/** Destination policy. Defaults to {@link failClosedRecallPolicy}. */
	policy?: CanonicalRecallPolicy;
	/** Clock injection point for freshness, defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Normalize, de-duplicate, and destination-filter a set of candidate memories
 * into one canonical recall result.
 *
 * De-duplication keeps the earliest-created member of each
 * {@link canonicalDedupeKey} group, so a redelivered webhook does not
 * double-count and does not reorder the transcript.
 *
 * Availability is derived, never asserted by the caller: any non-`ok` source
 * forces at least `partial`, and a recall with no items but a failed source is
 * `unavailable` rather than an empty success.
 */
export function buildCanonicalRecall(
	input: CanonicalRecallInput,
): CanonicalRecallResult {
	const policy = input.policy ?? failClosedRecallPolicy;
	const now = input.now ?? Date.now;

	const byKey = new Map<string, RecalledItem>();
	const withheld: WithheldItem[] = [];

	for (const memory of input.candidates) {
		const provenance = deriveCanonicalProvenance(memory, input.agentId);
		const dedupeKey = canonicalDedupeKey(provenance);

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

	const currentMs = now();
	const sources: RecallSourceHealth[] = input.sources.map((health) => {
		if (health.freshnessMs !== undefined) return health;
		const freshest = items
			.filter((item) => item.provenance.source === health.source)
			.reduce<number | undefined>((newest, item) => {
				const ts = item.provenance.timestampMs;
				return newest === undefined || ts > newest ? ts : newest;
			}, undefined);
		return freshest === undefined
			? health
			: { ...health, freshnessMs: Math.max(0, currentMs - freshest) };
	});

	const anyUnhealthy = sources.some((health) => health.state !== "ok");
	const availability: RecallAvailability = !anyUnhealthy
		? "complete"
		: items.length > 0
			? "partial"
			: "unavailable";

	return { items, withheld, sources, availability, policyId: policy.id };
}
