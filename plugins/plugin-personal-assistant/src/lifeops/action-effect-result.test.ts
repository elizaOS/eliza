/**
 * Exercises the parent-suite action seams through the canonical executor so
 * callback delivery is proven against real settlement behavior, including
 * applied, no-op, failed, missing, and forged receipt outcomes.
 */

import {
  type Action,
  executePlannedToolCall,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  completeLifeOpsEffect,
  lifeOpsNoopEffect,
} from "./action-effect-result.js";
import { createFamilyCommunicationsAction } from "./family-communications/action.js";
import type { FamilyCommunicationsService } from "./family-communications/service.js";
import { createHouseholdOperationsAction } from "./household-operations/action.js";
import type { HouseholdOperationsService } from "./household-operations/service.js";
import { createParentingGuidanceAction } from "./parenting/action.js";
import type { ParentingGuidanceRuntimeService } from "./parenting/service.js";
import { createResourceCapacityAction } from "./resource-capacity/action.js";
import type { ResourceCapacityService } from "./resource-capacity/service.js";
import { RESOURCE_CAPACITY_POLICY_VERSION } from "./resource-capacity/types.js";
import { createSchoolSourceFactAction } from "./school/action.js";
import type { SchoolSourceFactRuntimeService } from "./school/service.js";
import { sha256 } from "./school/types.js";

const COMMITTED_AT = "2027-09-01T12:00:00.000Z";
const SHA = "a".repeat(64);

function message(): Memory {
  return {
    id: "message-effect-contract",
    entityId: SELF_ENTITY_ID,
    agentId: SELF_ENTITY_ID,
    roomId: "room-effect-contract",
    content: { text: "Please handle this.", source: "test" },
  } as Memory;
}

