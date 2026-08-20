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

export interface IdentityCanonicalResolution {
	agentId: UUID;
	requestedPrincipalId: UUID;
	canonicalPrincipalId: UUID;
	redirectIds: readonly UUID[];
	generation: number;
}

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
	confirmedAt: string;
	expiresAt: string;
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

/** Single runtime authority for identity reads and reversible mutations. */
export abstract class IdentityResolutionService extends Service {
	static override readonly serviceType = ServiceType.IDENTITY_RESOLUTION;
	public readonly capabilityDescription =
		"Resolves canonical principals and performs reversible identity mutations.";

	abstract resolveCanonicalPrincipal(
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
