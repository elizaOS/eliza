/**
 * Defines the fail-closed room-membership evidence policy shared by adapters.
 * Presence in the participant association table is not authorization: only a
 * fresh positive transport observation grants room-derived access.
 */

import { ElizaError } from "../errors";
import type {
	Entity,
	Room,
	RoomMembershipEvidence,
	RoomMembershipEvidenceAuthority,
	RoomMembershipEvidenceUpdate,
} from "../types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_PATTERN =
	/^transport:[a-z0-9][a-z0-9._-]{0,63}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const ROOM_MEMBERSHIP_TRANSPORT_MAX_TTL_MS = 15 * 60 * 1_000;
const EVIDENCE_STATES = new Set([
	"member",
	"nonmember",
	"indeterminate",
	"unsupported",
	"unavailable",
]);

function invalid(reason: string, context: Record<string, unknown>): never {
	throw new ElizaError(`Room membership evidence is invalid: ${reason}`, {
		code: "ROOM_MEMBERSHIP_EVIDENCE_INVALID",
		context,
	});
}

/** Validate a complete connector-authored membership observation. */
export function validateRoomMembershipEvidence(
	evidence: RoomMembershipEvidence,
): void {
	if (
		!UUID_PATTERN.test(evidence.entityId) ||
		!UUID_PATTERN.test(evidence.roomId)
	) {
		invalid("entityId and roomId must be UUIDs", {
			entityId: evidence.entityId,
			roomId: evidence.roomId,
		});
	}
	if (!SOURCE_PATTERN.test(evidence.source)) {
		invalid("source must be a bounded transport identifier", {
			source: evidence.source,
		});
	}
	if (!EVIDENCE_STATES.has(evidence.state)) {
		invalid("state is not recognized", { state: evidence.state });
	}
	if (
		!Number.isSafeInteger(evidence.observedAt) ||
		evidence.observedAt < 0 ||
		!Number.isSafeInteger(evidence.generation) ||
		evidence.generation < 1
	) {
		invalid(
			"observedAt and generation must be non-negative monotonic integers",
			{
				observedAt: evidence.observedAt,
				generation: evidence.generation,
			},
		);
	}
	if (
		evidence.expiresAt !== undefined &&
		(!Number.isSafeInteger(evidence.expiresAt) ||
			evidence.expiresAt <= evidence.observedAt ||
			evidence.expiresAt - evidence.observedAt >
				ROOM_MEMBERSHIP_TRANSPORT_MAX_TTL_MS)
	) {
		invalid("expiresAt must be after observedAt and within the maximum TTL", {
			observedAt: evidence.observedAt,
			expiresAt: evidence.expiresAt,
			maxTtlMs: ROOM_MEMBERSHIP_TRANSPORT_MAX_TTL_MS,
		});
	}
	if (evidence.state === "member" && evidence.expiresAt === undefined) {
		invalid("transport member evidence must expire", {
			source: evidence.source,
		});
	}
	if (
		evidence.cursor !== undefined &&
		(evidence.cursor.length < 1 || evidence.cursor.length > 1_024)
	) {
		invalid("cursor must contain 1 to 1024 characters", {
			cursorLength: evidence.cursor.length,
		});
	}
}

/** Validate the compare-and-swap generation transition before storage. */
export function validateRoomMembershipEvidenceUpdate(
	update: RoomMembershipEvidenceUpdate,
): void {
	validateRoomMembershipEvidence(update.evidence);
	if (
		update.expectedGeneration !== null &&
		(!Number.isSafeInteger(update.expectedGeneration) ||
			update.expectedGeneration < 1)
	) {
		invalid("expectedGeneration must be null or a positive integer", {
			expectedGeneration: update.expectedGeneration,
		});
	}
	const requiredGeneration =
		update.expectedGeneration === null ? 1 : update.expectedGeneration + 1;
	if (update.evidence.generation !== requiredGeneration) {
		invalid("next generation must immediately follow the expected generation", {
			expectedGeneration: update.expectedGeneration,
			generation: update.evidence.generation,
		});
	}
	if (update.authority) {
		if (
			!UUID_PATTERN.test(update.authority.agentId) ||
			!update.authority.connectorAccountId.trim() ||
			update.authority.connectorAccountId.length > 256 ||
			update.authority.connectorSources.length === 0 ||
			update.authority.connectorSources.some(
				(source) => !source.trim() || source.length > 64,
			)
		) {
			invalid("publisher authority is malformed", {
				agentId: update.authority.agentId,
				sourceCount: update.authority.connectorSources.length,
			});
		}
	}
}

/** Validate persisted room/entity ownership inside the adapter's atomic write. */
export function validateRoomMembershipEvidenceAuthority(
	authority: RoomMembershipEvidenceAuthority,
	room: Room | null,
	entity: Entity | null,
): void {
	const sources = new Set(
		authority.connectorSources.map((source) => source.trim().toLowerCase()),
	);
	if (
		!room ||
		room.agentId !== authority.agentId ||
		!sources.has(room.source.trim().toLowerCase())
	) {
		throw new ElizaError(
			"Membership publisher does not own the persisted room",
			{
				code: "ROOM_MEMBERSHIP_PUBLISHER_ROOM_FORBIDDEN",
				context: { roomId: room?.id, agentId: authority.agentId },
			},
		);
	}
	if (room.metadata?.connectorAccountId !== authority.connectorAccountId) {
		throw new ElizaError(
			"Membership publisher does not own the persisted connector account",
			{
				code: "ROOM_MEMBERSHIP_PUBLISHER_ACCOUNT_FORBIDDEN",
				context: { roomId: room.id, agentId: authority.agentId },
			},
		);
	}
	if (!entity || entity.agentId !== authority.agentId) {
		throw new ElizaError(
			"Membership publisher does not own the persisted entity",
			{
				code: "ROOM_MEMBERSHIP_PUBLISHER_ENTITY_FORBIDDEN",
				context: { entityId: entity?.id, agentId: authority.agentId },
			},
		);
	}
}

/** Reject source takeover and out-of-order observations after CAS succeeds. */
export function validateRoomMembershipEvidenceSuccessor(
	current: RoomMembershipEvidence | null,
	next: RoomMembershipEvidence,
): void {
	if (!current) return;
	if (current.source !== next.source) {
		invalid("source cannot change within one room association", {
			currentSource: current.source,
			nextSource: next.source,
		});
	}
	if (next.observedAt < current.observedAt) {
		invalid("observedAt cannot move backwards", {
			currentObservedAt: current.observedAt,
			nextObservedAt: next.observedAt,
		});
	}
}

/** True only for evidence that currently grants a room-derived entitlement. */
export function isCurrentRoomMembershipEvidence(
	evidence: RoomMembershipEvidence,
	now = Date.now(),
): boolean {
	validateRoomMembershipEvidence(evidence);
	if (evidence.state !== "member") return false;
	if (evidence.observedAt > now + MAX_CLOCK_SKEW_MS) return false;
	return evidence.expiresAt !== undefined && evidence.expiresAt > now;
}
