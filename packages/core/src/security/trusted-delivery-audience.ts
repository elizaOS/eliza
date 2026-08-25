/**
 * Server-attested delivery-audience evidence for owner-private disclosures.
 *
 * Evidence uses an enumerable module-private symbol plus a WeakMap token, so it
 * survives ordinary in-process message spreads while JSON and request bodies
 * cannot mint or replay it. Canonical connector rooms are attested from their
 * stored room and participant set; authenticated API routes use the separate
 * host-principal attestor.
 *
 * Agent-internal turns (canonical SELF/AUTONOMOUS rooms whose actor is the
 * agent, the canonical owner, or an explicitly registered runtime-managed
 * synthetic actor) are ALLOWED for disclosure-gate purposes. Room membership
 * alone never proves synthetic identity. This is sound because this gate only
 * controls what enters the in-process turn: nothing composed here becomes
 * visible without passing the egress seams, which re-validate the CURRENT room
 * audience at delivery time.
 *
 * When a gate denial suppresses owner-private surfaces, the suppression is
 * recorded on the turn so state composition can surface an explicit note the
 * model can see — silence would read as the capabilities not existing.
 */

import { ElizaError } from "../errors";
import { resolveCanonicalOwnerIdForMessage } from "../roles";
import type { DisclosureGate } from "../types/components";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { stringToUuid } from "../utils";

const trustedDeliveryAudienceBrand: unique symbol = Symbol(
	"eliza.trusted-delivery-audience.brand",
);
const trustedDeliveryAudienceBinding: unique symbol = Symbol(
	"eliza.trusted-delivery-audience.binding",
);
const ownerExclusiveSuppressionCarrier: unique symbol = Symbol(
	"eliza.trusted-delivery-audience.suppressions",
);

export const OWNER_EXCLUSIVE_DISCLOSURE_GATE = Object.freeze({
	require: "owner_exclusive",
} as const satisfies DisclosureGate);

export const PRIVACY_DENIED_TEXT =
	"I can’t access or disclose owner-private information in this destination because its audience is not verified as owner-only.";

export type TrustedDeliveryAudienceKind =
	| "direct"
	| "group"
	| "channel"
	| "public"
	| "api_private"
	| "api_external"
	| "voice_private"
	| "voice_shared"
	| "internal_agent"
	| "unknown";

export type TrustedDeliveryAudienceProvenance =
	| "canonical_room"
	| "authenticated_owner_api"
	| "service_gateway";

/**
 * Read-only evidence returned for diagnostics and provider execution context.
 * The unexported brand prevents structural construction outside this module;
 * only the WeakMap-bound instance is authoritative for access decisions.
 */
export interface TrustedDeliveryAudience {
	readonly [trustedDeliveryAudienceBrand]: true;
	readonly attestationId: string;
	readonly kind: TrustedDeliveryAudienceKind;
	readonly provenance: TrustedDeliveryAudienceProvenance;
	readonly actorEntityId: UUID;
	readonly canonicalOwnerEntityId: UUID | null;
	readonly agentEntityId: UUID;
	readonly roomId: UUID;
	readonly participantEntityIds: readonly UUID[];
	readonly membershipVersion: string;
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
}

export type TrustedApiPrincipal =
	| {
			kind: "owner_session" | "owner_api_token";
			principalId: string;
	  }
	| {
			kind: "service_gateway";
			principalId: string;
	  };

export type OwnerExclusiveDisclosureDenial =
	| "missing_attestation"
	| "expired_attestation"
	| "future_attestation"
	| "actor_mismatch"
	| "agent_mismatch"
	| "room_mismatch"
	| "runtime_mismatch"
	| "owner_mismatch"
	| "participant_mismatch"
	| "destination_not_private"
	| "audience_changed"
	| "audience_lookup_failed";

export const OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS =
	"owner_private_destination";
