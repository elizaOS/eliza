/**
 * Provider-neutral group installation lifecycle: the durable state machine
 * joining a provider invite, the external group, required scopes, the owner
 * claim, and removal into one account-scoped record. Mirrors the membership
 * authority's contract discipline (types/membership.ts): versioned contracts,
 * generation counters for optimistic concurrency, idempotency keys, and
 * generation fencing so a removal at generation N cannot be resurrected by a
 * stale event observed at an earlier generation.
 */

import { ElizaError } from "../errors";
import type { JsonObject, UUID } from "../types/primitives";
import { stringToUuid } from "../utils";

export const INSTALLATION_LIFECYCLE_CONTRACT_VERSION = 1 as const;

export const INSTALLATION_STATES = [
	"invite_created",
	"provider_authorized",
	"agent_joined",
	"permissions_verifying",
	"owner_claim_pending",
	"ready",
	"degraded",
	"removed",
	"revoked",
	"failed",
] as const;
export type InstallationState = (typeof INSTALLATION_STATES)[number];

/** Capability-scoped readiness surfaces; missing optional degrades, missing required blocks ready. */
export const INSTALLATION_CAPABILITIES = [
	"receive",
	"send",
	"history",
	"attachments",
	"threads",
	"interactions",
	"membership_sync",
	"claim",
	"transport_health",
] as const;
export type InstallationCapability = (typeof INSTALLATION_CAPABILITIES)[number];

export type InstallationRemovalReason =
	| "uninstalled"
	| "kicked"
	| "revoked_by_owner"
	| "provider_expired";

export interface InstallationScope {
	agentId: UUID;
	connectorId: string;
	connectorAccountId: UUID;
	externalWorldId: string;
}

export interface InstallationCapabilityReadiness {
	capability: InstallationCapability;
	required: boolean;
	/** Opaque provider proof (e.g. a permissions-integer recheck receipt); never a raw token. */
	proof: JsonObject | null;
	verifiedAt: string | null;
}

export interface InstallationOwnerClaim {
	claimId: string;
	/** Hash of the one-time claim secret, mirroring owner-bind code hashing; the secret itself never lives here. */
	claimSecretHash: string;
	expiresAt: string;
	attemptsRemaining: number;
	claimedByEntityId: UUID | null;
}

export interface GroupInstallationRecord extends InstallationScope {
	contractVersion: typeof INSTALLATION_LIFECYCLE_CONTRACT_VERSION;
	installationId: UUID;
	/** Monotonic per-scope reinstall counter: re-creation after removal increments it. */
	reinstallVersion: number;
	/** Monotonic on every accepted mutation; events observed at a lower generation are fenced. */
	generation: number;
	state: InstallationState;
	/** Provider group label (guild name) for diagnostics only — never an authority. */
	externalGroupLabel: string | null;
	/** How provider authorization was observed for this installation. */
	providerAuthorizationEvidence: "oauth_verified" | "connector_observed" | null;
	requiredCapabilities: readonly InstallationCapability[];
	optionalCapabilities: readonly InstallationCapability[];
	capabilityReadiness: readonly InstallationCapabilityReadiness[];
	/** Runtime world this installation materialized (null until agent joins). */
	worldId: UUID | null;
	ownerClaim: InstallationOwnerClaim | null;
	/** Last removal fence: accepted-at generation of the removal that terminated this installation. */
	removedAt: string | null;
	removalReason: InstallationRemovalReason | string | null;
	createdAt: string;
	updatedAt: string;
}

