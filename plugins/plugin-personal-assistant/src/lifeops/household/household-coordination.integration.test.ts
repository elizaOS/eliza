/**
 * Real-PGlite household coordination coverage through the production graph,
 * approval queue, audit log, commitment ledger, and versioned repositories.
 */
import { randomUUID } from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { AgentEventService, createMessageMemory } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { householdCoordinationAction } from "../../actions/household-coordination.js";
import { resolveRequestAction } from "../../actions/resolve-request.js";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalQueue } from "../approval-queue.types.js";
import { LifeOpsRepository } from "../repository.js";
import { executeRawSql, sqlInteger, sqlQuote } from "../sql.js";
import { HouseholdCoordinationRepository } from "./repository.js";
import {
  HOUSEHOLD_COORDINATION_SERVICE,
  HouseholdCoordinationRuntimeService,
  HouseholdCoordinationService,
} from "./service.js";
import type {
  HouseholdScheduleProposal,
  HouseholdScheduleTerms,
} from "./types.js";

class RejectCommitFaultRepository extends HouseholdCoordinationRepository {
  override async rejectProposal(
    _input: Parameters<HouseholdCoordinationRepository["rejectProposal"]>[0],
  ): Promise<string[]> {
    throw new Error("simulated failure after queue rejection");
  }
}