export const INTERNAL_AGENT_TURN_DISCLOSURE_BASIS = "internal_agent_turn";

/**
 * Why an allowed decision is allowed: a verified owner-only destination, or an
 * agent-internal turn whose visible egress is separately re-validated. Kept as
 * a required discriminant so callers that must NOT extend internal-turn trust
 * to a visible delivery can tell the two apart.
 */
export type OwnerExclusiveDisclosureBasis =
	| typeof OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
	| typeof INTERNAL_AGENT_TURN_DISCLOSURE_BASIS;

export type OwnerExclusiveDisclosureDecision =
	| {
			allowed: true;
			basis: OwnerExclusiveDisclosureBasis;
			audience: TrustedDeliveryAudience;
	  }
	| {
			allowed: false;
			reason: OwnerExclusiveDisclosureDenial;
			audience?: TrustedDeliveryAudience;
	  };

type AudienceRecord = {
	audience: TrustedDeliveryAudience;
	runtime?: IAgentRuntime;
	sensitiveUsed: boolean;
};

type AudienceBinding = Readonly<{ token: "trusted-delivery-audience" }>;

const DEFAULT_ATTESTATION_TTL_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const audienceByBinding = new WeakMap<AudienceBinding, AudienceRecord>();
const internalActorRegistrations = new WeakMap<
	IAgentRuntime,
	Map<UUID, number>
>();
let nextAttestationSequence = 0;

/**
 * Register a synthetic actor that the runtime itself uses to originate an
 * internal turn. The returned release function is reference-counted so
 * overlapping trigger deliveries cannot revoke each other's authority.
 */