function runtime(actions: Action[]): IAgentRuntime {
  return {
    actions,
    agentId: SELF_ENTITY_ID,
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

async function execute(
  action: Action,
  params: Record<string, unknown>,
  callback: HandlerCallback,
) {
  return executePlannedToolCall(
    runtime([action]),
    {
      message: message(),
      callback,
      userRoles: ["OWNER"],
      activeContexts: ["general"],
    },
    { name: action.name, params },
  );
}

function expectBoundCallback(callback: ReturnType<typeof vi.fn>): void {
  expect(callback).toHaveBeenCalledOnce();
  const content = callback.mock.calls[0]?.[0];
  expect(content).toEqual(
    expect.objectContaining({
      text: expect.any(String),
      effectReceiptIds: [expect.any(String)],
    }),
  );
}

describe("LifeOps action effect settlement", () => {
  it("opts only mutation-capable umbrella actions into strict receipt delivery", () => {
    const mutationActions = [
      createFamilyCommunicationsAction({
        resolveAuthenticatedPrincipal: async () => SELF_ENTITY_ID,
        issueSpeakerAttestation: async () => {
          throw new Error("not used");
        },
        resolveWeekItems: async () => [],
      }),
      createHouseholdOperationsAction({ authorize: async () => true }),
      createResourceCapacityAction({ authorize: async () => true }),
      createSchoolSourceFactAction({ authorize: async () => true }),
    ];
    for (const action of mutationActions) {
      expect(action.tags).toContain("effect:receipt-required");
    }
    expect(
      createParentingGuidanceAction({
        resolveAuthenticatedPrincipal: async () => SELF_ENTITY_ID,
      }).tags,
    ).not.toContain("effect:receipt-required");
  });

  it("binds a persisted family projection to its durable projection ID", async () => {
    const service = {
      projectChildWeek: vi.fn(async () => ({
        projectionId: "child-week-projection-1",
        principalEntityId: "child-1",
        childEntityId: "child-1",
        windowStartsAt: "2027-09-01T00:00:00.000Z",
        windowEndsAt: "2027-09-08T00:00:00.000Z",
        items: [],
        omissions: {
          not_for_child: 0,
          principal_not_in_audience: 0,
          not_household_shared: 0,
          adult_or_private_kind: 0,
          sensitive_data_class: 0,
        },
        snapshotSha256: SHA,
        generatedAt: COMMITTED_AT,
      })),
    } as unknown as FamilyCommunicationsService;
    const action = createFamilyCommunicationsAction({
      resolveAuthenticatedPrincipal: async () => "child-1",
      issueSpeakerAttestation: async () => {
        throw new Error("voice attestation was not requested");
      },
      resolveWeekItems: async () => [],
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "child_week",
        childEntityId: "child-1",
        windowStartsAt: "2027-09-01T00:00:00.000Z",
        windowEndsAt: "2027-09-08T00:00:00.000Z",
        sourceRefs: ["household:child-week"],
      },
      callback,
    );

    expect(result.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: expect.objectContaining({
          id: "child-week-projection-1",
          version: SHA,
        }),
        commit: expect.objectContaining({
          id: "child-week-projection-1",
          committedAt: COMMITTED_AT,
        }),
      }),
    ]);
    expectBoundCallback(callback);
  });

  it("binds a household revision to the exact persisted revision", async () => {
    const service = {
      putRevision: vi.fn(async (input) => ({
        ...input.definition,
        revision: 1,
        contentSha256: SHA,
        createdAt: COMMITTED_AT,
      })),
    } as unknown as HouseholdOperationsService;
    const action = createHouseholdOperationsAction({
      authorize: async () => true,
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "put_record",
        expectedRevision: 0,
        input: {
          kind: "vendor_profile",
          recordId: "vendor-record-1",
          householdId: "household-1",
          vendorEntityId: "vendor-entity-1",
          serviceKinds: ["home-maintenance"],
          contactRouteRefs: ["contact-route-1"],
          accessWindows: [],
          accountReference: null,
          notes: null,
          active: true,
          visibility: { kind: "owner_private" },
        },
      },
      callback,
    );

    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: {
        kind: "lifeops.household_operation",
        id: "vendor-record-1",
        version: "1",
      },
      commit: {
        id: "vendor_profile:vendor-record-1:1",
        committedAt: COMMITTED_AT,
      },
    });
    expectBoundCallback(callback);
  });

  it("binds a household resource revision to its durable row", async () => {
    const service = {
      putResource: vi.fn(async (input) => ({
        ...input.definition,
        revision: 1,
        contentSha256: SHA,
        createdAt: COMMITTED_AT,
      })),
    } as unknown as ResourceCapacityService;
    const action = createResourceCapacityAction({
      authorize: async () => true,
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "put_resource",
        expectedRevision: 0,
        resource: {
          schemaVersion: RESOURCE_CAPACITY_POLICY_VERSION,
          resourceId: "caregiver-resource-1",
          householdId: "household-1",
          kind: "caregiver",
          label: "Caregiver",
          active: true,
          capabilityIds: ["school-pickup"],
          authorization: {
            state: "authorized",
            validFrom: "2027-08-01T00:00:00.000Z",
            expiresAt: "2027-10-01T00:00:00.000Z",
            revokedAt: null,
            authorizedByEntityIds: [SELF_ENTITY_ID],
            evidenceRefs: ["owner-confirmation-1"],
          },
          availability: [
            {
              windowId: "availability-caregiver-resource-1",
              state: "available",
              startsAt: "2027-08-01T00:00:00.000Z",
              endsAt: "2027-10-01T00:00:00.000Z",
              sourceRef: "calendar-freebusy:caregiver-resource-1:v1",
              observedAt: "2027-08-01T00:00:00.000Z",
              expiresAt: "2027-09-15T00:00:00.000Z",
            },
          ],
          caregiverEntityId: "caregiver-1",
          authorizedChildEntityIds: ["child-1"],
          maximumConcurrentChildren: 1,
          trainingCapabilityIds: [],
        },
      },
      callback,
    );

    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: {
        kind: "lifeops.household_resource",
        id: "caregiver-resource-1",
        version: "1",
      },
      commit: {
        id: "caregiver:caregiver-resource-1:1",
        committedAt: COMMITTED_AT,
      },
    });
    expectBoundCallback(callback);
  });

  it("links every durable proposal review artifact from the applied receipt", async () => {
    const service = {
      createProposal: vi.fn(async () => ({
        proposal: {
          proposalId: "capacity-proposal-1",
          version: 1,
          idempotencyKey: "capacity-proposal-key-1",
          createdAt: COMMITTED_AT,
          evaluation: { conflicts: [] },
        },
        effectiveState: "pending_review",
        approvals: [
          {
            partyEntityId: SELF_ENTITY_ID,
            approvalRequestId: "approval-request-1",
            state: "pending",
          },
        ],
        reviewTaskId: "scheduled-review-1",
        replayed: false,
      })),
    } as unknown as ResourceCapacityService;
    const action = createResourceCapacityAction({
      authorize: async () => true,
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "propose_plan",
        plan: {
          householdId: "household-1",
          title: "School pickup",
          childEntityIds: ["child-1"],
          needs: [
            {
              needId: "pickup-1",
              title: "School pickup",
              startsAt: "2027-09-02T15:00:00.000Z",
              endsAt: "2027-09-02T16:00:00.000Z",
              preparationMinutes: 0,
              recoveryMinutes: 0,
              originLocationRef: "place:school",
              destinationLocationRef: "place:home",
              childEntityIds: ["child-1"],
              requirements: {
                caregiverCount: 1,
                caregiverCapabilityIds: [],
                vehicleRequired: false,
                passengerCount: 0,
                carSeats: [],
                accessibilityCapabilityIds: [],
              },
              handoffs: [],
              sourceRefs: ["calendar:event-1"],
            },
          ],
        },
        assignments: [],
        transitions: [],
        maximumSourceAgeMinutes: 60,
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        idempotencyKey: "capacity-proposal-key-1",
        expiresAt: "2027-09-02T14:00:00.000Z",
      },
      callback,
    );

    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: {
        kind: "lifeops.resource_capacity_proposal",
        id: "capacity-proposal-1",
        version: "1",
      },
      artifacts: [
        {
          kind: "lifeops.approval_request",
          id: "approval-request-1",
        },
        {
          kind: "lifeops.scheduled_task",
          id: "scheduled-review-1",
        },
      ],
      idempotency: {
        key: "capacity-proposal-key-1",
        replayed: false,
      },
    });
    expectBoundCallback(callback);
  });

  it("binds school capture to the persisted artifact and fact IDs", async () => {
    const content = "Field trip permission form.";
    const service = {
      captureCandidates: vi.fn(async () => ({
        artifact: {
          id: "school-artifact-1",
          contentSha256: sha256(content),
          createdAt: COMMITTED_AT,
        },
        sourceFacts: [
          {
            id: "school-fact-1",
            revisionSha256: SHA,
            createdAt: COMMITTED_AT,
          },
        ],
      })),
    } as unknown as SchoolSourceFactRuntimeService;
    const action = createSchoolSourceFactAction({
      authorize: async () => true,
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "capture_candidates",
        artifact: {
          kind: "document",
          sourceId: "school-portal",
          stableReference: "notice-1",
          snapshotReference: "document:notice-1",
          sourceActor: {
            kind: "external",
            id: "school-portal",
            label: "School portal",
          },
          observedAt: COMMITTED_AT,
          retrievedAt: COMMITTED_AT,
          effectiveAt: null,
          contentSha256: sha256(content),
          untrustedContent: content,
          visibility: "owner_private",
        },
        candidates: [
          {
            stableFactKey: "school.notice.1",
            domain: "school",
            factType: "school_notice.event",
            value: { title: "Field trip" },
            subjectEntityIds: [],
            confidence: 0.9,
            authority: "school_notice",
            version: { sequence: 1, externalVersion: "v1" },
            effectiveFrom: null,
            effectiveUntil: null,
            visibility: "owner_private",
            extractorId: "school-extractor",
            extractorVersion: "1",
            supersedesStableFactKeys: [],
            contradictsStableFactKeys: [],
          },
        ],
      },
      callback,
    );

    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: {
        kind: "lifeops.school_source_artifact",
        id: "school-artifact-1",
      },
      artifacts: [
        {
          kind: "lifeops.school_source_fact",
          id: "school-fact-1",
          version: SHA,
        },
      ],
    });
    expectBoundCallback(callback);
  });

  it("delivers a resource evaluation as an explicit no-op, never applied proof", async () => {
    const service = {
      evaluate: vi.fn(async () => ({
        feasible: true,
        evaluatedAt: COMMITTED_AT,
        inputSha256: SHA,
        resourceSnapshots: [],
        conflicts: [],
        explanationFacts: [],
        noReservationCreated: true,
      })),
    } as unknown as ResourceCapacityService;
    const action = createResourceCapacityAction({
      authorize: async () => true,
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "evaluate_plan",
        plan: {
          householdId: "household-1",
          title: "School pickup",
          childEntityIds: ["child-1"],
          needs: [
            {
              needId: "pickup-1",
              title: "School pickup",
              startsAt: "2027-09-02T15:00:00.000Z",
              endsAt: "2027-09-02T16:00:00.000Z",
              preparationMinutes: 0,
              recoveryMinutes: 0,
              originLocationRef: "place:school",
              destinationLocationRef: "place:home",
              childEntityIds: ["child-1"],
              requirements: {
                caregiverCount: 1,
                caregiverCapabilityIds: [],
                vehicleRequired: false,
                passengerCount: 0,
                carSeats: [],
                accessibilityCapabilityIds: [],
              },
              handoffs: [],
              sourceRefs: ["calendar:event-1"],
            },
          ],
        },
        assignments: [],
        transitions: [],
        maximumSourceAgeMinutes: 60,
      },
      callback,
    );

    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      resource: {
        kind: "lifeops.resource_capacity_evaluation",
        id: SHA,
      },
    });
    expectBoundCallback(callback);
  });

  it("keeps a handler-time authorization failure visible without mutation proof", async () => {
    const authorize = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const action = createHouseholdOperationsAction({ authorize });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        action: "evaluate_opportunity",
        recordId: "opportunity-1",
      },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      effectReceipts: [
        {
          outcome: "failed",
          failure: {
            code: "PERMISSION_DENIED",
            acceptance: "rejected",
          },
        },
      ],
    });
    expectBoundCallback(callback);
  });

  it("keeps the read-only parenting action deliverable without mutation receipts", async () => {
    const service = {
      advise: vi.fn(async () => ({
        decision: {
          status: "privacy_withheld",
          reasons: ["Private child context was withheld."],
          omissionNotice: "Private details were omitted.",
          frameworkNotice: null,
        },
        handoffResources: {
          status: "not_required",
          requestedKinds: [],
        },
        uncertaintyNotice: "This is general educational guidance.",
        humanNextStep: "Discuss the boundary with the child.",
      })),
    } as unknown as ParentingGuidanceRuntimeService;
    const action = createParentingGuidanceAction({
      resolveAuthenticatedPrincipal: async () => SELF_ENTITY_ID,
      getService: () => service,
    });
    const callback = vi.fn(async () => []);

    const result = await execute(
      action,
      {
        subjectEntityId: "child-1",
        ageBand: "school_age",
        topic: "boundary_setting",
        requestedFramework: "none",
      },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      userFacingText: expect.stringContaining("Private details were omitted."),
    });
    expect(result.effectReceipts).toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("Private details were omitted."),
    });
  });

  it("suppresses missing and malformed proof on the real umbrella action contract", async () => {
    const legitimate = createHouseholdOperationsAction({
      authorize: async () => true,
    });
    const missingProof: Action = {
      ...legitimate,
      handler: async (_runtime, _message, _state, _options, callback) => {
        await callback?.({ text: "The record was saved." });
        return { success: true, text: "The record was saved." };
      },
    };
    const missingCallback = vi.fn(async () => []);

    const ignoredParams = {
      action: "put_record",
      expectedRevision: 0,
      input: {},
    };
    await execute(missingProof, ignoredParams, missingCallback);

    expect(missingCallback).not.toHaveBeenCalled();

    const malformedProof: Action = {
      ...legitimate,
      handler: async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: "The record was saved.",
          effectReceiptIds: ["forged-receipt"],
        });
        return {
          success: true,
          text: "The record was saved.",
          userFacingText: "The record was saved.",
          verifiedUserFacing: true,
          effectReceipts: [
            {
              receiptId: "forged-receipt",
              operation: "lifeops.household_operation.put_revision",
              resource: {
                kind: "lifeops.household_operation",
                id: "vendor-record-1",
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: COMMITTED_AT,
              outcome: "applied",
            },
          ],
          userFacingEffectReceiptIds: ["forged-receipt"],
        };
      },
    };
    const malformedCallback = vi.fn(async () => []);

    const result = await execute(
      malformedProof,
      ignoredParams,
      malformedCallback,
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/invalid result|commit proof/iu);
    expect(malformedCallback).not.toHaveBeenCalled();
  });
});

