/** Canonical bounded, publisher-fenced connector-room membership contracts. */
import type { JsonObject, UUID } from "./primitives";
import { Service, ServiceType } from "./service";

export const MEMBERSHIP_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const MEMBERSHIP_STATES = ["active", "revoked"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];
export const MEMBERSHIP_HEALTH_STATES = [
	"current",
	"stale",
	"unavailable",
	"unsupported",
] as const;
export type MembershipHealthState = (typeof MEMBERSHIP_HEALTH_STATES)[number];
export const MEMBERSHIP_EVIDENCE_MODES = [
	"complete_snapshot",
	"ordered_delta",
	"point_query",
] as const;
export type MembershipEvidenceMode = (typeof MEMBERSHIP_EVIDENCE_MODES)[number];
export const MEMBERSHIP_REASONS = [
	"joined",
	"reconciled_present",
	"permission_restored",
	"left",
	"kicked",
	"banned",
	"permission_lost",
	"account_removed",
	"reconciled_absent",
] as const;
export type MembershipReason = (typeof MEMBERSHIP_REASONS)[number];

export interface MembershipScope {
	agentId: UUID;
	connectorId: string;
	connectorAccountId: UUID;
	externalWorldId: string;
	externalRoomId: string;
}
export interface MembershipRuntimeMapping {
	worldId: UUID | null;
	roomId: UUID | null;
	entityId: UUID | null;
}
export interface MembershipPublisherBinding {
	publisherInstanceId: string;
	publisherGeneration: number;
	evidenceMode: MembershipEvidenceMode;
}

export interface MembershipRecord
	extends MembershipScope,
		MembershipPublisherBinding {
	contractVersion: typeof MEMBERSHIP_AUTHORITY_CONTRACT_VERSION;
	canonicalPrincipalId: UUID;
	state: MembershipState;
	reason: MembershipReason;
	roles: readonly string[];
	permissionSnapshot: JsonObject;
	runtime: MembershipRuntimeMapping;
	generation: number;
	sourceVersion: number;
	sourceCursor: string;
	observedAt: string;
	validUntil: string;
	createdAt: string;
	updatedAt: string;
}

export interface MembershipScopeHealth extends MembershipScope {
	contractVersion: typeof MEMBERSHIP_AUTHORITY_CONTRACT_VERSION;
	health: MembershipHealthState;
	reason: string;
	generation: number;
	sourceVersion: number;
	sourceCursor: string | null;
	validUntil: string | null;
	publisherInstanceId: string | null;
	publisherGeneration: number | null;
	evidenceMode: MembershipEvidenceMode | null;
	observedAt: string;
	updatedAt: string;
}

interface MembershipCommandBase extends MembershipScope {
	expectedGeneration: number;
	idempotencyKey: string;
	observedAt: string;
}
export interface RegisterMembershipPublisherCommand
	extends MembershipCommandBase,
		MembershipPublisherBinding {}
interface MembershipEvidenceCommand
	extends MembershipCommandBase,
		MembershipPublisherBinding {
	sourceVersion: number;
	previousSourceCursor: string | null;
	sourceCursor: string;
	validUntil: string;
}
export interface MembershipSnapshotMember {
	canonicalPrincipalId: UUID;
	roles: readonly string[];
	permissionSnapshot: JsonObject;
	runtime: MembershipRuntimeMapping;
}
export interface ApplyCompleteMembershipSnapshotCommand
	extends MembershipEvidenceCommand {
	evidenceMode: "complete_snapshot" | "ordered_delta";
	completeness: "complete";
	members: readonly MembershipSnapshotMember[];
}
export interface ReportIncompleteMembershipSnapshotCommand
	extends MembershipCommandBase,
		MembershipPublisherBinding {
	evidenceMode: "complete_snapshot" | "ordered_delta";
	completeness: "incomplete";
	reason: string;
}
export interface ApplyMembershipCommand extends MembershipEvidenceCommand {
	evidenceMode: "ordered_delta" | "point_query";
	canonicalPrincipalId: UUID;
	state: MembershipState;
	reason: MembershipReason;
	roles: readonly string[];
	permissionSnapshot: JsonObject;
	runtime: MembershipRuntimeMapping;
}
export interface SetMembershipHealthCommand extends MembershipCommandBase {
	health: Exclude<MembershipHealthState, "current">;
	reason: string;
}

export type MembershipMutationReceipt =
	| {
			contractVersion: 1;
			operation: "publisher";
			idempotentReplay: boolean;
			committedGeneration: number;
			health: MembershipScopeHealth;
	  }
	| {
			contractVersion: 1;
			operation: "snapshot";
			idempotentReplay: boolean;
			committedGeneration: number;
			health: MembershipScopeHealth;
			memberships: readonly MembershipRecord[];
			revokedPrincipalIds: readonly UUID[];
	  }
	| {
			contractVersion: 1;
			operation: "membership";
			idempotentReplay: boolean;
			committedGeneration: number;
			membership: MembershipRecord;
	  }
	| {
			contractVersion: 1;
			operation: "health";
			idempotentReplay: boolean;
			committedGeneration: number;
			health: MembershipScopeHealth;
	  };
export type MembershipAuthorityInvalidator = (
	scope: MembershipScope,
	receipt: MembershipMutationReceipt,
) => void;
export type MembershipAuthorizationDecision =
	| {
			decision: "allowed";
			reason: "active_membership";
			generation: number;
			health: "current";
			membership: MembershipRecord;
	  }
	| {
			decision: "denied";
			reason:
				| "no_scope_evidence"
				| "authority_stale"
				| "authority_unavailable"
				| "authority_unsupported"
				| "authority_expired"
				| "membership_evidence_expired"
				| "membership_evidence_mismatch"
				| "no_membership"
				| "membership_revoked";
			generation: number | null;
			health: MembershipHealthState | null;
	  };

/** Single runtime authority for connector-room participation decisions. */
export abstract class MembershipService extends Service {
	static override readonly serviceType = ServiceType.MEMBERSHIP;
	public readonly capabilityDescription =
		"Owns bounded publisher-fenced connector-room membership evidence.";
	abstract registerPublisher(
		command: RegisterMembershipPublisherCommand,
	): Promise<MembershipMutationReceipt>;
	abstract applyCompleteSnapshot(
		command: ApplyCompleteMembershipSnapshotCommand,
	): Promise<MembershipMutationReceipt>;
	abstract reportIncompleteSnapshot(
		command: ReportIncompleteMembershipSnapshotCommand,
	): Promise<MembershipMutationReceipt>;
	abstract applyMembership(
		command: ApplyMembershipCommand,
	): Promise<MembershipMutationReceipt>;
	abstract setScopeHealth(
		command: SetMembershipHealthCommand,
	): Promise<MembershipMutationReceipt>;
	abstract authorize(
		scope: MembershipScope,
		canonicalPrincipalId: UUID,
	): Promise<MembershipAuthorizationDecision>;
	abstract getMembership(
		scope: MembershipScope,
		canonicalPrincipalId: UUID,
	): Promise<MembershipRecord | null>;
	abstract getScopeHealth(
		scope: MembershipScope,
	): Promise<MembershipScopeHealth | null>;
	abstract registerInvalidator(
		invalidator: MembershipAuthorityInvalidator,
	): () => void;
}
