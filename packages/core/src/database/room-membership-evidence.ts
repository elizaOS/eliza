/**
 * Defines the fail-closed room-membership evidence policy shared by adapters.
 * Presence in the participant association table is not authorization: only a
 * fresh positive transport observation or the runtime's own structural link
 * grants room-derived access.
 */

import { ElizaError } from "../errors";
import type {
	RoomMembershipEvidence,
	RoomMembershipEvidenceUpdate,
	UUID,
} from "../types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_PATTERN =
	/^(?:runtime:local|transport:[a-z0-9][a-z0-9._-]{0,63})$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
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
		invalid("source must be runtime:local or a bounded transport identifier", {
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
			evidence.expiresAt <= evidence.observedAt)
	) {
		invalid("expiresAt must be after observedAt", {
			observedAt: evidence.observedAt,
			expiresAt: evidence.expiresAt,
		});
	}
	if (
		evidence.state === "member" &&
		evidence.source !== "runtime:local" &&
		evidence.expiresAt === undefined
	) {
		invalid("transport member evidence must expire", {
			source: evidence.source,
		});
	}
	if (evidence.source === "runtime:local" && evidence.expiresAt !== undefined) {
		invalid("runtime structural membership must not use transport expiry", {
			expiresAt: evidence.expiresAt,
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
	if (evidence.source === "runtime:local") return true;
	return evidence.expiresAt !== undefined && evidence.expiresAt > now;
}

/** Structural evidence used only for agent/runtime-owned room links. */
export function runtimeLocalMembershipEvidence(params: {
	entityId: UUID;
	roomId: UUID;
	observedAt?: number;
	generation?: number;
}): RoomMembershipEvidence {
	return {
		entityId: params.entityId,
		roomId: params.roomId,
		source: "runtime:local",
		state: "member",
		observedAt: params.observedAt ?? Date.now(),
		generation: params.generation ?? 1,
	};
}
