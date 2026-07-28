/**
 * Household coordination policy over the runtime graph, approval queue, and
 * commitment ledger. The service turns mutable scheduling discussions into
 * version-pinned proposals and activates an agreement only after every named
 * adult approves those exact proposal bytes.
 */
import crypto from "node:crypto";
import {
  type EntityStore,
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import {
  type Entity,
  type Relationship,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import { createLifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
import {
  cancelHouseholdGrantExpiryWarning,
  ensureHouseholdGrantExpiryWarning,
  type HouseholdGrantExpiryWarningReceipt,
} from "./grant-expiry-warning.js";
import { HouseholdCoordinationRepository } from "./repository.js";
import {
  HOUSEHOLD_ACCESS_SCOPES,
  type HouseholdAccessGrant,
  type HouseholdAccessScope,
  type HouseholdAuditRecord,
  HouseholdCoordinationError,
  type HouseholdCoordinationHead,
  type HouseholdExportScheduleEntry,
  type HouseholdProposalApproval,
  type HouseholdRole,
  type HouseholdRoleBinding,
  type HouseholdScheduleAgreement,
  type HouseholdScheduleProposal,
  type HouseholdScheduleTerms,
  type HouseholdScopedExport,
  isHouseholdRole,
  materialScheduleFingerprint,
  normalizeGrantScopes,
  normalizeHouseholdIdentifier,
  normalizeHouseholdIdentifiers,
  normalizeScheduleTerms,
  uniqueStrings,
} from "./types.js";

const HOUSEHOLD_ROLE_METADATA_KEY = "householdRole";
const HOUSEHOLD_SUBJECTS_METADATA_KEY = "householdSubjectEntityIds";
const DEFAULT_PROPOSAL_TTL_MS = 48 * 60 * 60 * 1000;
export const HOUSEHOLD_COORDINATION_SERVICE = "lifeops_household_coordination";

export interface HouseholdCoordinationDependencies {
  runtime: IAgentRuntime;
  agentId: string;
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  approvalQueue: ApprovalQueue;
  repository: HouseholdCoordinationRepository;
  scheduledTasks?: ScheduledTaskRunnerHandle;
  now?: () => Date;
}

export interface CreateHouseholdProposalInput {
  proposalId?: string;
  coordinationId: string;
  terms: HouseholdScheduleTerms;
  affectedPartyEntityIds: string[];
  requiredApproverEntityIds: string[];
  createdByEntityId: string;
  baseAgreementVersion?: number;
  expiresAt?: string | null;
}

export interface ReviseHouseholdProposalInput {
  proposalId: string;
  expectedVersion: number;
  terms: HouseholdScheduleTerms;
  affectedPartyEntityIds: string[];
  requiredApproverEntityIds: string[];
  revisedByEntityId: string;
  expiresAt?: string | null;
}

function roleRelationshipType(role: HouseholdRole): string {
  if (role === "co_parent") return "co_parent_of";
  if (role === "current_partner") return "partner_of";
  if (role === "child") return "parent_of";
  if (role === "caregiver") return "delegates_care_to";
  if (role === "professional") return "client_of";
  return "knows";
}

function readRoleMetadata(relationship: Relationship): HouseholdRole | null {
  const value = relationship.metadata?.[HOUSEHOLD_ROLE_METADATA_KEY];
  return typeof value === "string" && isHouseholdRole(value) ? value : null;
}

function readSubjectMetadata(relationship: Relationship): string[] {
  const value = relationship.metadata?.[HOUSEHOLD_SUBJECTS_METADATA_KEY];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new HouseholdCoordinationError(
      `Relationship ${relationship.relationshipId} has invalid household subjects`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { relationshipId: relationship.relationshipId },
    );
  }
  return uniqueStrings(value);
}

function validateFutureExpiry(
  expiresAt: string | null | undefined,
  now: Date,
): string | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new HouseholdCoordinationError(
      "expiresAt must be a future ISO-8601 timestamp",
      "HOUSEHOLD_INVALID_CONTRACT",
      { expiresAt },
    );
  }
  return new Date(timestamp).toISOString();
}

function proposalExpiry(
  expiresAt: string | null | undefined,
  now: Date,
): string {
  if (expiresAt !== null && expiresAt !== undefined) {
    const explicit = validateFutureExpiry(expiresAt, now);
    if (explicit) return explicit;
  }
  return new Date(now.getTime() + DEFAULT_PROPOSAL_TTL_MS).toISOString();
}

function nonNegativeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new HouseholdCoordinationError(
      `${field} must be an integer greater than or equal to ${minimum}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value;
}

function recordContainsAnyEntity(
  value: unknown,
  entityIds: ReadonlySet<string>,
): boolean {
  if (typeof value === "string") return entityIds.has(value);
  if (Array.isArray(value)) {
    return value.some((entry) => recordContainsAnyEntity(entry, entityIds));
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) =>
    recordContainsAnyEntity(entry, entityIds),
  );
}

function latestProposalVersions(
  proposals: readonly HouseholdScheduleProposal[],
): HouseholdScheduleProposal[] {
  return Array.from(
    proposals.reduce((latest, proposal) => {
      const current = latest.get(proposal.proposalId);
      if (!current || current.version < proposal.version) {
        latest.set(proposal.proposalId, proposal);
      }
      return latest;
    }, new Map<string, HouseholdScheduleProposal>()),
  ).map(([, proposal]) => proposal);
}

function approvalPayloadMatches(
  request: ApprovalRequest,
  proposal: HouseholdScheduleProposal,
  partyEntityId: string,
): boolean {
  if (request.action !== "execute_workflow") return false;
  if (request.payload.action !== "execute_workflow") return false;
  if (request.payload.workflowId !== "household.schedule.proposal.approval") {
    return false;
  }
  return (
    request.payload.input.proposalId === proposal.proposalId &&
    request.payload.input.proposalVersion === proposal.version &&
    request.payload.input.coordinationId === proposal.coordinationId &&
    request.payload.input.partyEntityId === partyEntityId &&
    request.payload.input.contentSha256 === proposal.contentSha256
  );
}

function proposalContentSha256(
  proposal: Omit<
    HouseholdScheduleProposal,
    "contentSha256" | "status" | "materialChange" | "createdAt" | "updatedAt"
  >,
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        agentId: proposal.agentId,
        proposalId: proposal.proposalId,
        version: proposal.version,
        coordinationId: proposal.coordinationId,
        baseAgreementVersion: proposal.baseAgreementVersion,
        terms: proposal.terms,
        affectedPartyEntityIds: proposal.affectedPartyEntityIds,
        requiredApproverEntityIds: proposal.requiredApproverEntityIds,
        createdByEntityId: proposal.createdByEntityId,
        expiresAt: proposal.expiresAt,
      }),
    )
    .digest("hex");
}

function approvalIdempotencyKey(
  proposal: HouseholdScheduleProposal,
  partyEntityId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        proposal.agentId,
        proposal.proposalId,
        String(proposal.version),
        partyEntityId,
        proposal.contentSha256,
      ].join("\0"),
    )
    .digest("hex");
  return `household-proposal-approval:${digest}`;
}

export class HouseholdCoordinationService {
  private readonly now: () => Date;

  constructor(private readonly deps: HouseholdCoordinationDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  private scheduledTasks() {
    return (
      this.deps.scheduledTasks ??
      getScheduledTaskRunner(this.deps.runtime, {
        agentId: this.deps.agentId,
        now: this.now,
      })
    );
  }

  async reconcileGrantExpiryWarnings(): Promise<
    HouseholdGrantExpiryWarningReceipt[]
  > {
    const now = this.now();
    const grants = await this.deps.repository.listGrants();
    const receipts: HouseholdGrantExpiryWarningReceipt[] = [];
    for (const grant of grants) {
      try {
        receipts.push(
          grant.revokedAt
            ? await cancelHouseholdGrantExpiryWarning({
                grant,
                repository: this.deps.repository,
                scheduledTasks: this.scheduledTasks(),
                now,
              })
            : await ensureHouseholdGrantExpiryWarning({
                grant,
                repository: this.deps.repository,
                scheduledTasks: this.scheduledTasks(),
                now,
              }),
        );
      } catch (error) {
        // error-policy:J7 the durable warning/cancellation outbox remains
        // pending; one grant failure must not prevent the same scheduler tick
        // from repairing every other household grant.
        const reason = grant.revokedAt
          ? "cancellation_failure"
          : "materialization_failure";
        this.deps.runtime.reportError(
          "HouseholdCoordination.reconcileGrantExpiryWarning",
          error,
          {
            grantId: grant.id,
            reason,
            recovery: "lifeops_scheduler_tick",
          },
        );
        receipts.push({
          outcome: "deferred",
          grantId: grant.id,
          reason,
          failedAt: now.toISOString(),
          autoExtend: false,
        });
      }
    }
    return receipts;
  }

  private async terminallyInvalidateApprovalRequests(
    requestIds: readonly string[],
    invalidationContext: string,
  ): Promise<void> {
    for (const requestId of uniqueStrings(requestIds)) {
      const request = await this.deps.approvalQueue.byId(requestId);
      if (!request) {
        throw new HouseholdCoordinationError(
          `Approval request ${requestId} referenced by household state is missing`,
          "HOUSEHOLD_STALE_APPROVAL",
          { requestId, invalidationContext },
        );
      }
      if (request.state === "pending" || request.state === "approved") {
        await this.deps.approvalQueue.markExpired(requestId);
        continue;
      }
      if (request.state === "rejected" || request.state === "expired") {
        continue;
      }
      throw new HouseholdCoordinationError(
        `Approval request ${requestId} cannot be invalidated from ${request.state}`,
        "HOUSEHOLD_STALE_APPROVAL",
        {
          requestId,
          approvalState: request.state,
          invalidationContext,
        },
      );
    }
  }

  private async reconcilePersistedApprovalInvalidations(): Promise<void> {
    const pendingProposals = (
      await this.deps.repository.listProposals()
    ).filter((proposal) => proposal.status === "pending");
    for (const proposal of pendingProposals) {
      const links = await this.deps.repository.listApprovalLinks(
        proposal.proposalId,
        proposal.version,
      );
      for (const link of links) {
        if (link.invalidatedAt) continue;
        const request = await this.deps.approvalQueue.byId(
          link.approvalRequestId,
        );
        if (!request) {
          throw new HouseholdCoordinationError(
            `Approval request ${link.approvalRequestId} referenced by household state is missing`,
            "HOUSEHOLD_STALE_APPROVAL",
            {
              proposalId: proposal.proposalId,
              proposalVersion: proposal.version,
              partyEntityId: link.partyEntityId,
              approvalRequestId: link.approvalRequestId,
            },
          );
        }
        if (request.state !== "rejected") continue;
        if (
          request.subjectUserId !== link.partyEntityId ||
          request.resolvedBy !== link.partyEntityId ||
          !request.resolvedAt ||
          !request.resolutionReason?.trim() ||
          !approvalPayloadMatches(request, proposal, link.partyEntityId)
        ) {
          throw new HouseholdCoordinationError(
            "Rejected approval row does not match the exact household proposal and party",
            "HOUSEHOLD_STALE_APPROVAL",
            {
              proposalId: proposal.proposalId,
              proposalVersion: proposal.version,
              partyEntityId: link.partyEntityId,
              approvalRequestId: link.approvalRequestId,
            },
          );
        }
        const invalidatedRequestIds = await this.deps.repository.rejectProposal(
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId: link.partyEntityId,
            reason: request.resolutionReason,
            rejectedAt: request.resolvedAt.toISOString(),
          },
        );
        await this.terminallyInvalidateApprovalRequests(
          invalidatedRequestIds,
          `recovered rejected household proposal ${proposal.proposalId} v${proposal.version}`,
        );
        break;
      }
    }
    await this.terminallyInvalidateApprovalRequests(
      await this.deps.repository.listInvalidatedApprovalRequestIds(),
      "persisted household proposal invalidation",
    );
  }

  private async expireProposalIfLapsed(
    proposal: HouseholdScheduleProposal,
    at: Date,
  ): Promise<boolean> {
    if (
      proposal.status !== "pending" ||
      !proposal.expiresAt ||
      Date.parse(proposal.expiresAt) > at.getTime()
    ) {
      return false;
    }
    const invalidatedRequestIds = await this.deps.repository.expireProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      expiredAt: at.toISOString(),
    });
    await this.terminallyInvalidateApprovalRequests(
      invalidatedRequestIds,
      `expired household proposal ${proposal.proposalId} v${proposal.version}`,
    );
    return true;
  }

  private async requireEntity(entityId: string): Promise<Entity> {
    const normalizedEntityId = normalizeHouseholdIdentifier(
      entityId,
      "entityId",
    );
    const entity =
      normalizedEntityId === SELF_ENTITY_ID
        ? await this.deps.entityStore.ensureSelf()
        : await this.deps.entityStore.get(normalizedEntityId);
    if (!entity) {
      throw new HouseholdCoordinationError(
        `Household entity ${normalizedEntityId} was not found`,
        "HOUSEHOLD_ENTITY_NOT_FOUND",
        { entityId: normalizedEntityId },
      );
    }
    return entity;
  }

  private async requireEntities(entityIds: readonly string[]): Promise<void> {
    for (const entityId of normalizeHouseholdIdentifiers(
      entityIds,
      "entityIds",
    )) {
      await this.requireEntity(entityId);
    }
  }

  async bindRole(input: {
    entityId: string;
    role: HouseholdRole;
    subjectEntityIds?: string[];
    relationshipId?: string | null;
    evidence: string;
    boundByEntityId: string;
  }): Promise<HouseholdRoleBinding> {
    const entityId = normalizeHouseholdIdentifier(input.entityId, "entityId");
    const boundByEntityId = normalizeHouseholdIdentifier(
      input.boundByEntityId,
      "boundByEntityId",
    );
    const relationshipId =
      input.relationshipId === null || input.relationshipId === undefined
        ? null
        : normalizeHouseholdIdentifier(input.relationshipId, "relationshipId");
    await this.requireEntity(entityId);
    await this.requireEntity(boundByEntityId);
    const subjectEntityIds = normalizeHouseholdIdentifiers(
      input.subjectEntityIds ?? [],
      "subjectEntityIds",
    );
    await this.requireEntities(subjectEntityIds);
    if (boundByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may bind household roles",
        "HOUSEHOLD_ACCESS_DENIED",
        { boundByEntityId },
      );
    }

    const now = this.now().toISOString();
    if (input.role === "owner") {
      if (entityId !== SELF_ENTITY_ID) {
        throw new HouseholdCoordinationError(
          "The owner role is reserved for the self entity",
          "HOUSEHOLD_INVALID_CONTRACT",
          { entityId },
        );
      }
      const binding: HouseholdRoleBinding = {
        entityId: SELF_ENTITY_ID,
        role: "owner",
        relationshipId: null,
        subjectEntityIds,
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.repository.appendAudit({
        kind: "household_role_bound",
        ownerId: SELF_ENTITY_ID,
        reason: input.evidence,
        inputs: { entityId: SELF_ENTITY_ID, role: "owner" },
        decision: { subjectEntityIds },
        actor: "user",
        createdAt: now,
      });
      return binding;
    }

    let relationship: Relationship;
    if (relationshipId) {
      const existing = await this.deps.relationshipStore.get(relationshipId);
      if (!existing) {
        throw new HouseholdCoordinationError(
          `Relationship ${relationshipId} is unavailable`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { relationshipId },
        );
      }
      if (existing.status !== "active") {
        throw new HouseholdCoordinationError(
          `Relationship ${relationshipId} is unavailable`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { relationshipId },
        );
      }
      const endpointIds = new Set([existing.fromEntityId, existing.toEntityId]);
      if (!endpointIds.has(SELF_ENTITY_ID) || !endpointIds.has(entityId)) {
        throw new HouseholdCoordinationError(
          "Household role relationship must connect self and the principal",
          "HOUSEHOLD_INVALID_CONTRACT",
          {
            relationshipId: existing.relationshipId,
            entityId,
          },
        );
      }
      relationship = await this.deps.relationshipStore.upsert({
        relationshipId: existing.relationshipId,
        fromEntityId: existing.fromEntityId,
        toEntityId: existing.toEntityId,
        type: existing.type,
        metadata: {
          ...existing.metadata,
          [HOUSEHOLD_ROLE_METADATA_KEY]: input.role,
          [HOUSEHOLD_SUBJECTS_METADATA_KEY]: subjectEntityIds,
        },
        state: existing.state,
        evidence: uniqueStrings([...existing.evidence, input.evidence]),
        confidence: Math.max(existing.confidence, 1),
        source: "user_chat",
        status: "active",
      });
    } else {
      relationship = await this.deps.relationshipStore.observe({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: entityId,
        type: roleRelationshipType(input.role),
        metadataPatch: {
          [HOUSEHOLD_ROLE_METADATA_KEY]: input.role,
          [HOUSEHOLD_SUBJECTS_METADATA_KEY]: subjectEntityIds,
        },
        evidence: [input.evidence],
        confidence: 1,
        occurredAt: now,
        source: "user_chat",
      });
    }
    const binding: HouseholdRoleBinding = {
      entityId,
      role: input.role,
      relationshipId: relationship.relationshipId,
      subjectEntityIds,
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
    };
    await this.deps.repository.appendAudit({
      kind: "household_role_bound",
      ownerId: relationship.relationshipId,
      reason: input.evidence,
      inputs: {
        entityId,
        role: input.role,
        relationshipId: relationship.relationshipId,
      },
      decision: { subjectEntityIds },
      actor: "user",
      createdAt: now,
    });
    return binding;
  }

  async listRoleBindings(): Promise<HouseholdRoleBinding[]> {
    const self = await this.deps.entityStore.ensureSelf();
    const relationships = await this.deps.relationshipStore.list();
    const bindings: HouseholdRoleBinding[] = [
      {
        entityId: SELF_ENTITY_ID,
        role: "owner",
        relationshipId: null,
        subjectEntityIds: [],
        createdAt: self.createdAt,
        updatedAt: self.updatedAt,
      },
    ];
    for (const relationship of relationships) {
      if (relationship.status !== "active") continue;
      const role = readRoleMetadata(relationship);
      if (!role) continue;
      const entityId =
        relationship.fromEntityId === SELF_ENTITY_ID
          ? relationship.toEntityId
          : relationship.toEntityId === SELF_ENTITY_ID
            ? relationship.fromEntityId
            : null;
      if (!entityId) {
        throw new HouseholdCoordinationError(
          `Household relationship ${relationship.relationshipId} does not connect to self`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { relationshipId: relationship.relationshipId },
        );
      }
      bindings.push({
        entityId,
        role,
        relationshipId: relationship.relationshipId,
        subjectEntityIds: readSubjectMetadata(relationship),
        createdAt: relationship.createdAt,
        updatedAt: relationship.updatedAt,
      });
    }
    return bindings.sort((left, right) =>
      left.entityId.localeCompare(right.entityId),
    );
  }

  private async requireRoleBinding(
    entityId: string,
    role?: HouseholdRole,
  ): Promise<HouseholdRoleBinding> {
    const bindings = await this.listRoleBindings();
    const binding = bindings.find(
      (candidate) =>
        candidate.entityId === entityId &&
        (role === undefined || candidate.role === role),
    );
    if (!binding) {
      throw new HouseholdCoordinationError(
        `Entity ${entityId} has no matching household role`,
        "HOUSEHOLD_ACCESS_DENIED",
        { entityId, role },
      );
    }
    return binding;
  }

  async issueGrant(input: {
    principalEntityId: string;
    role: HouseholdRole;
    subjectEntityIds: string[];
    scopes: HouseholdAccessScope[];
    issuedByEntityId: string;
    expiresAt?: string | null;
  }): Promise<HouseholdAccessGrant> {
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const issuedByEntityId = normalizeHouseholdIdentifier(
      input.issuedByEntityId,
      "issuedByEntityId",
    );
    const subjectEntityIds = normalizeHouseholdIdentifiers(
      input.subjectEntityIds,
      "subjectEntityIds",
    );
    await this.requireEntities([
      principalEntityId,
      issuedByEntityId,
      ...subjectEntityIds,
    ]);
    if (issuedByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may issue access grants",
        "HOUSEHOLD_ACCESS_DENIED",
        { issuedByEntityId },
      );
    }
    const binding = await this.requireRoleBinding(
      principalEntityId,
      input.role,
    );
    const scopes = normalizeGrantScopes(input.role, input.scopes);
    if (input.role !== "owner") {
      const outsideRelationship = subjectEntityIds.filter(
        (subjectId) => !binding.subjectEntityIds.includes(subjectId),
      );
      if (outsideRelationship.length > 0) {
        throw new HouseholdCoordinationError(
          "Grant subjects must stay inside the principal's household relationship",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            principalEntityId,
            role: input.role,
            outsideRelationship,
          },
        );
      }
    }
    if (
      scopes.some((scope) => scope.startsWith("calendar.")) &&
      subjectEntityIds.length === 0 &&
      input.role !== "owner"
    ) {
      throw new HouseholdCoordinationError(
        "Calendar grants require at least one scoped household subject",
        "HOUSEHOLD_INVALID_CONTRACT",
        { principalEntityId },
      );
    }
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const grant: HouseholdAccessGrant = {
      id: `hgrant_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      principalEntityId,
      relationshipId: binding.relationshipId,
      role: input.role,
      subjectEntityIds,
      scopes,
      issuedByEntityId,
      expiresAt: validateFutureExpiry(input.expiresAt, nowDate),
      revokedAt: null,
      revokedByEntityId: null,
      revocationReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repository.insertGrant(grant, {
      kind: "household_grant_issued",
      ownerId: grant.id,
      reason: "Owner granted explicit household access.",
      inputs: {
        principalEntityId: grant.principalEntityId,
        role: grant.role,
        subjectEntityIds: grant.subjectEntityIds,
      },
      decision: {
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
      },
      actor: "user",
      createdAt: now,
    });
    try {
      await ensureHouseholdGrantExpiryWarning({
        grant,
        repository: this.deps.repository,
        scheduledTasks: this.scheduledTasks(),
        now: nowDate,
      });
    } catch (error) {
      // error-policy:J1 boundary translation — grant issuance and its warning
      // intent commit atomically. The committed grant is authoritative while
      // startup reconciliation owns delivery, so returning it prevents a
      // caller retry from creating duplicate access.
      this.deps.runtime.reportError(
        "HouseholdCoordination.grantExpiryWarning",
        error,
        {
          grantId: grant.id,
          principalEntityId: grant.principalEntityId,
          expiresAt: grant.expiresAt,
          recovery: "startup_reconciliation",
        },
      );
    }
    return grant;
  }

  async revokeGrant(input: {
    grantId: string;
    revokedByEntityId: string;
    reason: string;
  }): Promise<HouseholdAccessGrant> {
    const grantId = normalizeHouseholdIdentifier(input.grantId, "grantId");
    const revokedByEntityId = normalizeHouseholdIdentifier(
      input.revokedByEntityId,
      "revokedByEntityId",
    );
    await this.requireEntity(revokedByEntityId);
    if (revokedByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may revoke access grants",
        "HOUSEHOLD_ACCESS_DENIED",
        { revokedByEntityId },
      );
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new HouseholdCoordinationError(
        "Grant revocation requires a reason",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    const grant = await this.deps.repository.revokeGrant({
      id: grantId,
      revokedAt: this.now().toISOString(),
      revokedByEntityId,
      reason,
    });
    try {
      await cancelHouseholdGrantExpiryWarning({
        grant,
        repository: this.deps.repository,
        scheduledTasks: this.scheduledTasks(),
        now: this.now(),
      });
    } catch (error) {
      // error-policy:J1 access revocation is already atomically committed with
      // a cancellation outbox intent. Surface the repair path without
      // pretending the access mutation rolled back or inviting a duplicate
      // revoke request.
      this.deps.runtime.reportError(
        "HouseholdCoordination.grantExpiryWarningCancellation",
        error,
        {
          grantId: grant.id,
          revokedAt: grant.revokedAt,
          recovery: "lifeops_scheduler_tick",
        },
      );
    }
    return grant;
  }

  private async grantIsActive(
    grant: HouseholdAccessGrant,
    at: Date,
  ): Promise<boolean> {
    if (grant.revokedAt) return false;
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= at.getTime()) {
      return false;
    }
    if (grant.relationshipId) {
      const relationship = await this.deps.relationshipStore.get(
        grant.relationshipId,
      );
      if (!relationship) return false;
      if (relationship.status !== "active") return false;
      if (readRoleMetadata(relationship) !== grant.role) return false;
      if (grant.role !== "owner") {
        const currentSubjects = readSubjectMetadata(relationship);
        if (
          grant.subjectEntityIds.some(
            (subjectId) => !currentSubjects.includes(subjectId),
          )
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private async activeGrants(
    principalEntityId: string,
    at: Date,
  ): Promise<HouseholdAccessGrant[]> {
    const grants = await this.deps.repository.listGrants(principalEntityId);
    const active: HouseholdAccessGrant[] = [];
    for (const grant of grants) {
      if (await this.grantIsActive(grant, at)) active.push(grant);
    }
    return active;
  }

  async requireScope(input: {
    principalEntityId: string;
    scope: HouseholdAccessScope;
    subjectEntityId?: string;
    at?: Date;
  }): Promise<void> {
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const subjectEntityId =
      input.subjectEntityId === undefined
        ? undefined
        : normalizeHouseholdIdentifier(
            input.subjectEntityId,
            "subjectEntityId",
          );
    if (principalEntityId === SELF_ENTITY_ID) {
      await this.requireEntity(SELF_ENTITY_ID);
      return;
    }
    await this.requireEntity(principalEntityId);
    const at = input.at ?? this.now();
    const grants = await this.deps.repository.listGrants(principalEntityId);
    const matching = grants.filter(
      (grant) =>
        grant.scopes.includes(input.scope) &&
        (subjectEntityId === undefined ||
          grant.subjectEntityIds.includes(subjectEntityId)),
    );
    for (const grant of matching) {
      if (await this.grantIsActive(grant, at)) return;
    }
    if (matching.some((grant) => grant.revokedAt !== null)) {
      throw new HouseholdCoordinationError(
        "Household access grant has been revoked",
        "HOUSEHOLD_GRANT_REVOKED",
        {
          principalEntityId,
          scope: input.scope,
          subjectEntityId,
        },
      );
    }
    if (
      matching.some(
        (grant) =>
          grant.expiresAt !== null &&
          Date.parse(grant.expiresAt) <= at.getTime(),
      )
    ) {
      throw new HouseholdCoordinationError(
        "Household access grant has expired",
        "HOUSEHOLD_GRANT_EXPIRED",
        {
          principalEntityId,
          scope: input.scope,
          subjectEntityId,
        },
      );
    }
    throw new HouseholdCoordinationError(
      "Household access scope is not granted",
      "HOUSEHOLD_ACCESS_DENIED",
      {
        principalEntityId,
        scope: input.scope,
        subjectEntityId,
      },
    );
  }

  private async validateProposalParties(input: {
    terms: HouseholdScheduleTerms;
    affectedPartyEntityIds: string[];
    requiredApproverEntityIds: string[];
    createdByEntityId: string;
  }): Promise<{
    affectedPartyEntityIds: string[];
    requiredApproverEntityIds: string[];
  }> {
    const custody = input.terms.custodyException;
    const custodyParties = custody
      ? [custody.normalCustodianEntityId, custody.substituteCustodianEntityId]
      : [];
    const createdByEntityId = normalizeHouseholdIdentifier(
      input.createdByEntityId,
      "createdByEntityId",
    );
    const explicitlyAffectedEntityIds = normalizeHouseholdIdentifiers(
      [...input.affectedPartyEntityIds, ...input.terms.childEntityIds],
      "affectedPartyEntityIds",
    );
    const requestedApproverEntityIds = normalizeHouseholdIdentifiers(
      input.requiredApproverEntityIds,
      "requiredApproverEntityIds",
    );
    const normalizedCustodyParties = normalizeHouseholdIdentifiers(
      custodyParties,
      "custodyApproverEntityIds",
    );
    await this.requireEntities([
      createdByEntityId,
      ...input.terms.childEntityIds,
      ...explicitlyAffectedEntityIds,
      ...requestedApproverEntityIds,
      ...normalizedCustodyParties,
    ]);
    for (const childEntityId of input.terms.childEntityIds) {
      await this.requireRoleBinding(childEntityId, "child");
    }
    const affectedAdultEntityIds: string[] = [];
    for (const entityId of explicitlyAffectedEntityIds) {
      const binding = await this.requireRoleBinding(entityId);
      if (binding.role !== "child") affectedAdultEntityIds.push(entityId);
    }
    const requiredApproverEntityIds = uniqueStrings([
      ...requestedApproverEntityIds,
      ...normalizedCustodyParties,
      ...affectedAdultEntityIds,
    ]);
    if (requiredApproverEntityIds.length === 0) {
      throw new HouseholdCoordinationError(
        "At least one affected adult must approve a household proposal",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    const affectedPartyEntityIds = uniqueStrings([
      ...explicitlyAffectedEntityIds,
      ...requiredApproverEntityIds,
    ]);
    for (const approverEntityId of requiredApproverEntityIds) {
      const binding = await this.requireRoleBinding(approverEntityId);
      if (binding.role === "child") {
        throw new HouseholdCoordinationError(
          "Child household members cannot be required approvers",
          "HOUSEHOLD_INVALID_CONTRACT",
          { approverEntityId },
        );
      }
      const outsideRelationship =
        binding.role === "owner"
          ? []
          : input.terms.childEntityIds.filter(
              (childEntityId) =>
                !binding.subjectEntityIds.includes(childEntityId),
            );
      if (outsideRelationship.length > 0) {
        throw new HouseholdCoordinationError(
          "Household approvers must have an explicit relationship to every affected child",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            approverEntityId,
            outsideRelationship,
          },
        );
      }
    }
    const mutationSubjects =
      input.terms.childEntityIds.length > 0
        ? input.terms.childEntityIds
        : affectedPartyEntityIds.filter(
            (entityId) => entityId !== createdByEntityId,
          );
    if (createdByEntityId !== SELF_ENTITY_ID && mutationSubjects.length === 0) {
      await this.requireScope({
        principalEntityId: createdByEntityId,
        scope: "calendar.mutate",
      });
    }
    for (const subjectEntityId of mutationSubjects) {
      await this.requireScope({
        principalEntityId: createdByEntityId,
        scope: "calendar.mutate",
        subjectEntityId,
      });
    }
    return { affectedPartyEntityIds, requiredApproverEntityIds };
  }

  private async enqueueApprovals(
    proposal: HouseholdScheduleProposal,
  ): Promise<HouseholdProposalApproval[]> {
    const existing = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const approvals: HouseholdProposalApproval[] = [];
    for (const partyEntityId of proposal.requiredApproverEntityIds) {
      const existingApproval = existing.find(
        (candidate) =>
          candidate.partyEntityId === partyEntityId &&
          candidate.invalidatedAt === null,
      );
      if (existingApproval) {
        approvals.push(existingApproval);
        continue;
      }
      const request = await this.deps.approvalQueue.enqueue({
        idempotencyKey: approvalIdempotencyKey(proposal, partyEntityId),
        requestedBy: proposal.createdByEntityId,
        subjectUserId: partyEntityId,
        action: "execute_workflow",
        payload: {
          action: "execute_workflow",
          workflowId: "household.schedule.proposal.approval",
          input: {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            coordinationId: proposal.coordinationId,
            partyEntityId,
            contentSha256: proposal.contentSha256,
          },
        },
        channel: "internal",
        reason: `Approve household schedule proposal ${proposal.proposalId} v${proposal.version}`,
        expiresAt: new Date(
          proposal.expiresAt ??
            new Date(
              Date.parse(proposal.createdAt) + DEFAULT_PROPOSAL_TTL_MS,
            ).toISOString(),
        ),
      });
      const now = this.now().toISOString();
      const approval: HouseholdProposalApproval = {
        id: `happroval_${crypto.randomUUID()}`,
        agentId: this.deps.agentId,
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId,
        approvalRequestId: request.id,
        invalidatedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      approvals.push(await this.deps.repository.insertApprovalLink(approval));
    }
    return approvals;
  }

  async ensureProposalApprovals(
    proposalId: string,
    proposalVersion: number,
  ): Promise<HouseholdProposalApproval[]> {
    const normalizedProposalId = normalizeHouseholdIdentifier(
      proposalId,
      "proposalId",
    );
    const normalizedProposalVersion = nonNegativeInteger(
      proposalVersion,
      "proposalVersion",
      1,
    );
    await this.reconcilePersistedApprovalInvalidations();
    const proposal = await this.deps.repository.getProposal(
      normalizedProposalId,
      normalizedProposalVersion,
    );
    if (!proposal) {
      throw new HouseholdCoordinationError(
        `Proposal ${normalizedProposalId} v${normalizedProposalVersion} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        {
          proposalId: normalizedProposalId,
          proposalVersion: normalizedProposalVersion,
        },
      );
    }
    if (await this.expireProposalIfLapsed(proposal, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    if (proposal.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal ${normalizedProposalId} v${normalizedProposalVersion} is ${proposal.status}`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: normalizedProposalId,
          proposalVersion: normalizedProposalVersion,
          status: proposal.status,
        },
      );
    }
    return await this.enqueueApprovals(proposal);
  }

  async createProposal(
    input: CreateHouseholdProposalInput,
  ): Promise<HouseholdScheduleProposal> {
    const terms = normalizeScheduleTerms(input.terms);
    const createdByEntityId = normalizeHouseholdIdentifier(
      input.createdByEntityId,
      "createdByEntityId",
    );
    const parties = await this.validateProposalParties({
      terms,
      affectedPartyEntityIds: input.affectedPartyEntityIds,
      requiredApproverEntityIds: input.requiredApproverEntityIds,
      createdByEntityId,
    });
    const coordinationId = normalizeHouseholdIdentifier(
      input.coordinationId,
      "coordinationId",
    );
    const proposalId =
      input.proposalId === undefined
        ? `hproposal_${crypto.randomUUID()}`
        : normalizeHouseholdIdentifier(input.proposalId, "proposalId");
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const head = await this.deps.repository.ensureHead(coordinationId, now);
    const baseAgreementVersion =
      input.baseAgreementVersion === undefined
        ? head.currentAgreementVersion
        : nonNegativeInteger(
            input.baseAgreementVersion,
            "baseAgreementVersion",
          );
    if (baseAgreementVersion !== head.currentAgreementVersion) {
      throw new HouseholdCoordinationError(
        "Proposal baseAgreementVersion does not match the current agreement",
        "HOUSEHOLD_STALE_BASE_AGREEMENT",
        {
          coordinationId,
          baseAgreementVersion,
          currentAgreementVersion: head.currentAgreementVersion,
        },
      );
    }
    const proposalContent: Omit<
      HouseholdScheduleProposal,
      "contentSha256" | "status" | "materialChange" | "createdAt" | "updatedAt"
    > = {
      proposalId,
      agentId: this.deps.agentId,
      version: 1,
      coordinationId,
      baseAgreementVersion,
      terms,
      affectedPartyEntityIds: parties.affectedPartyEntityIds,
      requiredApproverEntityIds: parties.requiredApproverEntityIds,
      createdByEntityId,
      expiresAt: proposalExpiry(input.expiresAt, nowDate),
    };
    const proposal: HouseholdScheduleProposal = {
      ...proposalContent,
      contentSha256: proposalContentSha256(proposalContent),
      status: "pending",
      materialChange: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repository.insertProposal(proposal, {
      kind: "household_proposal_created",
      ownerId: proposal.proposalId,
      reason: "Household schedule proposal created for affected-party review.",
      inputs: {
        proposalVersion: proposal.version,
        coordinationId: proposal.coordinationId,
        affectedPartyEntityIds: proposal.affectedPartyEntityIds,
        createdByEntityId: proposal.createdByEntityId,
      },
      decision: {
        baseAgreementVersion: proposal.baseAgreementVersion,
        requiredApproverEntityIds: proposal.requiredApproverEntityIds,
        contentSha256: proposal.contentSha256,
      },
      actor: "user",
      createdAt: now,
    });
    try {
      await this.enqueueApprovals(proposal);
    } catch (error) {
      // error-policy:J2 The proposal is durable; surface its identity so the
      // boundary can call ensureProposalApprovals without recreating it.
      throw new HouseholdCoordinationError(
        `Proposal ${proposal.proposalId} persisted but its approval requests could not be completed`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
        },
        error,
      );
    }
    return proposal;
  }

  async reviseProposal(
    input: ReviseHouseholdProposalInput,
  ): Promise<HouseholdScheduleProposal> {
    const proposalId = normalizeHouseholdIdentifier(
      input.proposalId,
      "proposalId",
    );
    const expectedVersion = nonNegativeInteger(
      input.expectedVersion,
      "expectedVersion",
      1,
    );
    const revisedByEntityId = normalizeHouseholdIdentifier(
      input.revisedByEntityId,
      "revisedByEntityId",
    );
    await this.reconcilePersistedApprovalInvalidations();
    const previous = await this.deps.repository.getProposal(proposalId);
    if (!previous) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        { proposalId },
      );
    }
    if (previous.version !== expectedVersion || previous.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} changed concurrently`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          expectedVersion,
          actualVersion: previous.version,
          status: previous.status,
        },
      );
    }
    if (await this.expireProposalIfLapsed(previous, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: previous.proposalId,
          proposalVersion: previous.version,
          expiresAt: previous.expiresAt,
        },
      );
    }
    if (previous.createdByEntityId !== revisedByEntityId) {
      await this.requireScope({
        principalEntityId: revisedByEntityId,
        scope: "calendar.mutate",
        subjectEntityId: previous.terms.childEntityIds[0],
      });
    }
    const terms = normalizeScheduleTerms(input.terms);
    const parties = await this.validateProposalParties({
      terms,
      affectedPartyEntityIds: input.affectedPartyEntityIds,
      requiredApproverEntityIds: input.requiredApproverEntityIds,
      createdByEntityId: revisedByEntityId,
    });
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const materialChange =
      materialScheduleFingerprint(previous.terms) !==
        materialScheduleFingerprint(terms) ||
      JSON.stringify(previous.affectedPartyEntityIds) !==
        JSON.stringify(parties.affectedPartyEntityIds) ||
      JSON.stringify(previous.requiredApproverEntityIds) !==
        JSON.stringify(parties.requiredApproverEntityIds);
    const nextContent: Omit<
      HouseholdScheduleProposal,
      "contentSha256" | "status" | "materialChange" | "createdAt" | "updatedAt"
    > = {
      ...previous,
      version: previous.version + 1,
      terms,
      affectedPartyEntityIds: parties.affectedPartyEntityIds,
      requiredApproverEntityIds: parties.requiredApproverEntityIds,
      createdByEntityId: revisedByEntityId,
      expiresAt: proposalExpiry(input.expiresAt, nowDate),
    };
    const next: HouseholdScheduleProposal = {
      ...nextContent,
      contentSha256: proposalContentSha256(nextContent),
      status: "pending",
      materialChange,
      createdAt: now,
      updatedAt: now,
    };
    const invalidatedRequestIds = await this.deps.repository.reviseProposal(
      previous,
      next,
    );
    await this.terminallyInvalidateApprovalRequests(
      invalidatedRequestIds,
      `superseded household proposal ${previous.proposalId} v${previous.version}`,
    );
    try {
      await this.enqueueApprovals(next);
    } catch (error) {
      // error-policy:J2 The revision is durable and older approval bytes are
      // invalid, so expose the exact retry identity instead of rolling back.
      throw new HouseholdCoordinationError(
        `Proposal ${next.proposalId} v${next.version} persisted but its approval requests could not be completed`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: next.proposalId,
          proposalVersion: next.version,
        },
        error,
      );
    }
    return next;
  }

  async respondToProposal(input: {
    proposalId: string;
    proposalVersion: number;
    partyEntityId: string;
    approvalRequestId: string;
    decision: "approve" | "reject";
    reason: string;
  }): Promise<ApprovalRequest> {
    const proposalId = normalizeHouseholdIdentifier(
      input.proposalId,
      "proposalId",
    );
    const proposalVersion = nonNegativeInteger(
      input.proposalVersion,
      "proposalVersion",
      1,
    );
    const partyEntityId = normalizeHouseholdIdentifier(
      input.partyEntityId,
      "partyEntityId",
    );
    const approvalRequestId = normalizeHouseholdIdentifier(
      input.approvalRequestId,
      "approvalRequestId",
    );
    const reason = input.reason.trim();
    if (!reason) {
      throw new HouseholdCoordinationError(
        "Household proposal responses require an auditable reason",
        "HOUSEHOLD_INVALID_CONTRACT",
        {
          proposalId,
          proposalVersion,
          partyEntityId,
        },
      );
    }
    await this.reconcilePersistedApprovalInvalidations();
    const proposal = await this.deps.repository.getProposal(
      proposalId,
      proposalVersion,
    );
    if (!proposal) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} v${proposalVersion} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        {
          proposalId,
          proposalVersion,
        },
      );
    }
    if (await this.expireProposalIfLapsed(proposal, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    if (proposal.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal is ${proposal.status}, not pending`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          status: proposal.status,
        },
      );
    }
    const links = await this.deps.repository.listApprovalLinks(
      proposalId,
      proposalVersion,
    );
    const link = links.find(
      (candidate) => candidate.partyEntityId === partyEntityId,
    );
    if (
      !link ||
      link.invalidatedAt ||
      link.approvalRequestId !== approvalRequestId
    ) {
      throw new HouseholdCoordinationError(
        "Approval is missing or no longer valid for this proposal version",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId,
          proposalVersion,
          partyEntityId,
          approvalRequestId,
        },
      );
    }
    const request = await this.deps.approvalQueue.byId(approvalRequestId);
    if (
      !request ||
      request.subjectUserId !== partyEntityId ||
      !approvalPayloadMatches(request, proposal, partyEntityId)
    ) {
      throw new HouseholdCoordinationError(
        "Approval request does not match the exact household proposal and party",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId,
          proposalVersion,
          partyEntityId,
          approvalRequestId,
        },
      );
    }
    const resolution = {
      resolvedBy: partyEntityId,
      resolutionReason: reason,
    };
    if (input.decision === "approve") {
      return await this.deps.approvalQueue.approve(
        approvalRequestId,
        resolution,
      );
    }
    const rejectedRequest = await this.deps.approvalQueue.reject(
      approvalRequestId,
      resolution,
    );
    const invalidatedRequestIds = await this.deps.repository.rejectProposal({
      proposalId,
      proposalVersion,
      partyEntityId,
      reason,
      rejectedAt: this.now().toISOString(),
    });
    await this.terminallyInvalidateApprovalRequests(
      invalidatedRequestIds,
      `rejected household proposal ${proposalId} v${proposalVersion}`,
    );
    return rejectedRequest;
  }

  private async verifyExactApprovals(
    proposal: HouseholdScheduleProposal,
  ): Promise<string[]> {
    const actualContentSha256 = proposalContentSha256(proposal);
    if (actualContentSha256 !== proposal.contentSha256) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposal.proposalId} v${proposal.version} content no longer matches its approval hash`,
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          approvedContentSha256: proposal.contentSha256,
          actualContentSha256,
        },
      );
    }
    const links = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const approvedBy: string[] = [];
    for (const partyEntityId of proposal.requiredApproverEntityIds) {
      const link = links.find(
        (candidate) => candidate.partyEntityId === partyEntityId,
      );
      if (!link || link.invalidatedAt) {
        throw new HouseholdCoordinationError(
          `Approval for ${partyEntityId} is missing or invalidated`,
          "HOUSEHOLD_STALE_APPROVAL",
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
          },
        );
      }
      const request = await this.deps.approvalQueue.byId(
        link.approvalRequestId,
      );
      if (!request) {
        throw new HouseholdCoordinationError(
          `Approval request ${link.approvalRequestId} is missing`,
          "HOUSEHOLD_STALE_APPROVAL",
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
            approvalRequestId: link.approvalRequestId,
          },
        );
      }
      if (
        request.state !== "approved" ||
        request.resolvedBy !== partyEntityId ||
        !approvalPayloadMatches(request, proposal, partyEntityId)
      ) {
        throw new HouseholdCoordinationError(
          `Approval for ${partyEntityId} does not match proposal ${proposal.proposalId} v${proposal.version}`,
          "HOUSEHOLD_STALE_APPROVAL",
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
            approvalRequestId: link.approvalRequestId,
            approvalState: request?.state,
          },
        );
      }
      approvedBy.push(partyEntityId);
    }
    return uniqueStrings(approvedBy);
  }

  async finalizeProposal(input: {
    proposalId: string;
    proposalVersion: number;
  }): Promise<HouseholdScheduleAgreement> {
    const proposalId = normalizeHouseholdIdentifier(
      input.proposalId,
      "proposalId",
    );
    const proposalVersion = nonNegativeInteger(
      input.proposalVersion,
      "proposalVersion",
      1,
    );
    await this.reconcilePersistedApprovalInvalidations();
    const proposal = await this.deps.repository.getProposal(
      proposalId,
      proposalVersion,
    );
    if (!proposal) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} v${proposalVersion} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        {
          proposalId,
          proposalVersion,
        },
      );
    }
    if (proposal.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal is ${proposal.status}, not pending`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          status: proposal.status,
        },
      );
    }
    if (await this.expireProposalIfLapsed(proposal, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    const approvedByEntityIds = await this.verifyExactApprovals(proposal);
    const head = await this.deps.repository.getHead(proposal.coordinationId);
    if (!head) {
      throw new HouseholdCoordinationError(
        `Coordination ${proposal.coordinationId} was not found`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        { coordinationId: proposal.coordinationId },
      );
    }
    if (head.currentAgreementVersion !== proposal.baseAgreementVersion) {
      throw new HouseholdCoordinationError(
        "Proposal was approved against a stale agreement version",
        "HOUSEHOLD_STALE_BASE_AGREEMENT",
        {
          coordinationId: proposal.coordinationId,
          baseAgreementVersion: proposal.baseAgreementVersion,
          currentAgreementVersion: head.currentAgreementVersion,
        },
      );
    }
    const activatedAt = this.now().toISOString();
    const agreement: HouseholdScheduleAgreement = {
      id: `hagreement_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      coordinationId: proposal.coordinationId,
      version: head.currentAgreementVersion + 1,
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      terms: proposal.terms,
      affectedPartyEntityIds: proposal.affectedPartyEntityIds,
      approvedByEntityIds,
      activatedAt,
      createdAt: activatedAt,
      isCurrent: true,
    };
    const commitment = createLifeOpsCommitmentLedgerRecord({
      agentId: this.deps.agentId,
      source: "chat",
      sourceKey: agreement.id,
      kind: "commitment",
      summary: agreement.terms.summary,
      counterparty: approvedByEntityIds.join(", "),
      dueAt: agreement.terms.startAt,
      confidence: 1,
      metadata: {
        householdAgreementId: agreement.id,
        householdAgreementVersion: agreement.version,
        householdCoordinationId: agreement.coordinationId,
        affectedPartyEntityIds: agreement.affectedPartyEntityIds,
      },
      createdAt: activatedAt,
      updatedAt: activatedAt,
    });
    const activation = await this.deps.repository.activateAgreement(
      agreement,
      commitment,
    );
    await this.terminallyInvalidateApprovalRequests(
      activation.invalidatedApprovalRequestIds,
      `competing proposals invalidated by agreement ${agreement.id}`,
    );
    return agreement;
  }

  private scopesForSchedule(
    principalEntityId: string,
    activeGrants: readonly HouseholdAccessGrant[],
    scheduleSubjectEntityIds: readonly string[],
  ): HouseholdAccessScope[] {
    if (principalEntityId === SELF_ENTITY_ID) {
      return [...HOUSEHOLD_ACCESS_SCOPES];
    }
    const relevant = activeGrants.filter((grant) =>
      grant.subjectEntityIds.some((subjectId) =>
        scheduleSubjectEntityIds.includes(subjectId),
      ),
    );
    return HOUSEHOLD_ACCESS_SCOPES.filter((scope) => {
      const scopedGrants = relevant.filter((grant) =>
        grant.scopes.includes(scope),
      );
      if (scopedGrants.length === 0) return false;
      if (scope === "household.visibility" || scope === "calendar.freebusy") {
        return true;
      }
      return scheduleSubjectEntityIds.every((subjectId) =>
        scopedGrants.some((grant) =>
          grant.subjectEntityIds.includes(subjectId),
        ),
      );
    });
  }

  async exportFor(input: {
    principalEntityId: string;
    at?: Date;
  }): Promise<HouseholdScopedExport> {
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    await this.requireEntity(principalEntityId);
    const serviceNow = this.now();
    const at = input.at ?? serviceNow;
    await this.reconcilePersistedApprovalInvalidations();
    const isOwner = principalEntityId === SELF_ENTITY_ID;
    const allGrants = await this.deps.repository.listGrants();
    const activeGrants = isOwner
      ? allGrants
      : await this.activeGrants(principalEntityId, at);
    const ownActiveGrants = isOwner
      ? activeGrants
      : activeGrants.filter(
          (grant) => grant.principalEntityId === principalEntityId,
        );
    const effectiveScopes = isOwner
      ? [...HOUSEHOLD_ACCESS_SCOPES]
      : HOUSEHOLD_ACCESS_SCOPES.filter((scope) =>
          ownActiveGrants.some((grant) => grant.scopes.includes(scope)),
        );
    const allRoles = await this.listRoleBindings();
    let proposals = await this.deps.repository.listProposals();
    let latestProposals = latestProposalVersions(proposals);
    let expiredAny = false;
    for (const proposal of latestProposals) {
      if (await this.expireProposalIfLapsed(proposal, serviceNow)) {
        expiredAny = true;
      }
    }
    if (expiredAny) {
      proposals = await this.deps.repository.listProposals();
      latestProposals = latestProposalVersions(proposals);
    }
    const agreements = await this.deps.repository.listAgreements();
    const visibleSubjectEntityIds = isOwner
      ? uniqueStrings(
          [
            ...allGrants.flatMap((grant) => [
              grant.principalEntityId,
              ...grant.subjectEntityIds,
            ]),
            ...allRoles.flatMap((binding) => [
              binding.entityId,
              ...binding.subjectEntityIds,
            ]),
            ...latestProposals.flatMap(
              (proposal) => proposal.affectedPartyEntityIds,
            ),
            ...agreements.flatMap(
              (agreement) => agreement.affectedPartyEntityIds,
            ),
          ].filter((entityId) => entityId !== SELF_ENTITY_ID),
        )
      : uniqueStrings(
          ownActiveGrants.flatMap((grant) => grant.subjectEntityIds),
        );
    await this.deps.repository.appendAudit({
      kind: "household_export_read",
      ownerId: principalEntityId,
      reason: "Household state exported under current grants.",
      inputs: {
        principalEntityId,
        visibleSubjectEntityIds,
      },
      decision: { effectiveScopes },
      actor: "user",
      createdAt: this.now().toISOString(),
    });

    const roles = effectiveScopes.includes("household.visibility")
      ? allRoles.filter(
          (binding) =>
            isOwner ||
            binding.entityId === principalEntityId ||
            visibleSubjectEntityIds.includes(binding.entityId),
        )
      : [];

    const schedules: HouseholdExportScheduleEntry[] = [];
    for (const proposal of latestProposals) {
      if (
        proposal.status !== "pending" ||
        (!isOwner &&
          !proposal.affectedPartyEntityIds.includes(principalEntityId) &&
          !proposal.affectedPartyEntityIds.some((entityId) =>
            visibleSubjectEntityIds.includes(entityId),
          ))
      ) {
        continue;
      }
      const scopes = this.scopesForSchedule(
        principalEntityId,
        ownActiveGrants,
        proposal.terms.childEntityIds.length > 0
          ? proposal.terms.childEntityIds
          : proposal.affectedPartyEntityIds,
      );
      if (!scopes.includes("calendar.freebusy")) continue;
      schedules.push({
        coordinationId: proposal.coordinationId,
        subjectEntityIds: uniqueStrings(
          (proposal.terms.childEntityIds.length > 0
            ? proposal.terms.childEntityIds
            : proposal.affectedPartyEntityIds
          ).filter(
            (entityId) =>
              isOwner ||
              entityId === principalEntityId ||
              visibleSubjectEntityIds.includes(entityId),
          ),
        ),
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        agreementId: null,
        agreementVersion: null,
        startAt: proposal.terms.startAt,
        endAt: proposal.terms.endAt,
        details: scopes.includes("calendar.details") ? proposal.terms : null,
        state: "proposal",
      });
    }
    for (const agreement of agreements) {
      if (
        !agreement.isCurrent ||
        (!isOwner &&
          !agreement.affectedPartyEntityIds.includes(principalEntityId) &&
          !agreement.affectedPartyEntityIds.some((entityId) =>
            visibleSubjectEntityIds.includes(entityId),
          ))
      ) {
        continue;
      }
      const scopes = this.scopesForSchedule(
        principalEntityId,
        ownActiveGrants,
        agreement.terms.childEntityIds.length > 0
          ? agreement.terms.childEntityIds
          : agreement.affectedPartyEntityIds,
      );
      if (!scopes.includes("calendar.freebusy")) continue;
      schedules.push({
        coordinationId: agreement.coordinationId,
        subjectEntityIds: uniqueStrings(
          (agreement.terms.childEntityIds.length > 0
            ? agreement.terms.childEntityIds
            : agreement.affectedPartyEntityIds
          ).filter(
            (entityId) =>
              isOwner ||
              entityId === principalEntityId ||
              visibleSubjectEntityIds.includes(entityId),
          ),
        ),
        proposalId: agreement.proposalId,
        proposalVersion: agreement.proposalVersion,
        agreementId: agreement.id,
        agreementVersion: agreement.version,
        startAt: agreement.terms.startAt,
        endAt: agreement.terms.endAt,
        details: scopes.includes("calendar.details") ? agreement.terms : null,
        state: "agreement",
      });
    }

    const audience = new Set([principalEntityId, ...visibleSubjectEntityIds]);
    const audit = (await this.deps.repository.listAudit())
      .filter(
        (event) =>
          isOwner ||
          recordContainsAnyEntity(event.inputs, audience) ||
          recordContainsAnyEntity(event.decision, audience) ||
          event.ownerId === principalEntityId,
      )
      .map((event): HouseholdAuditRecord => {
        if (isOwner) return event;
        return {
          ...event,
          reason: "Household coordination state changed.",
          inputs: {},
          decision: {},
        };
      });

    return {
      generatedAt: at.toISOString(),
      principalEntityId,
      effectiveScopes,
      visibleSubjectEntityIds,
      roles,
      grants: isOwner
        ? allGrants
        : allGrants.filter(
            (grant) => grant.principalEntityId === principalEntityId,
          ),
      schedules: schedules.sort((left, right) =>
        left.startAt.localeCompare(right.startAt),
      ),
      audit,
    };
  }
}

export function createHouseholdCoordinationService(
  runtime: IAgentRuntime,
): HouseholdCoordinationService {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new HouseholdCoordinationError(
      "KnowledgeGraphService is required for household coordination",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  const agentId = runtime.agentId;
  return new HouseholdCoordinationService({
    runtime,
    agentId,
    entityStore: graph.getEntityStore(agentId),
    relationshipStore: graph.getRelationshipStore(agentId),
    approvalQueue: createApprovalQueue(runtime, { agentId }),
    repository: new HouseholdCoordinationRepository(runtime, agentId),
  });
}

export class HouseholdCoordinationRuntimeService extends Service {
  static override serviceType = HOUSEHOLD_COORDINATION_SERVICE;

  override capabilityDescription =
    "Role-scoped household coordination with version-pinned affected-party approvals";

  readonly coordination: HouseholdCoordinationService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new HouseholdCoordinationError(
        "HouseholdCoordinationRuntimeService requires a runtime",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    this.coordination = createHouseholdCoordinationService(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<HouseholdCoordinationRuntimeService> {
    await runtime.getServiceLoadPromise(ScheduledTaskRunnerService.serviceType);
    const service = new HouseholdCoordinationRuntimeService(runtime);
    await service.coordination.reconcileGrantExpiryWarnings();
    return service;
  }

  async stop(): Promise<void> {}
}

export function getHouseholdCoordinationService(
  runtime: IAgentRuntime,
): HouseholdCoordinationService | null {
  const service = runtime.getService<HouseholdCoordinationRuntimeService>(
    HOUSEHOLD_COORDINATION_SERVICE,
  );
  return service ? service.coordination : null;
}

export async function readHouseholdCoordinationHead(
  runtime: IAgentRuntime,
  coordinationId: string,
): Promise<HouseholdCoordinationHead | null> {
  return await new HouseholdCoordinationRepository(
    runtime,
    runtime.agentId,
  ).getHead(coordinationId);
}
