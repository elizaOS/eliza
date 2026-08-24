/**
 * Canonical identity-resolution contracts shared by runtime entities,
 * connector accounts, authorization, delivery, and relationship consumers.
 * Identity mutations preserve source principals and evidence; callers resolve
 * through versioned redirects instead of rewriting or deleting history.
 */

import type { JsonObject, UUID } from "./primitives";
import { Service, ServiceType } from "./service";

export const IDENTITY_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const PRINCIPAL_KINDS = [
	"person",
	"agent",
	"service",
	"organization",
	"unknown",
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export const IDENTITY_CLAIM_VERIFICATIONS = [
	"unverified",
	"observed",
	"verified",
	"owner_bound",
] as const;
export type IdentityClaimVerification =
	(typeof IDENTITY_CLAIM_VERIFICATIONS)[number];
export const IDENTITY_CLAIM_STATUSES = [
	"active",
	"revoked",
	"superseded",
	"disputed",
] as const;
export type IdentityClaimStatus = (typeof IDENTITY_CLAIM_STATUSES)[number];
export const IDENTITY_REDIRECT_STATUSES = [
	"active",
	"superseded",
	"reverted",
] as const;
export type IdentityCanonicalRedirectStatus =
	(typeof IDENTITY_REDIRECT_STATUSES)[number];
export const IDENTITY_MERGE_OPERATIONS = ["merge", "split"] as const;
export type IdentityMergeOperation = (typeof IDENTITY_MERGE_OPERATIONS)[number];
export const IDENTITY_MERGE_STATUSES = [
	"planned",
	"committed",
	"completed",
	"reverted",
	"failed",
] as const;
export type IdentityMergeStatus = (typeof IDENTITY_MERGE_STATUSES)[number];

export interface Principal {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	id: UUID;
	agentId: UUID;
	kind: PrincipalKind;
	displayName: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The scoped-subject tuple identifies at most one principal. */
export interface IdentityClaim {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	id: UUID;
	agentId: UUID;
	principalEntityId: UUID;
	namespace: string;
	connectorId: string;
	connectorAccountId: UUID;
	externalSubjectId: string;
	handle: string | null;
	displayName: string | null;
	verification: IdentityClaimVerification;
	status: IdentityClaimStatus;
	confidence: number;
	/** Only this separately verified binding can confer owner authority. */
	ownerBindingId: string | null;
	provenance: JsonObject;
	evidence: JsonObject;
	firstSeenAt: string;
	lastSeenAt: string;
	verifiedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface IdentityClaimScope {
	agentId: UUID;
	namespace: string;
	connectorId: string;
	connectorAccountId: UUID;
	externalSubjectId: string;
}

export interface IdentityCluster {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	agentId: UUID;
	canonicalPrincipalId: UUID;
	principalIds: readonly UUID[];
	claims: readonly IdentityClaim[];
	generation: number;
	readAt: string;
}

/** Deterministic query for one principal's provider/account-scoped delivery identity. */
export interface ResolveIdentityDeliveryClaimRequest {
	agentId: UUID;
	principalId: UUID;
	/** Connector authority namespace, such as `discord`, `telegram`, or `google`. */
	connectorId?: string;
	/** Connected account whose observations are permitted to route this send. */
	connectorAccountId?: UUID;
}

/**
 * Canonical delivery lookup never guesses between verified claims. Consumers
 * may present `ambiguous` claims as choices, while `no_claim` is a hard stop
 * before provider I/O rather than permission to inspect legacy entity fields.
 */
export type IdentityDeliveryClaimResolution =
	| {
			decision: "resolved";
			requestedPrincipalId: UUID;
			canonicalPrincipalId: UUID;
			claim: IdentityClaim;
			generation: number;
	  }
	| {
			decision: "ambiguous";
			requestedPrincipalId: UUID;
			canonicalPrincipalId: UUID;
			claims: readonly IdentityClaim[];
			generation: number;
			reason: "multiple_verified_claims";
	  }
	| {
			decision: "no_claim";
			requestedPrincipalId: UUID;
			canonicalPrincipalId: UUID | null;
			generation: number | null;
			reason:
				| "principal_not_found"
				| "no_active_verified_claim"
				| "no_connector_claim"
				| "no_account_claim"
				| "connector_account_ineligible";
	  };

export interface IdentityCanonicalResolution {
	agentId: UUID;
	requestedPrincipalId: UUID;
	canonicalPrincipalId: UUID;
	redirectIds: readonly UUID[];
	generation: number;
}

export interface EvaluateOwnerBindingRequest {
	agentId: UUID;
	actorPrincipalId: UUID;
	candidateOwnerPrincipalIds: readonly UUID[];
	purpose:
		| "role_resolution"
		| "connector_account"
		| "sensitive_request"
		| "delivery";
}

export type OwnerBindingEvaluation =
	| {
			decision: "bound";
			actorCanonicalPrincipalId: UUID;
			ownerPrincipalId: UUID;
			claimId: UUID;
			ownerBindingId: string;
			generation: number;
			reason: "verified_owner_binding";
	  }
	| {
			decision: "not_bound";
			reason: "no_active_binding" | "revoked" | "disputed" | "wrong_owner";
	  }
	| {
			decision: "unavailable";
			reason: "not_implemented" | "service_unavailable" | "read_failed";
	  };

export interface IdentityCanonicalRedirect {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	id: UUID;
	agentId: UUID;
	sourcePrincipalId: UUID;
	canonicalPrincipalId: UUID;
	mergeJournalId: UUID;
	version: number;
	status: IdentityCanonicalRedirectStatus;
	createdAt: string;
	supersededAt: string | null;
}

export interface IdentityAffectedReference {
	consumer: string;
	referenceType: string;
	referenceId: string;
	principalId: UUID;
	resolution: "redirect_safe" | "projection_repair_required";
}

export interface IdentityClaimConflict {
	claimIds: readonly UUID[];
	reason: "owner_binding" | "scoped_subject" | "verification";
	details: JsonObject;
}

export interface IdentityMergePlan {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	/** The durable planned merge-journal row identifier. */
	id: UUID;
	agentId: UUID;
	operation: IdentityMergeOperation;
	canonicalPrincipalId: UUID;
	sourcePrincipalIds: readonly UUID[];
	parentJournalId: UUID | null;
	expectedGeneration: number;
	affectedReferences: readonly IdentityAffectedReference[];
	conflictingClaims: readonly IdentityClaimConflict[];
	createdAt: string;
	expiresAt: string;
}

export interface IdentityMergeResult {
	canonicalPrincipalId: UUID;
	preservedPrincipalIds: readonly UUID[];
	redirectIds: readonly UUID[];
	repairedConsumers: readonly string[];
	pendingConsumers: readonly string[];
	generation: number;
}

export interface MergeJournal {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	id: UUID;
	agentId: UUID;
	operation: IdentityMergeOperation;
	status: IdentityMergeStatus;
	parentJournalId: UUID | null;
	actorPrincipalId: UUID;
	canonicalPrincipalId: UUID;
	sourcePrincipalIds: readonly UUID[];
	plan: IdentityMergePlan;
	beforeState: JsonObject;
	result: IdentityMergeResult | null;
	reason: string;
	createdAt: string;
	committedAt: string | null;
	completedAt: string | null;
}

export interface ProposeIdentityMergeRequest {
	agentId: UUID;
	canonicalPrincipalId: UUID;
	sourcePrincipalIds: readonly UUID[];
	actorPrincipalId: UUID;
	reason: string;
	idempotencyKey: string;
	requestDigest: string;
}

export interface ConfirmIdentityMergeRequest {
	agentId: UUID;
	planId: UUID;
	expectedGeneration: number;
	actorPrincipalId: UUID;
}

export interface IdentityMergeConfirmation {
	id: UUID;
	agentId: UUID;
	planId: UUID;
	expectedGeneration: number;
	actorPrincipalId: UUID;
	planDigest: string;
	status: "active" | "consumed" | "expired" | "revoked";
	confirmedAt: string;
	expiresAt: string;
	consumedAt: string | null;
}

export interface CommitIdentityMergeRequest {
	agentId: UUID;
	planId: UUID;
	confirmationId: UUID;
	expectedGeneration: number;
	actorPrincipalId: UUID;
	idempotencyKey: string;
	requestDigest: string;
}

export interface SplitIdentityRequest {
	agentId: UUID;
	parentJournalId: UUID;
	principalIds: readonly UUID[];
	expectedGeneration: number;
	actorPrincipalId: UUID;
	reason: string;
	idempotencyKey: string;
	requestDigest: string;
}

export interface IdentityJournalPage {
	items: readonly MergeJournal[];
	nextCursor: string | null;
}

export const IDENTITY_PERSON_LINK_ACTOR_ROLES = ["OWNER", "ADMIN"] as const;
export type IdentityPersonLinkActorRole =
	(typeof IDENTITY_PERSON_LINK_ACTOR_ROLES)[number];

/** Immutable evidence that an authenticated operator attested two principals are one person. */
export interface IdentityPersonLinkAttestation {
	contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
	id: UUID;
	agentId: UUID;
	leftPrincipalId: UUID;
	rightPrincipalId: UUID;
	actorPrincipalId: UUID;
	actorRole: IdentityPersonLinkActorRole;
	authority: "authenticated_private_route";
	transport: "http" | "in_process";
	reason: string;
	idempotencyKey: string;
	requestDigest: string;
	expectedGeneration: number;
	committedGeneration: number;
	createdAt: string;
}

export interface AttestIdentityPersonLinkRequest {
	agentId: UUID;
	leftPrincipalId: UUID;
	rightPrincipalId: UUID;
	actorPrincipalId: UUID;
	actorRole: IdentityPersonLinkActorRole;
	authority: "authenticated_private_route";
	transport: "http" | "in_process";
	reason: string;
	idempotencyKey: string;
	requestDigest: string;
	expectedGeneration: number;
}

export interface VerifyIdentityPersonLinkRequest {
	agentId: UUID;
	leftPrincipalId: UUID;
	rightPrincipalId: UUID;
	expectedGeneration: number;
}

export type IdentityPersonLinkVerification =
	| {
			decision: "attested";
			generation: number;
			attestation: IdentityPersonLinkAttestation;
	  }
	| {
			decision: "not_attested";
			generation: number;
			reason: "no_attestation";
	  };

/** Single runtime authority for principals and every identity mutation. */
export abstract class PrincipalService extends Service {
	static override readonly serviceType = ServiceType.PRINCIPAL;
	public readonly capabilityDescription =
		"Owns principals, identity evidence, and reversible identity mutations.";

	abstract resolveCanonicalPrincipal(
		agentId: UUID,
		principalId: UUID,
	): Promise<IdentityCanonicalResolution>;
	abstract resolveForDisplay(
		agentId: UUID,
		principalId: UUID,
	): Promise<IdentityCanonicalResolution>;
	abstract resolveForDataAccess(
		agentId: UUID,
		principalId: UUID,
	): Promise<IdentityCanonicalResolution>;
	abstract resolveClaim(
		scope: IdentityClaimScope,
	): Promise<IdentityClaim | null>;
	abstract getCluster(
		agentId: UUID,
		principalId: UUID,
	): Promise<IdentityCluster | null>;
	abstract resolveVerifiedDeliveryClaims(
		agentId: UUID,
		principalId: UUID,
		connectorAccountId?: UUID,
	): Promise<readonly IdentityClaim[]>;
	async resolveIdentityDeliveryClaim(
		request: ResolveIdentityDeliveryClaimRequest,
	): Promise<IdentityDeliveryClaimResolution> {
		const cluster = await this.getCluster(request.agentId, request.principalId);
		if (!cluster) {
			return {
				decision: "no_claim",
				requestedPrincipalId: request.principalId,
				canonicalPrincipalId: null,
				generation: null,
				reason: "principal_not_found",
			};
		}
		const verified = cluster.claims.filter(
			(claim) =>
				claim.status === "active" &&
				(claim.verification === "verified" ||
					claim.verification === "owner_bound"),
		);
		if (verified.length === 0) {
			return {
				decision: "no_claim",
				requestedPrincipalId: request.principalId,
				canonicalPrincipalId: cluster.canonicalPrincipalId,
				generation: cluster.generation,
				reason: "no_active_verified_claim",
			};
		}
		const connectorId = request.connectorId?.trim().toLowerCase();
		const connectorClaims = connectorId
			? verified.filter(
					(claim) => claim.connectorId.trim().toLowerCase() === connectorId,
				)
			: verified;
		if (connectorClaims.length === 0) {
			return {
				decision: "no_claim",
				requestedPrincipalId: request.principalId,
				canonicalPrincipalId: cluster.canonicalPrincipalId,
				generation: cluster.generation,
				reason: "no_connector_claim",
			};
		}
		const claims = request.connectorAccountId
			? connectorClaims.filter(
					(claim) => claim.connectorAccountId === request.connectorAccountId,
				)
			: connectorClaims;
		if (claims.length === 0) {
			return {
				decision: "no_claim",
				requestedPrincipalId: request.principalId,
				canonicalPrincipalId: cluster.canonicalPrincipalId,
				generation: cluster.generation,
				reason: "no_account_claim",
			};
		}
		const ordered = [...claims].sort((left, right) =>
			left.id.localeCompare(right.id),
		);
		const claim = ordered[0];
		if (ordered.length === 1 && claim) {
			return {
				decision: "resolved",
				requestedPrincipalId: request.principalId,
				canonicalPrincipalId: cluster.canonicalPrincipalId,
				claim,
				generation: cluster.generation,
			};
		}
		return {
			decision: "ambiguous",
			requestedPrincipalId: request.principalId,
			canonicalPrincipalId: cluster.canonicalPrincipalId,
			claims: ordered,
			generation: cluster.generation,
			reason: "multiple_verified_claims",
		};
	}
	abstract evaluateOwnerBinding(
		request: EvaluateOwnerBindingRequest,
	): Promise<OwnerBindingEvaluation>;
	abstract attestPersonLink(
		request: AttestIdentityPersonLinkRequest,
	): Promise<IdentityPersonLinkAttestation>;
	abstract verifyPersonLink(
		request: VerifyIdentityPersonLinkRequest,
	): Promise<IdentityPersonLinkVerification>;
	abstract proposeMerge(
		request: ProposeIdentityMergeRequest,
	): Promise<IdentityMergePlan>;
	abstract confirmMerge(
		request: ConfirmIdentityMergeRequest,
	): Promise<IdentityMergeConfirmation>;
	abstract commitMerge(
		request: CommitIdentityMergeRequest,
	): Promise<MergeJournal>;
	abstract split(request: SplitIdentityRequest): Promise<MergeJournal>;
	abstract getJournal(
		agentId: UUID,
		journalId: UUID,
	): Promise<MergeJournal | null>;
	abstract listRedirects(
		agentId: UUID,
		principalId: UUID,
	): Promise<readonly IdentityCanonicalRedirect[]>;
	abstract listJournal(
		agentId: UUID,
		options: { limit: number; cursor: string | null },
	): Promise<IdentityJournalPage>;
}