describe("household coordination — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let entities: EntityStore;
  let approvals: ApprovalQueue;
  let householdRepository: HouseholdCoordinationRepository;
  let lifeOpsRepository: LifeOpsRepository;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) {
      throw new Error(
        `Knowledge graph service ${KNOWLEDGE_GRAPH_SERVICE} was not registered`,
      );
    }
    entities = graph.getEntityStore(runtime.agentId);
    await entities.ensureSelf();
    if (!runtime.getService(AgentEventService.serviceType)) {
      await runtime.registerService(AgentEventService);
      await runtime.getServiceLoadPromise(AgentEventService.serviceType);
    }
    approvals = createApprovalQueue(runtime, { agentId: runtime.agentId });
    householdRepository = new HouseholdCoordinationRepository(
      runtime,
      runtime.agentId,
    );
    lifeOpsRepository = new LifeOpsRepository(runtime);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function service(now?: () => Date): HouseholdCoordinationService {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    return new HouseholdCoordinationService({
      runtime,
      agentId: runtime.agentId,
      entityStore: graph.getEntityStore(runtime.agentId),
      relationshipStore: graph.getRelationshipStore(runtime.agentId),
      approvalQueue: approvals,
      repository: householdRepository,
      now,
    });
  }

  async function person(label: string): Promise<string> {
    const entity = await entities.upsert({
      entityId: `ent_${label}_${randomUUID()}`,
      type: "person",
      preferredName: label,
      identities: [],
      tags: ["household-test"],
      visibility: "owner_only",
      state: {},
    });
    return entity.entityId;
  }

  function terms(input: {
    summary: string;
    childEntityIds: string[];
    startHour?: number;
    secret?: string;
    custody?: {
      childEntityId: string;
      normalCustodianEntityId: string;
      substituteCustodianEntityId: string;
    };
  }): HouseholdScheduleTerms {
    const startHour = input.startHour ?? 17;
    const startAt = `2027-03-12T${String(startHour).padStart(2, "0")}:00:00.000Z`;
    const endAt = `2027-03-12T${String(startHour + 1).padStart(2, "0")}:00:00.000Z`;
    return {
      summary: input.summary,
      startAt,
      endAt,
      timezone: "America/Los_Angeles",
      childEntityIds: input.childEntityIds,
      location: input.secret ? `Private location: ${input.secret}` : null,
      notes: input.secret ? `Private note: ${input.secret}` : null,
      custodyException: input.custody
        ? {
            childEntityId: input.custody.childEntityId,
            fromAt: startAt,
            toAt: endAt,
            normalCustodianEntityId: input.custody.normalCustodianEntityId,
            substituteCustodianEntityId:
              input.custody.substituteCustodianEntityId,
            reason: "School closure changed the normal handoff.",
          }
        : null,
    };
  }

  async function bindFamily(input: {
    childId: string;
    coParentId?: string;
    caregiverId?: string;
    professionalId?: string;
    reuseCoParentEdge?: boolean;
  }): Promise<void> {
    const coordinator = service();
    await coordinator.bindRole({
      entityId: input.childId,
      role: "child",
      subjectEntityIds: [input.childId],
      evidence: "Owner identified this child.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    if (input.coParentId) {
      let relationshipId: string | undefined;
      if (input.reuseCoParentEdge) {
        const graph = resolveKnowledgeGraphService(runtime);
        if (!graph) throw new Error("knowledge graph unavailable");
        const existing = await graph
          .getRelationshipStore(runtime.agentId)
          .upsert({
            fromEntityId: SELF_ENTITY_ID,
            toEntityId: input.coParentId,
            type: "co_parent_of",
            metadata: { childId: input.childId },
            state: {},
            evidence: ["relationship inference fixture"],
            confidence: 0.92,
            source: "extraction",
          });
        relationshipId = existing.relationshipId;
      }
      await coordinator.bindRole({
        entityId: input.coParentId,
        role: "co_parent",
        subjectEntityIds: [input.childId],
        relationshipId,
        evidence: "Owner identified this co-parent.",
        boundByEntityId: SELF_ENTITY_ID,
      });
    }
    if (input.caregiverId) {
      await coordinator.bindRole({
        entityId: input.caregiverId,
        role: "caregiver",
        subjectEntityIds: [input.childId],
        evidence: "Owner identified this caregiver.",
        boundByEntityId: SELF_ENTITY_ID,
      });
    }
    if (input.professionalId) {
      await coordinator.bindRole({
        entityId: input.professionalId,
        role: "professional",
        subjectEntityIds: [input.childId],
        evidence: "Owner identified this household professional.",
        boundByEntityId: SELF_ENTITY_ID,
      });
    }
  }

  async function approve(
    proposal: HouseholdScheduleProposal,
    partyEntityId: string,
  ): Promise<void> {
    const link = (
      await householdRepository.listApprovalLinks(
        proposal.proposalId,
        proposal.version,
      )
    ).find((candidate) => candidate.partyEntityId === partyEntityId);
    if (!link) throw new Error("household approval link missing");
    await service().respondToProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      partyEntityId,
      approvalRequestId: link.approvalRequestId,
      decision: "approve",
      reason: "I approve this exact time and custody plan.",
    });
  }

  it("exposes safe owner operations without an affected-party impersonation verb", async () => {
    const actionParameter = householdCoordinationAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema.enum).toEqual(
      expect.arrayContaining([
        "bind_role",
        "issue_grant",
        "create_proposal",
        "revise_proposal",
        "finalize_proposal",
        "export",
      ]),
    );
    for (const forbidden of [
      "respond",
      "approve",
      "reject",
      "respond_to_proposal",
    ]) {
      expect(actionParameter?.schema.enum).not.toContain(forbidden);
    }

    const childId = await person("action-child");
    const coParentId = await person("action-co-parent");
    const ownerMessage = createMessageMemory({
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: "Coordinate a household schedule proposal.",
        source: "client_chat",
      },
    });
    const invoke = async (parameters: Record<string, unknown>) =>
      await householdCoordinationAction.handler(
        runtime,
        ownerMessage,
        undefined,
        { parameters },
        undefined,
      );

    await expect(
      invoke({
        action: "bind_role",
        entityId: childId,
        role: "child",
        subjectEntityIds: [childId],
        evidence: "Owner identified this child through the action surface.",
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      invoke({
        action: "bind_role",
        entityId: coParentId,
        role: "co_parent",
        subjectEntityIds: [childId],
        evidence: "Owner identified this co-parent through the action surface.",
      }),
    ).resolves.toMatchObject({ success: true });

    const result = await invoke({
      action: "create_proposal",
      coordinationId: `action-${randomUUID()}`,
      terms: terms({
        summary: "Owner-action household proposal",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        action: "create_proposal",
        proposal: {
          version: 1,
          requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId].sort(),
        },
      },
    });
    expect(result.text).toContain("No calendar event or external message");
  });

  it("requires both custodians for a custody exception and writes the accepted obligation", async () => {
    expect(runtime.getService(HOUSEHOLD_COORDINATION_SERVICE)).toBeInstanceOf(
      HouseholdCoordinationRuntimeService,
    );
    const childId = await person("custody-child");
    const coParentId = await person("custody-co-parent");
    await bindFamily({ childId, coParentId, reuseCoParentEdge: true });
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const coParentEdges = await graph
      .getRelationshipStore(runtime.agentId)
      .list({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: coParentId,
        type: "co_parent_of",
      });
    expect(coParentEdges).toHaveLength(1);
    expect(coParentEdges[0]?.metadata).toMatchObject({
      householdRole: "co_parent",
      householdSubjectEntityIds: [childId],
    });
    const coordinator = service();
    const proposal = await coordinator.createProposal({
      coordinationId: `custody-${randomUUID()}`,
      terms: terms({
        summary: "Custody exception for school closure",
        childEntityIds: [childId],
        custody: {
          childEntityId: childId,
          normalCustodianEntityId: coParentId,
          substituteCustodianEntityId: SELF_ENTITY_ID,
        },
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const approvalLinks = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const ownerApprovalLink = approvalLinks.find(
      (link) => link.partyEntityId === SELF_ENTITY_ID,
    );
    const coParentApprovalLink = approvalLinks.find(
      (link) => link.partyEntityId === coParentId,
    );
    if (!ownerApprovalLink) throw new Error("owner approval link missing");
    if (!coParentApprovalLink) {
      throw new Error("co-parent approval link missing");
    }
    const ownerApproval = await approvals.byId(
      ownerApprovalLink.approvalRequestId,
    );
    expect(ownerApproval?.payload).toMatchObject({
      action: "execute_workflow",
      input: { contentSha256: proposal.contentSha256 },
    });
    await expect(
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: SELF_ENTITY_ID,
        approvalRequestId: coParentApprovalLink.approvalRequestId,
        decision: "approve",
        reason: "Attempt to answer the wrong party request.",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });

    const ownerMessage = createMessageMemory({
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: `Approve ${ownerApprovalLink.approvalRequestId}.`,
        source: "client_chat",
      },
    });
    const ownerApprovalResult = await resolveRequestAction.handler(
      runtime,
      ownerMessage,
      undefined,
      {
        parameters: {
          action: "approve",
          requestId: ownerApprovalLink.approvalRequestId,
          reason: "I approve these exact household proposal bytes.",
        },
      },
      undefined,
    );
    expect(ownerApprovalResult).toMatchObject({
      success: true,
      data: {
        operation: "resolve_household_schedule_proposal",
        requestId: ownerApprovalLink.approvalRequestId,
        state: "approved",
        decision: "approve",
        resolvedBy: SELF_ENTITY_ID,
      },
    });
    const crossPartyRejection = await resolveRequestAction.handler(
      runtime,
      ownerMessage,
      undefined,
      {
        parameters: {
          action: "reject",
          requestId: coParentApprovalLink.approvalRequestId,
          reason: "The owner must not reject for the co-parent.",
        },
      },
      undefined,
    );
    expect(crossPartyRejection).toMatchObject({
      success: false,
      data: { error: "CROSS_SUBJECT_APPROVAL_FORBIDDEN" },
    });
    await expect(
      approvals.byId(coParentApprovalLink.approvalRequestId),
    ).resolves.toMatchObject({ state: "pending", resolvedBy: null });
    await expect(
      coordinator.finalizeProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });

    await approve(proposal, coParentId);
    const agreement = await coordinator.finalizeProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
    });
    expect(agreement.approvedByEntityIds).toEqual(
      [SELF_ENTITY_ID, coParentId].sort(),
    );
    expect(agreement.terms.custodyException?.childEntityId).toBe(childId);

    const obligations = await lifeOpsRepository.listCommitmentLedgerRecords(
      runtime.agentId,
      { source: "chat" },
    );
    expect(
      obligations.find(
        (record) => record.metadata.householdAgreementId === agreement.id,
      ),
    ).toMatchObject({
      summary: "Custody exception for school closure",
      confidence: 1,
      dueAt: agreement.terms.startAt,
    });
    const audit = await householdRepository.listAudit();
    expect(
      audit
        .filter(
          (event) =>
            event.ownerId === proposal.proposalId ||
            event.ownerId === agreement.id,
        )
        .map((event) => event.kind),
    ).toEqual(
      expect.arrayContaining([
        "household_proposal_created",
        "household_proposal_approved",
        "household_agreement_activated",
      ]),
    );
  });

  it("revokes a caregiver grant immediately instead of serving stale free/busy", async () => {
    const childId = await person("caregiver-child");
    const caregiverId = await person("caregiver");
    await bindFamily({ childId, caregiverId });
    const coordinator = service();
    const grant = await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const proposal = await coordinator.createProposal({
      coordinationId: `caregiver-${randomUUID()}`,
      terms: terms({
        summary: "Child pickup",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const before = await coordinator.exportFor({
      principalEntityId: caregiverId,
    });
    expect(before.schedules).toHaveLength(1);
    expect(before.schedules[0]?.proposalId).toBe(proposal.proposalId);
    await expect(
      coordinator.requireScope({
        principalEntityId: caregiverId,
        subjectEntityId: childId,
        scope: "calendar.freebusy",
        at: new Date(Date.now() + 120_000),
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_GRANT_EXPIRED" });

    await coordinator.revokeGrant({
      grantId: grant.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Caregiving engagement ended.",
    });
    const after = await coordinator.exportFor({
      principalEntityId: caregiverId,
    });
    expect(after.effectiveScopes).toEqual([]);
    expect(after.schedules).toEqual([]);
    await expect(
      coordinator.requireScope({
        principalEntityId: caregiverId,
        subjectEntityId: childId,
        scope: "calendar.freebusy",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_GRANT_REVOKED" });
  });

  it("keeps a co-parent scoped to the shared child and hides another child's plan", async () => {
    const sharedChildId = await person("shared-child");
    const otherChildId = await person("other-child");
    const coParentId = await person("privacy-co-parent");
    await bindFamily({ childId: sharedChildId, coParentId });
    await bindFamily({ childId: otherChildId });
    const coordinator = service();
    await expect(
      coordinator.issueGrant({
        principalEntityId: coParentId,
        role: "co_parent",
        subjectEntityIds: [otherChildId],
        scopes: ["calendar.freebusy"],
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    await coordinator.issueGrant({
      principalEntityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [sharedChildId],
      scopes: ["calendar.details"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const visible = await coordinator.createProposal({
      coordinationId: `shared-${randomUUID()}`,
      terms: terms({
        summary: "Shared child's recital",
        childEntityIds: [sharedChildId],
      }),
      affectedPartyEntityIds: [sharedChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const hidden = await coordinator.createProposal({
      coordinationId: `private-${randomUUID()}`,
      terms: terms({
        summary: "Other child's appointment",
        childEntityIds: [otherChildId],
        startHour: 19,
      }),
      affectedPartyEntityIds: [otherChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const mixed = await coordinator.createProposal({
      coordinationId: `mixed-${randomUUID()}`,
      terms: terms({
        summary: "Private mixed-household logistics",
        childEntityIds: [sharedChildId, otherChildId],
        startHour: 20,
      }),
      affectedPartyEntityIds: [sharedChildId, otherChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const exported = await coordinator.exportFor({
      principalEntityId: coParentId,
    });
    expect(exported.schedules.map((entry) => entry.proposalId)).toContain(
      visible.proposalId,
    );
    expect(exported.schedules.map((entry) => entry.proposalId)).not.toContain(
      hidden.proposalId,
    );
    expect(exported.schedules.map((entry) => entry.proposalId)).toContain(
      mixed.proposalId,
    );
    expect(
      exported.schedules.find(
        (entry) => entry.proposalId === visible.proposalId,
      )?.details,
    ).not.toBeNull();
    expect(
      exported.schedules.find((entry) => entry.proposalId === mixed.proposalId)
        ?.details,
    ).toBeNull();
    expect(exported.visibleSubjectEntityIds).toEqual([sharedChildId]);
    expect(JSON.stringify(exported)).not.toContain(otherChildId);

    const coParentBinding = (await coordinator.listRoleBindings()).find(
      (binding) => binding.entityId === coParentId,
    );
    if (!coParentBinding?.relationshipId) {
      throw new Error("co-parent relationship binding missing");
    }
    await coordinator.bindRole({
      entityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [],
      relationshipId: coParentBinding.relationshipId,
      evidence: "Owner removed this child from the co-parent relationship.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const afterRelationshipNarrowing = await coordinator.exportFor({
      principalEntityId: coParentId,
    });
    expect(afterRelationshipNarrowing.effectiveScopes).toEqual([]);
    expect(afterRelationshipNarrowing.schedules).toEqual([]);
  });

  it("keeps a current partner inside explicit child subjects and retires access with the relationship", async () => {
    const sharedChildId = await person("partner-shared-child");
    const unrelatedChildId = await person("partner-unrelated-child");
    const partnerId = await person("current-partner");
    await bindFamily({ childId: sharedChildId });
    await bindFamily({ childId: unrelatedChildId });
    const coordinator = service();
    const binding = await coordinator.bindRole({
      entityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [sharedChildId],
      evidence: "Owner identified this partner's household scope.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      coordinator.issueGrant({
        principalEntityId: partnerId,
        role: "current_partner",
        subjectEntityIds: [unrelatedChildId],
        scopes: ["calendar.freebusy"],
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    await coordinator.issueGrant({
      principalEntityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [sharedChildId],
      scopes: ["household.visibility", "calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await coordinator.createProposal({
      coordinationId: `partner-scope-${randomUUID()}`,
      terms: terms({
        summary: "Shared child plan",
        childEntityIds: [sharedChildId],
      }),
      affectedPartyEntityIds: [sharedChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      coordinator.exportFor({ principalEntityId: partnerId }),
    ).resolves.toMatchObject({
      effectiveScopes: ["household.visibility", "calendar.freebusy"],
    });

    if (!binding.relationshipId) {
      throw new Error("current partner relationship binding missing");
    }
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const relationships = graph.getRelationshipStore(runtime.agentId);
    const relationship = await relationships.get(binding.relationshipId);
    if (!relationship) throw new Error("current partner relationship missing");
    await relationships.upsert({
      relationshipId: relationship.relationshipId,
      fromEntityId: relationship.fromEntityId,
      toEntityId: relationship.toEntityId,
      type: relationship.type,
      metadata: relationship.metadata,
      state: relationship.state,
      evidence: relationship.evidence,
      confidence: relationship.confidence,
      source: relationship.source,
      status: "retired",
    });
    expect(
      (await coordinator.listRoleBindings()).some(
        (candidate) => candidate.entityId === partnerId,
      ),
    ).toBe(false);
    await expect(
      coordinator.exportFor({ principalEntityId: partnerId }),
    ).resolves.toMatchObject({
      effectiveScopes: [],
      schedules: [],
    });
  });

  it("serializes concurrent proposals so only one can advance an agreement head", async () => {
    const childId = await person("concurrency-child");
    const coParentId = await person("concurrency-co-parent");
    await bindFamily({ childId, coParentId });
    const coordinator = service();
    const coordinationId = `concurrent-${randomUUID()}`;
    const first = await coordinator.createProposal({
      coordinationId,
      terms: terms({
        summary: "First handoff option",
        childEntityIds: [childId],
        startHour: 15,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const second = await coordinator.createProposal({
      coordinationId,
      terms: terms({
        summary: "Second handoff option",
        childEntityIds: [childId],
        startHour: 16,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    for (const proposal of [first, second]) {
      await approve(proposal, SELF_ENTITY_ID);
      await approve(proposal, coParentId);
    }

    const results = await Promise.allSettled([
      coordinator.finalizeProposal({
        proposalId: first.proposalId,
        proposalVersion: first.version,
      }),
      coordinator.finalizeProposal({
        proposalId: second.proposalId,
        proposalVersion: second.version,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const agreements = (await householdRepository.listAgreements()).filter(
      (agreement) => agreement.coordinationId === coordinationId,
    );
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({ version: 1, isCurrent: true });
    const losingProposal =
      agreements[0]?.proposalId === first.proposalId ? second : first;
    await expect(
      householdRepository.getProposal(
        losingProposal.proposalId,
        losingProposal.version,
      ),
    ).resolves.toMatchObject({ status: "invalidated" });
    const losingLinks = await householdRepository.listApprovalLinks(
      losingProposal.proposalId,
      losingProposal.version,
    );
    expect(losingLinks.every((link) => link.invalidatedAt !== null)).toBe(true);
    const losingRequests = await Promise.all(
      losingLinks.map((link) => approvals.byId(link.approvalRequestId)),
    );
    expect(
      losingRequests.every((request) => request?.state === "expired"),
    ).toBe(true);
  });

  it("invalidates stale approvals when material proposal bytes change", async () => {
    const childId = await person("stale-child");
    const coParentId = await person("stale-co-parent");
    await bindFamily({ childId, coParentId });
    const coordinator = service();
    const first = await coordinator.createProposal({
      coordinationId: `stale-${randomUUID()}`,
      terms: terms({
        summary: "Weekend handoff",
        childEntityIds: [childId],
        startHour: 14,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    await approve(first, SELF_ENTITY_ID);
    await approve(first, coParentId);
    const revised = await coordinator.reviseProposal({
      proposalId: first.proposalId,
      expectedVersion: first.version,
      terms: terms({
        summary: "Weekend handoff",
        childEntityIds: [childId],
        startHour: 18,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      revisedByEntityId: SELF_ENTITY_ID,
    });
    expect(revised).toMatchObject({ version: 2, materialChange: true });
    const ensuredOnce = await coordinator.ensureProposalApprovals(
      revised.proposalId,
      revised.version,
    );
    const ensuredTwice = await coordinator.ensureProposalApprovals(
      revised.proposalId,
      revised.version,
    );
    expect(ensuredTwice.map((link) => link.id)).toEqual(
      ensuredOnce.map((link) => link.id),
    );
    const missingLink = ensuredOnce.find(
      (link) => link.partyEntityId === coParentId,
    );
    if (!missingLink) throw new Error("co-parent approval link missing");
    const originalRequest = await approvals.byId(missingLink.approvalRequestId);
    if (!originalRequest?.idempotencyKey) {
      throw new Error("household approval idempotency key missing");
    }
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_household_proposal_approvals
        WHERE agent_id = ${sqlQuote(runtime.agentId)}
          AND proposal_id = ${sqlQuote(revised.proposalId)}
          AND proposal_version = ${sqlInteger(revised.version)}
          AND party_entity_id = ${sqlQuote(coParentId)}`,
    );
    const repaired = await coordinator.ensureProposalApprovals(
      revised.proposalId,
      revised.version,
    );
    expect(
      repaired.find((link) => link.partyEntityId === coParentId)
        ?.approvalRequestId,
    ).toBe(originalRequest.id);
    const coParentRequests = await approvals.list({
      subjectUserId: coParentId,
      state: null,
      action: "execute_workflow",
      limit: 100,
    });
    expect(
      coParentRequests.filter(
        (request) => request.idempotencyKey === originalRequest.idempotencyKey,
      ),
    ).toHaveLength(1);

    await expect(
      coordinator.finalizeProposal({
        proposalId: revised.proposalId,
        proposalVersion: revised.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });
    const oldLinks = await householdRepository.listApprovalLinks(
      first.proposalId,
      first.version,
    );
    expect(oldLinks.every((link) => link.invalidatedAt !== null)).toBe(true);
    const oldRequests = await Promise.all(
      oldLinks.map((link) => approvals.byId(link.approvalRequestId)),
    );
    expect(oldRequests.every((request) => request?.state === "expired")).toBe(
      true,
    );

    await approve(revised, SELF_ENTITY_ID);
    await approve(revised, coParentId);
    await expect(
      coordinator.finalizeProposal({
        proposalId: revised.proposalId,
        proposalVersion: revised.version,
      }),
    ).resolves.toMatchObject({ proposalVersion: 2, version: 1 });
  });

  it("recovers a queue rejection that crashed before the proposal transaction", async () => {
    const childId = await person("rejection-recovery-child");
    const coParentId = await person("rejection-recovery-co-parent");
    await bindFamily({ childId, coParentId });
    const proposal = await service().createProposal({
      coordinationId: `rejection-recovery-${randomUUID()}`,
      terms: terms({
        summary: "Proposal that the co-parent declines",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const links = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const ownerLink = links.find(
      (link) => link.partyEntityId === SELF_ENTITY_ID,
    );
    const coParentLink = links.find(
      (link) => link.partyEntityId === coParentId,
    );
    if (!ownerLink || !coParentLink) {
      throw new Error("rejection recovery approval links missing");
    }
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const faultingService = new HouseholdCoordinationService({
      runtime,
      agentId: runtime.agentId,
      entityStore: graph.getEntityStore(runtime.agentId),
      relationshipStore: graph.getRelationshipStore(runtime.agentId),
      approvalQueue: approvals,
      repository: new RejectCommitFaultRepository(runtime, runtime.agentId),
    });
    await expect(
      faultingService.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: coParentId,
        approvalRequestId: coParentLink.approvalRequestId,
        decision: "reject",
        reason: "This handoff time does not work for me.",
      }),
    ).rejects.toThrow("simulated failure after queue rejection");
    await expect(
      householdRepository.getProposal(proposal.proposalId, proposal.version),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      approvals.byId(coParentLink.approvalRequestId),
    ).resolves.toMatchObject({
      state: "rejected",
      resolvedBy: coParentId,
    });
    await expect(
      approvals.byId(ownerLink.approvalRequestId),
    ).resolves.toMatchObject({ state: "pending" });

    const restartedService = service();
    const exported = await restartedService.exportFor({
      principalEntityId: SELF_ENTITY_ID,
    });
    expect(
      exported.schedules.some(
        (entry) => entry.proposalId === proposal.proposalId,
      ),
    ).toBe(false);
    await expect(
      householdRepository.getProposal(proposal.proposalId, proposal.version),
    ).resolves.toMatchObject({ status: "rejected" });
    const recoveredLinks = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    expect(recoveredLinks.every((link) => link.invalidatedAt !== null)).toBe(
      true,
    );
    await expect(
      approvals.byId(coParentLink.approvalRequestId),
    ).resolves.toMatchObject({ state: "rejected" });
    await expect(
      approvals.byId(ownerLink.approvalRequestId),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("persists the default approval window and rejects blank or expired responses", async () => {
    let clock = new Date("2027-03-10T00:00:00.000Z");
    const coordinator = service(() => new Date(clock));
    const childId = await person("expiry-child");
    await bindFamily({ childId });
    const proposal = await coordinator.createProposal({
      coordinationId: `expiry-${randomUUID()}`,
      terms: terms({
        summary: "Time-bounded household proposal",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    expect(proposal.expiresAt).toBe("2027-03-12T00:00:00.000Z");
    const [approvalLink] = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    if (!approvalLink) throw new Error("owner approval link missing");
    await expect(
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: SELF_ENTITY_ID,
        approvalRequestId: approvalLink.approvalRequestId,
        decision: "approve",
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_INVALID_CONTRACT" });
    await coordinator.respondToProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      partyEntityId: SELF_ENTITY_ID,
      approvalRequestId: approvalLink.approvalRequestId,
      decision: "approve",
      reason: "I approve these exact proposal bytes.",
    });
    clock = new Date("2027-03-12T00:00:00.000Z");
    await expect(
      coordinator.finalizeProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });
    await expect(
      householdRepository.getProposal(proposal.proposalId, proposal.version),
    ).resolves.toMatchObject({ status: "expired" });
    const expiredLinks = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    expect(expiredLinks.every((link) => link.invalidatedAt !== null)).toBe(
      true,
    );
    await expect(
      approvals.byId(approvalLink.approvalRequestId),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("rejects invalid time zones and stale caller-supplied base versions before persistence", async () => {
    const childId = await person("contract-validation-child");
    await bindFamily({ childId });
    const coordinator = service();
    const invalidTimezoneProposalId = `invalid-timezone-${randomUUID()}`;
    await expect(
      coordinator.createProposal({
        proposalId: invalidTimezoneProposalId,
        coordinationId: `contract-validation-${randomUUID()}`,
        terms: {
          ...terms({
            summary: "Invalid time zone proposal",
            childEntityIds: [childId],
          }),
          timezone: "Mars/Phobos",
        },
        affectedPartyEntityIds: [childId],
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        createdByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_INVALID_CONTRACT" });
    await expect(
      householdRepository.getProposal(invalidTimezoneProposalId),
    ).resolves.toBeNull();

    const staleBaseProposalId = `stale-base-${randomUUID()}`;
    await expect(
      coordinator.createProposal({
        proposalId: staleBaseProposalId,
        coordinationId: `stale-base-coordination-${randomUUID()}`,
        terms: terms({
          summary: "Stale base proposal",
          childEntityIds: [childId],
        }),
        affectedPartyEntityIds: [childId],
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        createdByEntityId: SELF_ENTITY_ID,
        baseAgreementVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_BASE_AGREEMENT" });
    await expect(
      householdRepository.getProposal(staleBaseProposalId),
    ).resolves.toBeNull();
  });

  it("redacts details and audit payloads from a free/busy-only export", async () => {
    const childId = await person("redaction-child");
    const professionalId = await person("redaction-professional");
    await bindFamily({ childId, professionalId });
    const coordinator = service();
    await coordinator.issueGrant({
      principalEntityId: professionalId,
      role: "professional",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const secret = `secret-${randomUUID()}`;
    const proposal = await coordinator.createProposal({
      coordinationId: `redaction-${randomUUID()}`,
      terms: terms({
        summary: `Sensitive appointment ${secret}`,
        childEntityIds: [childId],
        secret,
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const exported = await coordinator.exportFor({
      principalEntityId: professionalId,
    });
    expect(exported.schedules).toEqual([
      expect.objectContaining({
        proposalId: proposal.proposalId,
        startAt: proposal.terms.startAt,
        endAt: proposal.terms.endAt,
        details: null,
      }),
    ]);
    expect(exported.audit.length).toBeGreaterThan(0);
    expect(
      exported.audit.every(
        (event) =>
          Object.keys(event.inputs).length === 0 &&
          Object.keys(event.decision).length === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(secret);
  });
});