export type InstallationTransitionInput =
	| { kind: "invite_created"; externalGroupLabel?: string }
	| {
			kind: "provider_authorized";
			/** How authorization was observed: OAuth-verified or connector-inferred presence. */
			evidence: "oauth_verified" | "connector_observed";
	  }
	| { kind: "agent_joined"; worldId: UUID }
	| {
			kind: "permissions_verifying";
			requiredCapabilities: readonly InstallationCapability[];
			optionalCapabilities: readonly InstallationCapability[];
	  }
	| {
			kind: "capability_proof";
			capability: InstallationCapability;
			required: boolean;
			proof: JsonObject;
			verifiedAt: string;
	  }
	| {
			kind: "owner_claim_issued";
			claimId: string;
			claimSecretHash: string;
			expiresAt: string;
	  }
	| {
			kind: "owner_claim_redeemed";
			claimId: string;
			claimSecretHash: string;
			claimedByEntityId: UUID;
	  }
	| {
			kind: "capability_degraded";
			capability: InstallationCapability;
			reason: string;
	  }
	| {
			kind: "capability_restored";
			capability: InstallationCapability;
			proof: JsonObject;
	  }
	| { kind: "removal"; reason: InstallationRemovalReason }
	| { kind: "failure"; reason: string };

export interface InstallationTransitionEvent {
	contractVersion: typeof INSTALLATION_LIFECYCLE_CONTRACT_VERSION;
	scope: InstallationScope;
	/**
	 * Installation epoch this event belongs to: the record's reinstallVersion
	 * at observation time. Events from a prior (removed/revoked/failed)
	 * installation are fenced even when their generation numbers still fit
	 * the recreated record's reset counter (epoch + generation dual fence).
	 */
	reinstallVersion: number;
	/**
	 * Observer's generation at observation time. An event observed at a
	 * generation behind the record's current generation is stale and must be
	 * rejected unless the record was re-created at a newer reinstallVersion.
	 */
	observedGeneration: number;
	observedAt: string;
	/** Connector-supplied idempotency key (e.g. provider event id) — replays return the prior receipt. */
	idempotencyKey: string;
	transition: InstallationTransitionInput;
}

export type InstallationRejectionCode =
	| "STALE_GENERATION"
	| "STALE_EPOCH"
	| "INVALID_TRANSITION"
	| "NO_INSTALLATION"
	| "CLAIM_EXPIRED"
	| "CLAIM_ATTEMPTS_EXHAUSTED"
	| "CLAIM_MISMATCH"
	| "CLAIM_SECRET_MISMATCH"
	| "CONTRACT_VERSION_MISMATCH";

export interface InstallationTransitionReceipt {
	contractVersion: typeof INSTALLATION_LIFECYCLE_CONTRACT_VERSION;
	accepted: boolean;
	record: GroupInstallationRecord;
	idempotentReplay: boolean;
	rejection?: {
		code: InstallationRejectionCode;
		message: string;
	};
}

/** Canonical forward edges from each state. */
const TRANSITIONS: Record<
	InstallationState,
	readonly InstallationTransitionInput["kind"][]
> = {
	invite_created: ["provider_authorized", "removal", "failure"],
	provider_authorized: ["agent_joined", "removal", "failure"],
	agent_joined: ["permissions_verifying", "removal", "failure"],
	permissions_verifying: [
		"capability_proof",
		"owner_claim_issued",
		"removal",
		"failure",
	],
	owner_claim_pending: [
		"owner_claim_issued",
		"owner_claim_redeemed",
		"removal",
		"failure",
	],
	ready: [
		"owner_claim_redeemed",
		"capability_proof",
		"capability_degraded",
		"removal",
		"failure",
	],
	degraded: [
		"owner_claim_redeemed",
		"capability_proof",
		"capability_restored",
		"removal",
		"failure",
	],
	removed: [],
	revoked: [],
	failed: [],
};

export function installationScopeEquals(
	a: InstallationScope,
	b: InstallationScope,
): boolean {
	return (
		a.agentId === b.agentId &&
		a.connectorId === b.connectorId &&
		a.connectorAccountId === b.connectorAccountId &&
		a.externalWorldId === b.externalWorldId
	);
}

function accept(
	record: GroupInstallationRecord,
	replay: boolean,
): InstallationTransitionReceipt {
	return {
		contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
		accepted: true,
		record,
		idempotentReplay: replay,
	};
}