// The settlement helper's callback is the turn's single visible delivery of
// the canonical text, so a successful settlement must also declare the turn
// complete — that opts every LifeOps read/answer action (calendar feed,
// contact search, owner records, …) into the planner's gated-evaluator skip in
// one place, closing the double-speak where the model paraphrased an
// already-delivered answer ("clear tomorrow." then "you're clear tomorrow.").
describe("completeLifeOpsEffect turn completion", () => {
  const receipt = () =>
    lifeOpsNoopEffect({
      receiptId: "CALENDAR:calendar.feed:message-effect-contract:snapshot-1",
      operation: "calendar.feed",
      resource: { kind: "runtime.message", id: "message-effect-contract" },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: COMMITTED_AT,
      reason: "Read-only evaluation left calendar state unchanged.",
    });

  it("declares a successful settlement turn-complete and delivers the text once", async () => {
    const callback = vi.fn(async () => []);
    const result = await completeLifeOpsEffect(
      callback,
      { success: true, text: "clear tomorrow." },
      receipt(),
    );

    expect(result).toMatchObject({
      success: true,
      text: "clear tomorrow.",
      userFacingText: "clear tomorrow.",
      verifiedUserFacing: true,
      turnComplete: true,
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ text: "clear tomorrow." });
  });

  it("preserves an action's explicit turnComplete: false disclaimer", async () => {
    const result = await completeLifeOpsEffect(
      undefined,
      { success: true, text: "clear tomorrow.", turnComplete: false },
      receipt(),
    );

    expect(result.turnComplete).toBe(false);
  });

  it("leaves failed settlements un-gated for evaluator recovery guidance", async () => {
    const result = await completeLifeOpsEffect(
      undefined,
      { success: false, text: "The calendar provider is unavailable." },
      receipt(),
    );

    expect(result.verifiedUserFacing).toBe(true);
    expect(result.turnComplete).toBeUndefined();
  });
});