export function registerRuntimeManagedInternalActor(
	runtime: IAgentRuntime,
	actorEntityId: UUID,
): () => void {
	let registrations = internalActorRegistrations.get(runtime);
	if (!registrations) {
		registrations = new Map();
		internalActorRegistrations.set(runtime, registrations);
	}
	registrations.set(actorEntityId, (registrations.get(actorEntityId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = registrations?.get(actorEntityId);
		if (current === undefined) return;
		if (current <= 1) {
			registrations?.delete(actorEntityId);
		} else {
			registrations?.set(actorEntityId, current - 1);
		}
	};
}

function isRuntimeManagedInternalActor(
	runtime: IAgentRuntime | undefined,
	actorEntityId: UUID,
): boolean {
	return (
		runtime !== undefined &&
		internalActorRegistrations.get(runtime)?.has(actorEntityId) === true
	);
}

function normalizeTtlMs(ttlMs: number | undefined): number {
	if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
		return DEFAULT_ATTESTATION_TTL_MS;
	}
	return Math.floor(ttlMs);
}

/**
 * Drop the runtime's own synthetic actors from a disclosure candidate's
 * participant census before it becomes audience evidence. Trigger fires join
 * their per-trigger entity (`stringToUuid("trigger-entity:" + triggerId)`) to
 * the originating room as a durable participant. Persisted marker reads are
 * enabled only for an owner-private candidate; shared and external turns can
 * never pass this gate and must not pay one entity read per room member.
 * Exclusion is self-certifying, never name-based. An unreadable entity stays
 * in the census and the storage failure is reported, so the gate fails closed.
 */
async function filterRuntimeInternalParticipants(
	runtime: IAgentRuntime,
	participants: readonly UUID[],
	verifyPersistedMarkers: boolean,
): Promise<UUID[]> {
	if (!verifyPersistedMarkers) {
		return [...participants];
	}
	const processLocalFiltered = participants.filter(
		(participantId) =>
			participantId === runtime.agentId ||
			!isRuntimeManagedInternalActor(runtime, participantId),
	);
	if (processLocalFiltered.length <= 2) {
		return processLocalFiltered;
	}
	const lookupFailures: unknown[] = [];
	const kept = await Promise.all(
		processLocalFiltered.map(async (participantId) => {
			if (participantId === runtime.agentId) {
				return participantId;
			}
			try {
				const entity = await runtime.getEntityById(participantId);
				const marker = (
					entity?.metadata as
						| { triggerEntity?: { triggerId?: unknown } }
						| undefined
				)?.triggerEntity;
				if (
					typeof marker?.triggerId === "string" &&
					marker.triggerId.length > 0 &&
					stringToUuid(`trigger-entity:${marker.triggerId}`) === participantId
				) {
					return null;
				}
			} catch (cause) {
				lookupFailures.push(cause);
			}
			return participantId;
		}),
	);
	if (lookupFailures.length > 0) {
		// error-policy:J4 an entity-storage failure keeps every unreadable
		// participant and degrades owner-private surfaces to unavailable.
		runtime.reportError(
			"TrustedDeliveryAudience.filterRuntimeInternalParticipants",
			new ElizaError(
				"Could not verify runtime-internal delivery-audience participants.",
				{
					code: "DELIVERY_AUDIENCE_ENTITY_LOOKUP_FAILED",
					cause: lookupFailures[0],
					context: { failureCount: lookupFailures.length },
				},
			),
		);
	}
	return kept.filter((id): id is UUID => id !== null);
}

function canonicalParticipants(participants: readonly UUID[]): UUID[] {
	return [
		...new Set(participants.filter((id) => typeof id === "string" && id)),
	].sort((a, b) => a.localeCompare(b));
}

function membershipVersion(participants: readonly UUID[]): string {
	return JSON.stringify(canonicalParticipants(participants));
}

function sameParticipants(
	left: readonly UUID[],
	right: readonly UUID[],
): boolean {
	const a = canonicalParticipants(left);
	const b = canonicalParticipants(right);
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function classifyCanonicalRoom(
	type: string | undefined,
): TrustedDeliveryAudienceKind {
	switch (type) {
		case ChannelType.DM:
			return "direct";
		case ChannelType.GROUP:
			return "group";
		case ChannelType.VOICE_DM:
			return "voice_private";
		case ChannelType.VOICE_GROUP:
			return "voice_shared";
		case ChannelType.SELF:
		case ChannelType.AUTONOMOUS:
			return "internal_agent";
		case ChannelType.FEED:
		case ChannelType.FORUM:
		case ChannelType.THREAD:
		case ChannelType.WORLD:
			return "channel";
		case ChannelType.API:
			return "public";
		default:
			return "unknown";
	}
}

function createAudience(args: {
	kind: TrustedDeliveryAudienceKind;
	provenance: TrustedDeliveryAudienceProvenance;
	actorEntityId: UUID;
	canonicalOwnerEntityId: UUID | null;
	agentEntityId: UUID;
	roomId: UUID;
	participantEntityIds: readonly UUID[];
	nowMs: number;
	ttlMs?: number;
}): TrustedDeliveryAudience {
	const participants = Object.freeze(
		canonicalParticipants(args.participantEntityIds),
	);
	nextAttestationSequence += 1;
	return Object.freeze({
		[trustedDeliveryAudienceBrand]: true as const,
		attestationId: `${args.nowMs}:${nextAttestationSequence}`,
		kind: args.kind,
		provenance: args.provenance,
		actorEntityId: args.actorEntityId,
		canonicalOwnerEntityId: args.canonicalOwnerEntityId,
		agentEntityId: args.agentEntityId,
		roomId: args.roomId,
		participantEntityIds: participants,
		membershipVersion: membershipVersion(participants),
		issuedAtMs: args.nowMs,
		expiresAtMs: args.nowMs + normalizeTtlMs(args.ttlMs),
	});
}

function getAudienceRecord(message: Memory): AudienceRecord | undefined {
	const binding = (
		message as Memory & {
			[trustedDeliveryAudienceBinding]?: AudienceBinding;
		}
	)[trustedDeliveryAudienceBinding];
	return binding ? audienceByBinding.get(binding) : undefined;
}

function bindAudience(
	message: Memory,
	audience: TrustedDeliveryAudience,
	runtime?: IAgentRuntime,
): void {
	const existingBinding = (
		message as Memory & {
			[trustedDeliveryAudienceBinding]?: AudienceBinding;
		}
	)[trustedDeliveryAudienceBinding];
	if (existingBinding) {
		const existingRecord = audienceByBinding.get(existingBinding);
		audienceByBinding.set(existingBinding, {
			audience,
			runtime,
			sensitiveUsed:
				existingRecord !== undefined &&
				existingRecord.runtime === runtime &&
				existingRecord.sensitiveUsed === true,
		});
		return;
	}
	const binding = Object.freeze({
		token: "trusted-delivery-audience",
	}) as AudienceBinding;
	audienceByBinding.set(binding, {
		audience,
		runtime,
		sensitiveUsed: false,
	});
	// Enumerable symbol properties survive ordinary `{ ...message }` pipeline
	// clones, while JSON and request-body parsing cannot name or serialize the
	// module-private symbol.
	Object.defineProperty(message, trustedDeliveryAudienceBinding, {
		value: binding,
		enumerable: true,
		configurable: false,
		writable: false,
	});
}

/**
 * Attest a connector turn from canonical room state. Message content and
 * metadata are intentionally not consulted for destination or membership.
 */
export async function attestDeliveryAudienceFromCanonicalRoom(
	runtime: IAgentRuntime,
	message: Memory,
	options: { nowMs?: number; ttlMs?: number } = {},
): Promise<TrustedDeliveryAudience> {
	const nowMs = options.nowMs ?? Date.now();
	const [room, rawParticipants, canonicalOwnerEntityId] = await Promise.all([
		runtime.getRoom(message.roomId),
		runtime.getParticipantsForRoom(message.roomId),
		resolveCanonicalOwnerIdForMessage(runtime, message),
	]);
	const kind = classifyCanonicalRoom(room?.type);
	const ownerPrivateCandidate =
		canonicalOwnerEntityId !== null &&
		message.entityId === canonicalOwnerEntityId &&
		(kind === "direct" || kind === "voice_private");
	const participants = await filterRuntimeInternalParticipants(
		runtime,
		rawParticipants,
		ownerPrivateCandidate,
	);
	const audience = createAudience({
		kind,
		provenance: "canonical_room",
		actorEntityId: message.entityId,
		canonicalOwnerEntityId,
		agentEntityId: runtime.agentId,
		roomId: message.roomId,
		participantEntityIds: participants,
		nowMs,
		ttlMs: options.ttlMs,
	});
	bindAudience(message, audience, runtime);
	return audience;
}

/**
 * Attest an HTTP turn after the server, not the request body, has classified
 * its authenticated principal. Service-gateway callers remain external even
 * when they supply owner-looking `userId`, source, or channel labels.
 */
export async function attestAuthenticatedApiDeliveryAudience(
	runtime: IAgentRuntime,
	message: Memory,
	principal: TrustedApiPrincipal,
	options: { nowMs?: number; ttlMs?: number } = {},
): Promise<TrustedDeliveryAudience> {
	const nowMs = options.nowMs ?? Date.now();
	const [canonicalOwnerEntityId, rawParticipants] = await Promise.all([
		resolveCanonicalOwnerIdForMessage(runtime, message),
		runtime.getParticipantsForRoom(message.roomId),
	]);
	const ownerPrincipal =
		principal.kind === "owner_session" || principal.kind === "owner_api_token";
	const ownerPrivateCandidate =
		ownerPrincipal &&
		canonicalOwnerEntityId !== null &&
		message.entityId === canonicalOwnerEntityId;
	const participants = await filterRuntimeInternalParticipants(
		runtime,
		rawParticipants,
		ownerPrivateCandidate,
	);
	const audience = createAudience({
		kind: ownerPrincipal ? "api_private" : "api_external",
		provenance: ownerPrincipal ? "authenticated_owner_api" : "service_gateway",
		actorEntityId: message.entityId,
		canonicalOwnerEntityId,
		agentEntityId: runtime.agentId,
		roomId: message.roomId,
		participantEntityIds: participants,
		nowMs,
		ttlMs: options.ttlMs,
	});
	bindAudience(message, audience, runtime);
	return audience;
}

/** Return the trusted evidence attached to this exact in-memory turn. */
export function getTrustedDeliveryAudience(
	message: Memory | undefined,
): TrustedDeliveryAudience | undefined {
	return message ? getAudienceRecord(message)?.audience : undefined;
}

/** Whether this turn's process-local evidence was minted by this runtime. */
export function trustedDeliveryAudienceIsBoundToRuntime(
	message: Memory,
	runtime: IAgentRuntime,
): boolean {
	return getAudienceRecord(message)?.runtime === runtime;
}

function decisionFromAudience(
	message: Memory,
	audience: TrustedDeliveryAudience | undefined,
	nowMs: number,
	internalActorTrusted = false,
): OwnerExclusiveDisclosureDecision {
	if (!audience) {
		return { allowed: false, reason: "missing_attestation" };
	}
	if (audience.issuedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
		return { allowed: false, reason: "future_attestation", audience };
	}
	if (audience.expiresAtMs <= nowMs) {
		return { allowed: false, reason: "expired_attestation", audience };
	}
	if (audience.actorEntityId !== message.entityId) {
		return { allowed: false, reason: "actor_mismatch", audience };
	}
	if (!message.agentId || audience.agentEntityId !== message.agentId) {
		return { allowed: false, reason: "agent_mismatch", audience };
	}
	if (audience.roomId !== message.roomId) {
		return { allowed: false, reason: "room_mismatch", audience };
	}
	// Agent-internal turns must clear the gate BEFORE the owner/participant
	// checks: a SELF/AUTONOMOUS room can never look like a two-party owner DM.
	// Sound because every visible egress path re-validates the delivery
	// audience — see the module header. Only canonical-room provenance
	// qualifies: an API principal cannot label its own turn "internal".
	if (audience.kind === "internal_agent") {
		const actorIsRuntimeIdentity =
			audience.actorEntityId === audience.agentEntityId ||
			(audience.canonicalOwnerEntityId !== null &&
				audience.actorEntityId === audience.canonicalOwnerEntityId);
		if (
			audience.provenance === "canonical_room" &&
			(actorIsRuntimeIdentity || internalActorTrusted) &&
			audience.participantEntityIds.includes(audience.actorEntityId) &&
			audience.participantEntityIds.includes(audience.agentEntityId)
		) {
			return {
				allowed: true,
				basis: INTERNAL_AGENT_TURN_DISCLOSURE_BASIS,
				audience,
			};
		}
		return { allowed: false, reason: "destination_not_private", audience };
	}
	if (
		!audience.canonicalOwnerEntityId ||
		audience.actorEntityId !== audience.canonicalOwnerEntityId
	) {
		return { allowed: false, reason: "owner_mismatch", audience };
	}
	if (
		audience.actorEntityId === audience.agentEntityId ||
		audience.participantEntityIds.length !== 2 ||
		!audience.participantEntityIds.includes(audience.actorEntityId) ||
		!audience.participantEntityIds.includes(audience.agentEntityId)
	) {
		return { allowed: false, reason: "participant_mismatch", audience };
	}
	if (
		audience.kind !== "direct" &&
		audience.kind !== "voice_private" &&
		audience.kind !== "api_private"
	) {
		return { allowed: false, reason: "destination_not_private", audience };
	}
	if (
		audience.kind === "api_private" &&
		audience.provenance !== "authenticated_owner_api"
	) {
		return { allowed: false, reason: "destination_not_private", audience };
	}
	if (
		(audience.kind === "direct" || audience.kind === "voice_private") &&
		audience.provenance !== "canonical_room"
	) {
		return { allowed: false, reason: "destination_not_private", audience };
	}
	return {
		allowed: true,
		basis: OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
		audience,
	};
}

/**
 * Suppression bookkeeping shares the enumerable-symbol trick used for the
 * audience binding: the Set rides ordinary in-process spreads (clone and
 * original share one Set), while JSON cannot name or serialize it. Recording
 * happens only at real suppression sites — the action-gate disclosure check
 * and the sensitive-provider/mode-action authorization — never on plain
 * queries, so the note reflects surfaces the turn actually lost.
 */
function ownerExclusiveSuppressions(
	message: Memory,
	create: boolean,
): Set<OwnerExclusiveDisclosureDenial> | undefined {
	const holder = message as Memory & {
		[ownerExclusiveSuppressionCarrier]?: Set<OwnerExclusiveDisclosureDenial>;
	};
	let reasons = holder[ownerExclusiveSuppressionCarrier];
	if (!reasons && create) {
		reasons = new Set();
		Object.defineProperty(message, ownerExclusiveSuppressionCarrier, {
			value: reasons,
			enumerable: true,
			configurable: false,
			writable: false,
		});
	}
	return reasons;
}

/** Record that an owner-private surface was withheld from this exact turn. */
export function recordOwnerExclusiveSuppression(
	message: Memory,
	reason: OwnerExclusiveDisclosureDenial,
): void {
	ownerExclusiveSuppressions(message, true)?.add(reason);
}

/**
 * Model-visible note appended to composed state when this turn had
 * owner-private surfaces suppressed. Silence would read to the model as the
 * capabilities not existing; the note lets it answer honestly instead of
 * fabricating either the data or a permanent inability.
 */
export function ownerExclusiveSuppressionNote(
	message: Memory | undefined,
): string | undefined {
	if (!message) return undefined;
	const reasons = ownerExclusiveSuppressions(message, false);
	if (!reasons || reasons.size === 0) return undefined;
	return [
		"# Owner-private access notice",
		`Owner-private tools and context were withheld from this turn because the delivery audience is not verified as owner-only (${[...reasons].sort().join(", ")}).`,
		"If they are needed, say the information is only available in the owner's verified private channel. Never guess or fabricate the withheld information.",
	].join("\n");
}

/** Synchronous gate used by catalogs and other pre-execution exposure paths. */
export function evaluateOwnerExclusiveDisclosure(
	message: Memory | undefined,
	nowMs = Date.now(),
): OwnerExclusiveDisclosureDecision {
	if (!message) {
		return { allowed: false, reason: "missing_attestation" };
	}
	const record = getAudienceRecord(message);
	return decisionFromAudience(
		message,
		record?.audience,
		nowMs,
		isRuntimeManagedInternalActor(record?.runtime, message.entityId),
	);
}

/**
 * Re-read canonical room membership before sensitive provider/action execution
 * and before visible egress. API-private turns also re-read room membership:
 * authentication proves the caller, but it cannot make a shared conversation
 * an owner-only destination.
 */
export async function revalidateOwnerExclusiveDisclosure(
	runtime: IAgentRuntime,
	message: Memory,
	nowMs = Date.now(),
): Promise<OwnerExclusiveDisclosureDecision> {
	const record = getAudienceRecord(message);
	if (!record) {
		return decisionFromAudience(message, undefined, nowMs);
	}
	if (record.runtime !== runtime) {
		return {
			allowed: false,
			reason: "runtime_mismatch",
			audience: record.audience,
		};
	}
	const initial = decisionFromAudience(
		message,
		record.audience,
		nowMs,
		isRuntimeManagedInternalActor(runtime, message.entityId),
	);
	if (!initial.allowed) return initial;

	try {
		const [rawParticipants, canonicalOwnerEntityId] = await Promise.all([
			runtime.getParticipantsForRoom(message.roomId),
			resolveCanonicalOwnerIdForMessage(runtime, message),
		]);
		// The attested census excluded runtime-internal synthetic actors, so the
		// revalidation must compare like with like — otherwise a room that ever
		// hosted a trigger fire flips every later check to audience_changed.
		const participants = await filterRuntimeInternalParticipants(
			runtime,
			rawParticipants,
			initial.basis === OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
		);
		const room =
			initial.audience.provenance === "canonical_room"
				? await runtime.getRoom(message.roomId)
				: undefined;
		if (
			(initial.audience.provenance === "canonical_room" &&
				classifyCanonicalRoom(room?.type) !== initial.audience.kind) ||
			canonicalOwnerEntityId !== initial.audience.canonicalOwnerEntityId ||
			!sameParticipants(participants, initial.audience.participantEntityIds)
		) {
			return {
				allowed: false,
				reason: "audience_changed",
				audience: initial.audience,
			};
		}
		return initial;
	} catch (cause) {
		// error-policy:J4 canonical audience lookup failure degrades only
		// owner-private components to a visibly unavailable state.
		runtime.reportError(
			"TrustedDeliveryAudience.revalidate",
			new ElizaError(
				"Could not revalidate the owner-private delivery audience.",
				{
					code: "DELIVERY_AUDIENCE_LOOKUP_FAILED",
					cause,
					context: {
						attestationId: initial.audience.attestationId,
						roomId: message.roomId,
					},
				},
			),
		);
		return {
			allowed: false,
			reason: "audience_lookup_failed",
			audience: initial.audience,
		};
	}
}

/** Revalidate and mark that this turn has consumed owner-private information. */
export async function authorizeOwnerExclusiveDisclosure(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<OwnerExclusiveDisclosureDecision> {
	const decision = await revalidateOwnerExclusiveDisclosure(runtime, message);
	if (decision.allowed) {
		const record = getAudienceRecord(message);
		if (record) record.sensitiveUsed = true;
	} else {
		recordOwnerExclusiveSuppression(message, decision.reason);
	}
	return decision;
}

export function markOwnerExclusiveDisclosureUsed(message: Memory): void {
	const record = getAudienceRecord(message);
	if (record) record.sensitiveUsed = true;
}

export function ownerExclusiveDisclosureWasUsed(message: Memory): boolean {
	return getAudienceRecord(message)?.sensitiveUsed === true;
}

/** Stable process-local partition for in-flight provider coalescing. */
export function trustedDeliveryAudienceCacheKey(message: Memory): string {
	const audience = getAudienceRecord(message)?.audience;
	return audience
		? [audience.attestationId, audience.provenance, audience.kind].join(":")
		: "unattested";
}

/**
 * Apply a component's owner-exclusive disclosure policy.
 *
 * Scoped to the `owner_exclusive` gate variant only: the min-over-members
 * `audience_admission` variant is evaluated in the access-control layer
 * (`audienceAdmissionGateFailure`), which owns the value dependency on the
 * policy core, so this security-layer function stays free of an access-control
 * import cycle. A non-owner-exclusive gate is a no-op here (the action-gate
 * routes it to the admission evaluator instead), never a mis-evaluation.
 */
export function disclosureGateFailure(
	gate: DisclosureGate | undefined,
	message: Memory | undefined,
): string | undefined {
	if (gate?.require !== "owner_exclusive") return undefined;
	const decision = evaluateOwnerExclusiveDisclosure(message);
	if (decision.allowed) return undefined;
	// A non-undefined return here IS a suppressed surface (the action-gate
	// drops the action), so this call site doubles as the recording point.
	if (message) recordOwnerExclusiveSuppression(message, decision.reason);
	return `Owner-private disclosure denied: ${decision.reason}`;
}