function reject(
	record: GroupInstallationRecord,
	code: InstallationRejectionCode,
	message: string,
): InstallationTransitionReceipt {
	return {
		contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
		accepted: false,
		// Post-removal rejections return the terminal record untouched; the
		// caller sees the fence (removedAt/reinstallVersion) alongside the code.
		record,
		idempotentReplay: false,
		rejection: { code, message },
	};
}

/**
 * True when every required capability has a current proof, nothing proven is
 * degraded, AND the single-use owner claim has been redeemed. `ready` means
 * a claimed owner plus proven capabilities — capabilities alone never flip a
 * record to ready while the tenant owner is still unverified.
 */
function requiredCapabilitiesProven(record: GroupInstallationRecord): boolean {
	if (record.ownerClaim?.claimedByEntityId == null) return false;
	return record.requiredCapabilities.every((capability) =>
		record.capabilityReadiness.some(
			(r) => r.capability === capability && r.verifiedAt !== null,
		),
	);
}

/** True when any tracked capability lost its proof (degraded surface). */
function anyCapabilityDegraded(record: GroupInstallationRecord): boolean {
	return record.capabilityReadiness.some((r) => r.verifiedAt === null);
}

/**
 * Pure reducer: applies one transition event to a record (or creates the
 * initial record from `invite_created` when `record` is null). Deterministic
 * and side-effect free; storage adapters and in-memory hosts both drive it.
 * The reducer never consults wall-clock time; expiry checks compare
 * `observedAt` against the claim's `expiresAt` so tests and replay are
 * deterministic.
 */
