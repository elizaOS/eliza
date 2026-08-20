/**
 * Real-PGlite security coverage for household namespace separation and
 * revision-pinned custody authority across durable proposals and approvals.
 */
import { randomUUID } from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalQueue } from "../approval-queue.types.js";
import { HouseholdCoordinationRepository } from "./repository.js";
import { HouseholdCoordinationService } from "./service.js";
import type {
  HouseholdScheduleProposal,
  HouseholdScheduleTerms,
} from "./types.js";

describe("household authorization boundaries — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let entities: EntityStore;
  let approvals: ApprovalQueue;
  let repository: HouseholdCoordinationRepository;

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
    approvals = createApprovalQueue(runtime, { agentId: runtime.agentId });
    repository = new HouseholdCoordinationRepository(runtime, runtime.agentId);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function coordinator(): HouseholdCoordinationService {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    return new HouseholdCoordinationService({
      runtime,
      agentId: runtime.agentId,
      entityStore: graph.getEntityStore(runtime.agentId),
      relationshipStore: graph.getRelationshipStore(runtime.agentId),
      approvalQueue: approvals,
      repository,
    });
  }

  async function person(label: string): Promise<string> {
    const entity = await entities.upsert({
      entityId: `ent_${label}_${randomUUID()}`,
      type: "person",
      preferredName: label,
      identities: [],
      tags: ["household-boundary-test"],
      visibility: "owner_only",
      state: {},
    });
    return entity.entityId;
  }

  function scheduleTerms(input: {
    summary: string;
    childEntityId: string;
    hour: number;
    custody?: {
      normalCustodianEntityId: string;
      substituteCustodianEntityId: string;
      authorityBaselineRelationshipId: string;
    };
  }): HouseholdScheduleTerms {
    const startAt = `2027-03-12T${String(input.hour).padStart(2, "0")}:00:00.000Z`;
    const endAt = `2027-03-12T${String(input.hour + 1).padStart(2, "0")}:00:00.000Z`;
    return {
      summary: input.summary,
      startAt,
      endAt,
      timezone: "America/Los_Angeles",
      childEntityIds: [input.childEntityId],
      location: null,
      notes: null,
      custodyException: input.custody
        ? {
            childEntityId: input.childEntityId,
            fromAt: startAt,
            toAt: endAt,
            normalCustodianEntityId: input.custody.normalCustodianEntityId,
            substituteCustodianEntityId:
              input.custody.substituteCustodianEntityId,
            authorityBaselineRelationshipId:
              input.custody.authorityBaselineRelationshipId,
            reason: "The normal handoff changed for this interval.",
          }
        : null,
    };
  }

  async function approve(
    service: HouseholdCoordinationService,
    proposal: HouseholdScheduleProposal,
    partyEntityId: string,
  ): Promise<void> {
    const link = (
      await repository.listApprovalLinks(proposal.proposalId, proposal.version)
    ).find((candidate) => candidate.partyEntityId === partyEntityId);
    if (!link) throw new Error(`approval link missing for ${partyEntityId}`);
    await service.respondToProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      partyEntityId,
      approvalRequestId: link.approvalRequestId,
      decision: "approve",
      reason: "I approve these exact proposal bytes.",
    });
  }

  it("isolates one principal's roles, grants, heads, and schedule visibility by household", async () => {
    const service = coordinator();
    const principalId = await person("shared-principal");
    const childA = await person("household-a-child");
    const childB = await person("household-b-child");
    const householdA = `household-a-${randomUUID()}`;
    const householdB = `household-b-${randomUUID()}`;
    const sharedCoordinationId = `school-pickup-${randomUUID()}`;

    await service.bindRole({
      householdId: householdA,
      entityId: childA,
      role: "child",
      subjectEntityIds: [childA],
      evidence: "Owner assigned child A to household A.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await service.bindRole({
      householdId: householdA,
      entityId: principalId,
      role: "co_parent",
      subjectEntityIds: [childA],
      evidence: "Owner assigned the principal as child A's co-parent.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await service.bindRole({
      householdId: householdB,
      entityId: childB,
      role: "child",
      subjectEntityIds: [childB],
      evidence: "Owner assigned child B to household B.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await service.bindRole({
      householdId: householdB,
      entityId: principalId,
      role: "caregiver",
      subjectEntityIds: [childB],
      evidence: "Owner assigned the principal as child B's caregiver.",
      boundByEntityId: SELF_ENTITY_ID,
    });

    await service.issueGrant({
      householdId: householdA,
      principalEntityId: principalId,
      role: "co_parent",
      subjectEntityIds: [childA],
      scopes: ["calendar.freebusy", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await service.issueGrant({
      householdId: householdB,
      principalEntityId: principalId,
      role: "caregiver",
      subjectEntityIds: [childB],
      scopes: ["calendar.freebusy", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
    });

    const proposalA = await service.createProposal({
      householdId: householdA,
      coordinationId: sharedCoordinationId,
      terms: scheduleTerms({
        summary: "Household A pickup",
        childEntityId: childA,
        hour: 17,
      }),
      affectedPartyEntityIds: [childA],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const proposalB = await service.createProposal({
      householdId: householdB,
      coordinationId: sharedCoordinationId,
      terms: scheduleTerms({
        summary: "Household B pickup",
        childEntityId: childB,
        hour: 19,
      }),
      affectedPartyEntityIds: [childB],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const exportA = await service.exportFor({
      householdId: householdA,
      principalEntityId: principalId,
    });
    const exportB = await service.exportFor({
      householdId: householdB,
      principalEntityId: principalId,
    });
    expect(exportA.householdId).toBe(householdA);
    expect(exportA.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          householdId: householdA,
          entityId: principalId,
          role: "co_parent",
        }),
      ]),
    );
    expect(exportA.schedules).toEqual([
      expect.objectContaining({
        householdId: householdA,
        proposalId: proposalA.proposalId,
      }),
    ]);
    expect(JSON.stringify(exportA)).not.toContain(childB);

    expect(exportB.householdId).toBe(householdB);
    expect(exportB.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          householdId: householdB,
          entityId: principalId,
          role: "caregiver",
        }),
      ]),
    );
    expect(exportB.schedules).toEqual([
      expect.objectContaining({
        householdId: householdB,
        proposalId: proposalB.proposalId,
      }),
    ]);
    expect(JSON.stringify(exportB)).not.toContain(childA);

    await expect(
      service.requireScope({
        householdId: householdA,
        principalEntityId: principalId,
        subjectEntityId: childB,
        scope: "calendar.freebusy",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    await expect(
      repository.getHead(householdA, sharedCoordinationId),
    ).resolves.toMatchObject({ householdId: householdA });
    await expect(
      repository.getHead(householdB, sharedCoordinationId),
    ).resolves.toMatchObject({ householdId: householdB });
  });

  it("pins custody authority revisions and invalidates approvals on revise and revoke", async () => {
    const service = coordinator();
    const householdId = `custody-household-${randomUUID()}`;
    const childId = await person("custody-revision-child");
    const coParentId = await person("custody-revision-co-parent");
    await service.bindRole({
      householdId,
      entityId: childId,
      role: "child",
      subjectEntityIds: [childId],
      evidence: "Owner assigned the child to the custody household.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await service.bindRole({
      householdId,
      entityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [childId],
      evidence: "Owner assigned the child's co-parent.",
      boundByEntityId: SELF_ENTITY_ID,
    });

    const firstAuthority = await service.setCustodyAuthority({
      householdId,
      childEntityId: childId,
      custodianEntityIds: [SELF_ENTITY_ID, coParentId],
      evidence: "Owner supplied the signed custody baseline.",
      updatedByEntityId: SELF_ENTITY_ID,
    });
    const firstProposal = await service.createProposal({
      householdId,
      coordinationId: `custody-revision-${randomUUID()}`,
      terms: scheduleTerms({
        summary: "First revised handoff",
        childEntityId: childId,
        hour: 14,
        custody: {
          normalCustodianEntityId: coParentId,
          substituteCustodianEntityId: SELF_ENTITY_ID,
          authorityBaselineRelationshipId: firstAuthority.relationshipId,
        },
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [],
      createdByEntityId: SELF_ENTITY_ID,
    });
    expect(
      firstProposal.terms.custodyException?.authorityBaselineRevisionSha256,
    ).toBe(firstAuthority.revisionSha256);
    await approve(service, firstProposal, SELF_ENTITY_ID);
    await approve(service, firstProposal, coParentId);

    const secondAuthority = await service.setCustodyAuthority({
      householdId,
      relationshipId: firstAuthority.relationshipId,
      childEntityId: childId,
      custodianEntityIds: [SELF_ENTITY_ID, coParentId],
      evidence: "Owner reconfirmed a revised signed custody baseline.",
      updatedByEntityId: SELF_ENTITY_ID,
      expectedRevisionSha256: firstAuthority.revisionSha256,
    });
    expect(secondAuthority.revision).toBe(firstAuthority.revision + 1);
    expect(secondAuthority.revisionSha256).not.toBe(
      firstAuthority.revisionSha256,
    );
    await expect(
      repository.getProposal(firstProposal.proposalId, firstProposal.version),
    ).resolves.toMatchObject({ status: "invalidated" });
    const firstLinks = await repository.listApprovalLinks(
      firstProposal.proposalId,
      firstProposal.version,
    );
    for (const link of firstLinks) {
      await expect(
        approvals.byId(link.approvalRequestId, link.partyEntityId),
      ).resolves.toMatchObject({ state: "expired" });
    }
    await expect(
      service.finalizeProposal({
        proposalId: firstProposal.proposalId,
        proposalVersion: firstProposal.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_PROPOSAL_CONFLICT" });

    const secondProposal = await service.createProposal({
      householdId,
      coordinationId: firstProposal.coordinationId,
      terms: scheduleTerms({
        summary: "Second revised handoff",
        childEntityId: childId,
        hour: 16,
        custody: {
          normalCustodianEntityId: coParentId,
          substituteCustodianEntityId: SELF_ENTITY_ID,
          authorityBaselineRelationshipId: secondAuthority.relationshipId,
        },
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [],
      createdByEntityId: SELF_ENTITY_ID,
    });
    expect(
      secondProposal.terms.custodyException?.authorityBaselineRevisionSha256,
    ).toBe(secondAuthority.revisionSha256);
    await approve(service, secondProposal, SELF_ENTITY_ID);
    await approve(service, secondProposal, coParentId);

    const revoked = await service.revokeCustodyAuthority({
      householdId,
      relationshipId: secondAuthority.relationshipId,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Owner revoked this authority after receiving replacement terms.",
      expectedRevisionSha256: secondAuthority.revisionSha256,
    });
    expect(revoked).toMatchObject({
      householdId,
      relationshipId: secondAuthority.relationshipId,
      status: "revoked",
      revision: secondAuthority.revision + 1,
    });
    await expect(
      repository.getProposal(secondProposal.proposalId, secondProposal.version),
    ).resolves.toMatchObject({ status: "invalidated" });
    await expect(
      service.finalizeProposal({
        proposalId: secondProposal.proposalId,
        proposalVersion: secondProposal.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_PROPOSAL_CONFLICT" });
    await expect(
      service.setCustodyAuthority({
        householdId,
        relationshipId: revoked.relationshipId,
        childEntityId: childId,
        custodianEntityIds: [SELF_ENTITY_ID, coParentId],
        evidence: "Attempted reactivation.",
        updatedByEntityId: SELF_ENTITY_ID,
        expectedRevisionSha256: revoked.revisionSha256,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
  });
});
