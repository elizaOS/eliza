/**
 * Canonical connector-room membership authority contracts. Connector evidence
 * advances one fenced scope state machine; protected operations fail closed
 * whenever that evidence is absent, revoked, stale, unavailable, or explicitly
 * unsupported.
 */

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
	/** Provider organization, server, workspace, tenant, or world identifier. */
	externalWorldId: string;
	externalRoomId: string;
}

export interface MembershipRuntimeMapping {
	worldId: UUID | null;
	roomId: UUID | null;
	entityId: UUID | null;
}

export interface MembershipRecord extends MembershipScope {
	contractVersion: typeof MEMBERSHIP_AUTHORITY_CONTRACT_VERSION;
	canonicalPrincipalId: UUID;
	state: MembershipState;
	reason: MembershipReason;
	roles: readonly string[];
	permissionSnapshot: JsonObject;
	runtime: MembershipRuntimeMapping;
	generation: number;
	sourceVersion: number;
	sourceCursor: string | null;
	observedAt: string;
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
	observedAt: string;
	updatedAt: string;
}

interface MembershipFencedCommand extends MembershipScope {
	expectedGeneration: number;
	sourceVersion: number;
	sourceCursor: string | null;
	idempotencyKey: string;
	observedAt: string;
}

export interface ApplyMembershipCommand extends MembershipFencedCommand {
	canonicalPrincipalId: UUID;
	state: MembershipState;
	reason: MembershipReason;
	roles: readonly string[];
	permissionSnapshot: JsonObject;
	runtime: MembershipRuntimeMapping;
}

export interface SetMembershipHealthCommand extends MembershipFencedCommand {
	health: MembershipHealthState;
	reason: string;
}

export type MembershipMutationReceipt =
	| {
			contractVersion: typeof MEMBERSHIP_AUTHORITY_CONTRACT_VERSION;
			operation: "membership";
			idempotentReplay: boolean;
			committedGeneration: number;
			membership: MembershipRecord;
	  }
	| {
			contractVersion: typeof MEMBERSHIP_AUTHORITY_CONTRACT_VERSION;
			operation: "health";
			idempotentReplay: boolean;
			committedGeneration: number;
			health: MembershipScopeHealth;
	  };

/** Security-cache invalidator run synchronously before observers see a commit. */
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
				| "no_membership"
				| "membership_revoked";
			generation: number | null;
			health: MembershipHealthState | null;
	  };

/** Single runtime authority for connector-room participation decisions. */
export abstract class MembershipService extends Service {
	static override readonly serviceType = ServiceType.MEMBERSHIP;
	public readonly capabilityDescription =
		"Owns version-fenced connector-room membership and reconciliation health.";

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