export function applyInstallationTransition(
	record: GroupInstallationRecord | null,
	event: InstallationTransitionEvent,
): InstallationTransitionReceipt {
	if (record !== null && !installationScopeEquals(record, event.scope)) {
		return reject(
			record,
			"NO_INSTALLATION",
			"Event scope does not match the installation record.",
		);
	}
	if (record !== null && record.contractVersion !== event.contractVersion) {
		return reject(
			record,
			"CONTRACT_VERSION_MISMATCH",
			"Contract version mismatch; migrate before replaying.",
		);
	}
	if (record !== null && !Number.isInteger(event.reinstallVersion)) {
		return reject(
			record,
			"STALE_GENERATION",
			"Event reinstallVersion must be an integer epoch number.",
		);
	}
	if (record !== null && event.reinstallVersion < record.reinstallVersion) {
		return reject(
			record,
			"STALE_EPOCH",
			`Event from installation epoch ${event.reinstallVersion} is fenced by the live epoch ${record.reinstallVersion} (stale-event resurrection guard).`,
		);
	}
	if (record !== null && event.observedGeneration < record.generation) {
		return reject(
			record,
			"STALE_GENERATION",
			`Event observed at generation ${event.observedGeneration} is fenced by generation ${record.generation} (stale-event resurrection guard).`,
		);
	}
	if (record !== null && event.observedGeneration > record.generation) {
		return reject(
			record,
			"STALE_GENERATION",
			`Event observed at generation ${event.observedGeneration} is ahead of generation ${record.generation}; observers must not skip generations.`,
		);
	}

	if (
		record === null &&
		event.contractVersion !== INSTALLATION_LIFECYCLE_CONTRACT_VERSION
	) {
		throw new ElizaError(
			"Installation transition event contract version mismatch; no record exists to migrate.",
			{ code: "INSTALLATION_CONTRACT_VERSION_MISMATCH" },
		);
	}
	if (record === null) {
		if (event.transition.kind !== "invite_created") {
			throw new ElizaError(
				"No installation record exists for this scope; invite_created must come first.",
				{ code: "INSTALLATION_NO_RECORD" },
			);
		}
		const created: GroupInstallationRecord = {
			contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
			installationId: stringToUuid(
				`${event.scope.connectorId}:${event.scope.connectorAccountId}:${event.scope.externalWorldId}`,
			),
			reinstallVersion: 1,
			generation: 1,
			state: "invite_created",
			agentId: event.scope.agentId,
			connectorId: event.scope.connectorId,
			connectorAccountId: event.scope.connectorAccountId,
			externalWorldId: event.scope.externalWorldId,
			externalGroupLabel: event.transition.externalGroupLabel ?? null,
			providerAuthorizationEvidence: null,
			requiredCapabilities: [],
			optionalCapabilities: [],
			capabilityReadiness: [],
			worldId: null,
			ownerClaim: null,
			removedAt: null,
			removalReason: null,
			createdAt: event.observedAt,
			updatedAt: event.observedAt,
		};
		return accept(created, false);
	}

	if (!TRANSITIONS[record.state].includes(event.transition.kind)) {
		return reject(
			record,
			"INVALID_TRANSITION",
			`Transition ${event.transition.kind} is not valid from state ${record.state}.`,
		);
	}

	const next: GroupInstallationRecord = {
		...record,
		generation: record.generation + 1,
		updatedAt: event.observedAt,
	};

	switch (event.transition.kind) {
		case "invite_created":
			return reject(
				record,
				"INVALID_TRANSITION",
				"invite_created on an existing installation; use recreateInstallationAfterRemoval after a terminal state.",
			);
		case "provider_authorized":
			next.state = "provider_authorized";
			next.providerAuthorizationEvidence = event.transition.evidence;
			break;
		case "agent_joined":
			next.state = "agent_joined";
			next.worldId = event.transition.worldId;
			break;
		case "permissions_verifying":
			next.state = "permissions_verifying";
			next.requiredCapabilities = event.transition.requiredCapabilities;
			next.optionalCapabilities = event.transition.optionalCapabilities;
			next.capabilityReadiness = [];
			break;
		case "capability_proof": {
			const { capability, required, proof, verifiedAt } = event.transition;
			const retained = record.capabilityReadiness.filter(
				(r) => r.capability !== capability,
			);
			next.capabilityReadiness = [
				...retained,
				{
					capability,
					required,
					proof,
					verifiedAt,
				},
			];
			if (requiredCapabilitiesProven(next)) {
				next.state = anyCapabilityDegraded(next) ? "degraded" : "ready";
			}
			break;
		}
		case "owner_claim_issued":
			next.state = "owner_claim_pending";
			next.ownerClaim = {
				claimId: event.transition.claimId,
				claimSecretHash: event.transition.claimSecretHash,
				expiresAt: event.transition.expiresAt,
				attemptsRemaining: record.ownerClaim?.attemptsRemaining ?? 5,
				claimedByEntityId: null,
			};
			break;
		case "owner_claim_redeemed": {
			const claim = record.ownerClaim;
			const observedMs = Date.parse(event.observedAt);
			if (!claim || claim.claimId !== event.transition.claimId) {
				return reject(
					record,
					"CLAIM_MISMATCH",
					"No matching pending owner claim.",
				);
			}
			if (claim.claimedByEntityId !== null) {
				return reject(
					record,
					"CLAIM_MISMATCH",
					"Claim already redeemed (single-use).",
				);
			}
			if (claim.attemptsRemaining <= 0) {
				return reject(
					record,
					"CLAIM_ATTEMPTS_EXHAUSTED",
					"Owner claim attempts exhausted.",
				);
			}
			// Secret verification: the presenter must prove knowledge of the
			// one-time secret by presenting its hash; a mismatch burns an attempt
			// rather than silently succeeding. Expired or malformed timestamps
			// reject instead of failing open through NaN comparisons.
			if (claim.claimSecretHash !== event.transition.claimSecretHash) {
				next.ownerClaim = {
					...claim,
					attemptsRemaining: claim.attemptsRemaining - 1,
				};
				if (next.ownerClaim.attemptsRemaining <= 0) {
					next.state = "failed";
					next.removalReason = "owner claim attempts exhausted";
					return accept(next, false);
				}
				return reject(
					next,
					"CLAIM_SECRET_MISMATCH",
					"Owner claim secret hash mismatch; one attempt burned.",
				);
			}
			if (
				!Number.isFinite(observedMs) ||
				observedMs >= Date.parse(claim.expiresAt)
			) {
				return reject(record, "CLAIM_EXPIRED", "Owner claim expired.");
			}
			next.ownerClaim = {
				...claim,
				attemptsRemaining: 0,
				claimedByEntityId: event.transition.claimedByEntityId,
			};
			// Recompute readiness: a late redemption after capabilities were
			// already proven flips the record to ready/degraded now.
			if (requiredCapabilitiesProven(next)) {
				next.state = anyCapabilityDegraded(next) ? "degraded" : "ready";
			}
			break;
		}
		case "capability_degraded": {
			const { capability } = event.transition;
			next.state = "degraded";
			next.capabilityReadiness = record.capabilityReadiness.map((r) =>
				r.capability === capability ? { ...r, verifiedAt: null } : r,
			);
			break;
		}
		case "capability_restored": {
			const { capability, proof } = event.transition;
			next.capabilityReadiness = record.capabilityReadiness.map((r) =>
				r.capability === capability
					? { ...r, proof, verifiedAt: event.observedAt }
					: r,
			);
			if (requiredCapabilitiesProven(next)) {
				next.state = anyCapabilityDegraded(next) ? "degraded" : "ready";
			}
			break;
		}
		case "removal":
			next.state =
				event.transition.reason === "revoked_by_owner" ? "revoked" : "removed";
			next.removedAt = event.observedAt;
			next.removalReason = event.transition.reason;
			next.ownerClaim = null;
			next.capabilityReadiness = [];
			break;
		case "failure":
			next.state = "failed";
			next.removalReason = event.transition.reason;
			break;
	}
	return accept(next, false);
}

/**
 * Re-creation after a terminal state: bumps reinstallVersion, resets the
 * generation, and clears removal fences. A stale event from the previous
 * installation still cannot mutate the new record because it carries an
 * observedGeneration from the old generation sequence (or a mismatched
 * reinstallVersion at the storage layer).
 */
export function recreateInstallationAfterRemoval(
	record: GroupInstallationRecord,
	event: InstallationTransitionEvent,
): InstallationTransitionReceipt {
	if (
		record.state !== "removed" &&
		record.state !== "revoked" &&
		record.state !== "failed"
	) {
		return reject(
			record,
			"INVALID_TRANSITION",
			"Re-creation requires a terminal installation state.",
		);
	}
	if (event.transition.kind !== "invite_created") {
		return reject(
			record,
			"INVALID_TRANSITION",
			"Re-creation must start from invite_created.",
		);
	}
	if (record.contractVersion !== event.contractVersion) {
		return reject(
			record,
			"CONTRACT_VERSION_MISMATCH",
			"Contract version mismatch; migrate before replaying.",
		);
	}
	const created: GroupInstallationRecord = {
		...record,
		reinstallVersion: record.reinstallVersion + 1,
		generation: 1,
		state: "invite_created",
		externalGroupLabel:
			event.transition.externalGroupLabel ?? record.externalGroupLabel,
		capabilityReadiness: [],
		worldId: null,
		ownerClaim: null,
		removedAt: null,
		removalReason: null,
		updatedAt: event.observedAt,
	};
	return accept(created, false);
}

/**
 * Resurrection check for storage adapters and connectors: decides whether an
 * inbound provider event targets the live installation or a dead one. Events
 * older than the removal fence must not re-open traffic.
 */
export function isStaleAgainstRemoval(
	record: GroupInstallationRecord,
	observedAt: string,
): boolean {
	if (record.removedAt === null) return false;
	return Date.parse(observedAt) <= Date.parse(record.removedAt);
}
