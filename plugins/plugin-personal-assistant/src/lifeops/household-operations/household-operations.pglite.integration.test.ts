/**
 * Real-PGlite integration coverage for the canonical knowledge graph, durable
 * household-operation repository, restart, concurrency, privacy, and policy.
 */
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import type { AgentRuntime, Memory } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { createHouseholdOperationsAction } from "./action.js";
import { HouseholdOperationsRepository } from "./repository.js";
import { HouseholdOperationsService } from "./service.js";
import type {
  AlmanacEntryDefinition,
  HouseholdObservationInput,
  HouseholdSourceProvenance,
  ItemReplacementThresholdDefinition,
  OpportunityDefinition,
  ResponsibilityAssignmentDefinition,
  VendorProfileDefinition,
} from "./types.js";

describe("household operations — real PGlite and runtime graph", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let entities: EntityStore;
  let repository: HouseholdOperationsRepository;
  let service: HouseholdOperationsService;
  let nowMs = Date.parse("2027-03-10T12:00:00.000Z");

  const householdId = "household-operations-main";
  const partnerEntityId = "household-operations-partner";
  const childEntityId = "household-operations-child";
  const vendorEntityId = "household-operations-vendor";
  const outsiderEntityId = "household-operations-outsider";
  const maintenanceAssignmentId = "responsibility-home-maintenance";
  const vendorRecordId = "vendor-home-services";
  const maintenanceAlmanacId = "almanac-water-filter-gutters";
  const maintenanceSubjectKey = "home:water-filter-and-gutters";

  function currentDate(): Date {
    return new Date(nowMs);
  }

  function provenance(
    sourceId: string,
    sourceRevision = 1,
    overrides?: Partial<HouseholdSourceProvenance>,
  ): HouseholdSourceProvenance {
    return {
      kind: "authenticated_user",
      sourceId,
      sourceRevision,
      observedAt: currentDate().toISOString(),
      evidenceRef: `evidence:${sourceId}:${sourceRevision}`,
      authority: "user_confirmed",
      confidence: 1,
      ...overrides,
    };
  }

  function responsibility(
    recordId: string,
    subjectKey: string,
    overrides?: Partial<ResponsibilityAssignmentDefinition>,
  ): ResponsibilityAssignmentDefinition {
    return {
      kind: "responsibility_assignment",
      recordId,
      householdId,
      subjectKey,
      owners: {
        conceptionOwnerId: SELF_ENTITY_ID,
        planningOwnerId: SELF_ENTITY_ID,
        executionOwnerId: partnerEntityId,
        monitoringOwnerId: partnerEntityId,
      },
      minimumStandard: "Close the loop with evidence before the due window.",
      acceptedByEntityIds: [SELF_ENTITY_ID, partnerEntityId],
      startsAt: "2027-01-01T00:00:00.000Z",
      endsAt: null,
      nonUsePolicy: {
        dismissalThreshold: 2,
        overdueThreshold: 2,
        evaluationWindowDays: 30,
        escalationMode: "private_renegotiation",
      },
      active: true,
      visibility: { kind: "principals", principalEntityIds: [partnerEntityId] },
      ...overrides,
    };
  }

  function sizeObservation(input: {
    sourceRevision: number;
    fitState: "too_small" | "fits" | "room_to_grow" | "damaged" | "unknown";
    correctsObservationId?: string;
  }): HouseholdObservationInput {
    return {
      householdId,
      subjectKey: `child-item:${childEntityId}:shoes`,
      subjectEntityIds: [childEntityId],
      observationKind: "child_item_size",
      value: {
        kind: "child_item_size",
        childEntityId,
        itemCategory: "shoes",
        sizeLabel: input.fitState === "too_small" ? "2Y" : "1Y",
        fitState: input.fitState,
        measurement: null,
      },
      provenance: provenance("shoe-fit", input.sourceRevision),
      visibility: { kind: "child_scoped", childEntityId },
      supersedesObservationId: input.correctsObservationId ?? null,
      correctsObservationId: input.correctsObservationId ?? null,
    };
  }

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
    for (const entity of [
      {
        entityId: partnerEntityId,
        preferredName: "Household Partner",
      },
      { entityId: childEntityId, preferredName: "Household Child" },
      { entityId: vendorEntityId, preferredName: "Home Services Vendor" },
      { entityId: outsiderEntityId, preferredName: "Unrelated Person" },
    ]) {
      await entities.upsert({
        entityId: entity.entityId,
        type: entity.entityId === vendorEntityId ? "organization" : "person",
        preferredName: entity.preferredName,
        identities: [],
        tags: ["household-operations-integration"],
        visibility: "owner_only",
        state: {},
      });
    }
    const relationships = graph.getRelationshipStore(runtime.agentId);
    await relationships.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: partnerEntityId,
      type: "partner_of",
      metadata: {
        householdRole: "current_partner",
        householdSubjectEntityIds: [childEntityId],
      },
      state: {},
      evidence: ["Owner confirmed household partner."],
      confidence: 1,
      source: "user_chat",
    });
    await relationships.upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: childEntityId,
      type: "parent_of",
      metadata: {
        householdRole: "child",
        householdSubjectEntityIds: [childEntityId],
      },
      state: {},
      evidence: ["Owner confirmed household child."],
      confidence: 1,
      source: "user_chat",
    });
    repository = new HouseholdOperationsRepository(runtime, runtime.agentId);
    service = new HouseholdOperationsService({
      runtime,
      agentId: runtime.agentId,
      entityStore: entities,
      relationshipStore: relationships,
      repository,
      now: currentDate,
    });
    await service.initialize();
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("returns commit proof tied to the real persisted household revision", async () => {
    const recordId = "vendor-action-effect-contract";
    const action = createHouseholdOperationsAction({
      authorize: async () => true,
      getService: () => service,
    });
    const result = await action.handler(
      runtime,
      {
        id: "household-action-effect-message",
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: "Save this household vendor.", source: "test" },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "put_record",
          expectedRevision: 0,
          input: {
            kind: "vendor_profile",
            recordId,
            householdId,
            vendorEntityId,
            serviceKinds: ["household-action-proof"],
            contactRouteRefs: ["contact-route:household-action-proof"],
            accessWindows: [],
            accountReference: null,
            notes: null,
            active: true,
            visibility: { kind: "owner_private" },
          },
        },
      },
      undefined,
    );

    const persisted = await repository.getCurrentRevision(
      "vendor_profile",
      recordId,
    );
    expect(persisted).toMatchObject({ recordId, revision: 1 });
    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      operation: "lifeops.household_operation.put_revision",
      resource: {
        kind: "lifeops.household_operation",
        id: recordId,
        version: "1",
      },
      commit: {
        kind: "durable",
        id: `vendor_profile:${recordId}:1`,
        committedAt: persisted?.createdAt,
      },
    });
  });

  it("G29 preserves vendor/service history and blocks outreach until an exact calendar check", async () => {
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: responsibility(
        maintenanceAssignmentId,
        maintenanceSubjectKey,
      ),
      expectedRevision: 0,
    });
    const vendor: VendorProfileDefinition = {
      kind: "vendor_profile",
      recordId: vendorRecordId,
      householdId,
      vendorEntityId,
      serviceKinds: ["gutter_cleaning", "water_filter_replacement"],
      contactRouteRefs: ["contact-route:home-services:sms"],
      accessWindows: [
        {
          daysOfWeek: [2, 4],
          localStart: "09:00",
          localEnd: "14:00",
          timezone: "America/Los_Angeles",
          note: "Side gate access after confirmation.",
        },
      ],
      accountReference: "vendor-account:home-main",
      notes: "Use the existing household vendor account.",
      active: true,
      visibility: { kind: "owner_private" },
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: vendor,
      expectedRevision: 0,
    });
    const almanac: AlmanacEntryDefinition = {
      kind: "almanac_entry",
      recordId: maintenanceAlmanacId,
      householdId,
      title: "Water filter replacement and gutter service",
      subjectKey: maintenanceSubjectKey,
      category: "maintenance",
      trigger: {
        kind: "source_window",
        opensAt: "2027-03-11T17:00:00.000Z",
        closesAt: "2027-03-15T21:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      vendorProfileRecordId: vendorRecordId,
      responsibilityAssignmentId: maintenanceAssignmentId,
      preparationLeadDays: 7,
      sourceObservationIds: [],
      active: true,
      visibility: { kind: "owner_private" },
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: almanac,
      expectedRevision: 0,
    });

    const preparationBriefInput = {
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      window: {
        startsAt: "2027-03-05T00:00:00.000Z",
        endsAt: "2027-03-10T00:00:00.000Z",
      },
      calendarChecks: [],
    };
    const preparationBrief = await service.generateWeeklyBrief(
      preparationBriefInput,
    );
    expect(preparationBrief.replayed).toBe(false);
    expect(
      preparationBrief.items.some(
        (item) => item.subjectKey === maintenanceSubjectKey,
      ),
    ).toBe(true);
    const preparationReplay = await service.generateWeeklyBrief(
      preparationBriefInput,
    );
    expect(preparationReplay.briefId).toBe(preparationBrief.briefId);
    expect(preparationReplay.replayed).toBe(true);

    const blockedBrief = await service.generateWeeklyBrief({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      window: {
        startsAt: "2027-03-10T00:00:00.000Z",
        endsAt: "2027-03-17T00:00:00.000Z",
      },
      calendarChecks: [],
    });
    const blockedItem = blockedBrief.items.find(
      (item) => item.subjectKey === maintenanceSubjectKey,
    );
    expect(blockedItem).toMatchObject({
      state: "blocked_on_calendar_required",
      proposedAction: { effect: "verify", approvalRequirement: "none" },
      calendarCheck: { state: "required" },
    });
    expect(blockedItem?.vendorContext).toEqual({
      vendorEntityId,
      contactRouteRefs: ["contact-route:home-services:sms"],
      accessWindows: vendor.accessWindows,
    });

    const readyBrief = await service.generateWeeklyBrief({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      window: {
        startsAt: "2027-03-10T00:00:00.000Z",
        endsAt: "2027-03-17T00:00:00.000Z",
      },
      calendarChecks: [
        {
          subjectKey: maintenanceSubjectKey,
          window: {
            startsAt: "2027-03-11T17:00:00.000Z",
            endsAt: "2027-03-15T21:00:00.000Z",
          },
          state: "available",
          checkedAt: currentDate().toISOString(),
          sourceRefs: ["calendar-availability:family-and-work"],
          conflictRefs: [],
        },
      ],
    });
    const readyItem = readyBrief.items.find(
      (item) => item.subjectKey === maintenanceSubjectKey,
    );
    expect(readyItem).toMatchObject({
      state: "ready_for_outreach_draft",
      proposedAction: {
        effect: "external_outreach_draft",
        approvalRequirement: "owner_approval",
      },
      calendarCheck: { state: "available" },
    });
    expect(
      await repository.listServiceEvents(householdId, {
        subjectKey: maintenanceSubjectKey,
      }),
    ).toEqual([]);

    await expect(
      service.recordServiceEvent({
        principalEntityId: SELF_ENTITY_ID,
        event: {
          eventKey: "service-completed-without-proof",
          householdId,
          subjectKey: maintenanceSubjectKey,
          serviceKind: "gutter_cleaning",
          vendorEntityId,
          eventKind: "completed",
          serviceWindow: null,
          relatedCalendarEventId: null,
          approvalReference: null,
          providerReceiptReference: null,
          completionEvidenceReference: null,
          provenance: provenance("vendor-completion-missing-proof"),
          visibility: { kind: "owner_private" },
        },
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    });
    await expect(
      service.recordServiceEvent({
        principalEntityId: SELF_ENTITY_ID,
        event: {
          eventKey: "outreach-sent-without-approval",
          householdId,
          subjectKey: maintenanceSubjectKey,
          serviceKind: "gutter_cleaning",
          vendorEntityId,
          eventKind: "outreach_sent",
          serviceWindow: null,
          relatedCalendarEventId: null,
          approvalReference: null,
          providerReceiptReference: "provider-receipt:message-1",
          completionEvidenceReference: null,
          provenance: provenance("vendor-outreach-missing-approval", 1, {
            kind: "provider_receipt",
            authority: "provider_confirmed",
          }),
          visibility: { kind: "owner_private" },
        },
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    });

    const completed = await service.recordServiceEvent({
      principalEntityId: SELF_ENTITY_ID,
      event: {
        eventKey: "gutter-service-completed-2027",
        householdId,
        subjectKey: maintenanceSubjectKey,
        serviceKind: "gutter_cleaning",
        vendorEntityId,
        eventKind: "completed",
        serviceWindow: {
          startsAt: "2027-03-13T17:00:00.000Z",
          endsAt: "2027-03-13T19:00:00.000Z",
        },
        relatedCalendarEventId: "calendar-event:gutter-service",
        approvalReference: "approval:gutter-service",
        providerReceiptReference: "provider-receipt:gutter-service",
        completionEvidenceReference: "receipt:gutter-service:2027",
        provenance: provenance("vendor-completion-receipt", 1, {
          kind: "vendor_receipt",
          authority: "vendor_provided",
        }),
        visibility: { kind: "owner_private" },
      },
    });
    expect(completed.inserted).toBe(true);

    const restartedRepository = new HouseholdOperationsRepository(
      runtime,
      runtime.agentId,
    );
    const restartedService = new HouseholdOperationsService({
      runtime,
      agentId: runtime.agentId,
      entityStore: entities,
      relationshipStore:
        resolveKnowledgeGraphService(runtime)?.getRelationshipStore(
          runtime.agentId,
        ) ??
        (() => {
          throw new Error("relationship store disappeared on restart");
        })(),
      repository: restartedRepository,
      now: currentDate,
    });
    await restartedService.initialize();
    const restartedHistory = await restartedRepository.listServiceEvents(
      householdId,
      { subjectKey: maintenanceSubjectKey },
    );
    expect(restartedHistory).toHaveLength(1);
    expect(restartedHistory[0]).toMatchObject({
      eventKind: "completed",
      completionEvidenceReference: "receipt:gutter-service:2027",
    });
  });

  it("keeps append-only observation corrections, detects ambiguity, and rejects concurrent provenance corruption", async () => {
    const original = await service.recordObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: {
        householdId,
        subjectKey: "home:filter-state",
        subjectEntityIds: [],
        observationKind: "home_state",
        value: {
          kind: "home_state",
          state: "likely_due",
          details: { indicator: "yellow" },
        },
        provenance: provenance("filter-photo", 1, {
          kind: "photo",
          authority: "document_extracted",
          confidence: 0.76,
        }),
        visibility: { kind: "owner_private" },
        supersedesObservationId: null,
        correctsObservationId: null,
      },
    });
    const corrected = await service.recordObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: {
        householdId,
        subjectKey: "home:filter-state",
        subjectEntityIds: [],
        observationKind: "home_state",
        value: {
          kind: "home_state",
          state: "replaced",
          details: { receiptRef: "receipt:filter:2027" },
        },
        provenance: provenance("filter-owner-correction", 1),
        visibility: { kind: "owner_private" },
        supersedesObservationId: original.observation.observationId,
        correctsObservationId: original.observation.observationId,
      },
    });
    expect(corrected.inserted).toBe(true);
    const history = await repository.listObservations(householdId, {
      subjectKey: "home:filter-state",
    });
    expect(history).toHaveLength(2);
    const resolved = await service.resolveObservation({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      subjectKey: "home:filter-state",
      observationKind: "home_state",
    });
    expect(resolved).toMatchObject({
      state: "known",
      observation: { value: { state: "replaced" } },
    });

    const sameObservedAt = currentDate().toISOString();
    for (const [sourceId, state] of [
      ["roof-document-a", "clear"],
      ["roof-document-b", "leak_seen"],
    ] as const) {
      await service.recordObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: {
          householdId,
          subjectKey: "home:roof-state",
          subjectEntityIds: [],
          observationKind: "home_state",
          value: { kind: "home_state", state, details: null },
          provenance: provenance(sourceId, 1, {
            kind: "source_document",
            authority: "document_extracted",
            confidence: 0.8,
            observedAt: sameObservedAt,
          }),
          visibility: { kind: "owner_private" },
          supersedesObservationId: null,
          correctsObservationId: null,
        },
      });
    }
    expect(
      await service.resolveObservation({
        principalEntityId: SELF_ENTITY_ID,
        householdId,
        subjectKey: "home:roof-state",
        observationKind: "home_state",
      }),
    ).toMatchObject({
      state: "ambiguous",
      reason: "equal_authority_conflict",
    });

    await service.recordObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: {
        householdId,
        subjectKey: "home:attic-state",
        subjectEntityIds: [],
        observationKind: "home_state",
        value: { kind: "home_state", state: "possibly_damp", details: null },
        provenance: provenance("attic-inference", 1, {
          kind: "inference",
          authority: "inferred",
          confidence: 0.4,
        }),
        visibility: { kind: "owner_private" },
        supersedesObservationId: null,
        correctsObservationId: null,
      },
    });
    expect(
      await service.resolveObservation({
        principalEntityId: SELF_ENTITY_ID,
        householdId,
        subjectKey: "home:attic-state",
        observationKind: "home_state",
      }),
    ).toEqual({ state: "unknown", reason: "low_confidence" });

    const concurrentBase = {
      householdId,
      subjectKey: "home:concurrent-state",
      subjectEntityIds: [],
      observationKind: "home_state" as const,
      provenance: provenance("same-provider-coordinate", 1, {
        kind: "provider_receipt",
        authority: "provider_confirmed",
      }),
      visibility: { kind: "owner_private" as const },
      supersedesObservationId: null,
      correctsObservationId: null,
    };
    const concurrent = await Promise.allSettled([
      service.recordObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: {
          ...concurrentBase,
          value: { kind: "home_state", state: "open", details: null },
        },
      }),
      service.recordObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: {
          ...concurrentBase,
          value: { kind: "home_state", state: "closed", details: null },
        },
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    await expect(
      service.recordObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: {
          ...concurrentBase,
          subjectKey: "home:adversarial-state",
          provenance: provenance("adversarial-state", 1),
          value: {
            kind: "home_state",
            state: "unsafe\u0000prompt",
            details: null,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    });
    await expect(
      service.recordObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: {
          ...concurrentBase,
          subjectKey: "home:spoofed-provider-state",
          provenance: provenance("spoofed-provider", 1, {
            kind: "provider_receipt",
            authority: "user_confirmed",
          }),
          value: {
            kind: "home_state",
            state: "claimed_complete",
            details: null,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    });
  });

  it("G30 preserves child size history, scopes it through graph roles, and proposes no purchase", async () => {
    const threshold: ItemReplacementThresholdDefinition = {
      kind: "item_threshold",
      recordId: "item-threshold-child-shoes",
      householdId,
      childEntityId,
      itemCategory: "shoes",
      inventorySubjectKey: null,
      minimumUsableCount: null,
      replacementFitStates: ["too_small", "damaged"],
      approvalRequirement: "owner_approval",
      active: true,
      visibility: { kind: "child_scoped", childEntityId },
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: threshold,
      expectedRevision: 0,
    });
    const first = await service.recordObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: sizeObservation({ sourceRevision: 1, fitState: "fits" }),
    });
    await service.recordObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: sizeObservation({
        sourceRevision: 2,
        fitState: "too_small",
        correctsObservationId: first.observation.observationId,
      }),
    });
    const recommendation = await service.evaluateItemReplacement({
      principalEntityId: SELF_ENTITY_ID,
      thresholdRecordId: threshold.recordId,
    });
    expect(recommendation).toMatchObject({
      state: "replacement_draft",
      purchaseAllowed: false,
      approvalRequirement: "owner_approval",
    });
    expect(recommendation.sourceObservationIds).toHaveLength(1);

    const ownerHistory = await service.listChildItemSizeHistory({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      childEntityId,
      itemCategory: "shoes",
    });
    const childHistory = await service.listChildItemSizeHistory({
      principalEntityId: childEntityId,
      householdId,
      childEntityId,
      itemCategory: "shoes",
    });
    const partnerHistory = await service.listChildItemSizeHistory({
      principalEntityId: partnerEntityId,
      householdId,
      childEntityId,
      itemCategory: "shoes",
    });
    const outsiderHistory = await service.listChildItemSizeHistory({
      principalEntityId: outsiderEntityId,
      householdId,
      childEntityId,
      itemCategory: "shoes",
    });
    expect(ownerHistory).toHaveLength(2);
    expect(childHistory).toHaveLength(2);
    expect(partnerHistory).toHaveLength(2);
    expect(outsiderHistory).toEqual([]);

    const concurrentThreshold = (
      minimumUsableCount: number,
    ): ItemReplacementThresholdDefinition => ({
      ...threshold,
      recordId: "item-threshold-concurrent",
      inventorySubjectKey: "child-shoes:usable-count",
      minimumUsableCount,
    });
    const concurrent = await Promise.allSettled([
      service.putRevision({
        principalEntityId: SELF_ENTITY_ID,
        definition: concurrentThreshold(1),
        expectedRevision: 0,
      }),
      service.putRevision({
        principalEntityId: SELF_ENTITY_ID,
        definition: concurrentThreshold(2),
        expectedRevision: 0,
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(
      service.putRevision({
        principalEntityId: SELF_ENTITY_ID,
        definition: {
          ...threshold,
          itemCategory: "coats",
        },
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_CONFLICT",
    });
  });

  it("G31/G32 keeps waitlists out of coverage and preserves explicitly unstructured child time", async () => {
    const registrationAlmanac: AlmanacEntryDefinition = {
      kind: "almanac_entry",
      recordId: "almanac-summer-camp",
      householdId,
      title: "Summer camp registration",
      subjectKey: `summer-camp:${childEntityId}`,
      category: "registration",
      trigger: {
        kind: "source_window",
        opensAt: "2027-03-01T08:00:00.000Z",
        closesAt: "2027-04-01T08:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      vendorProfileRecordId: null,
      responsibilityAssignmentId: null,
      preparationLeadDays: 14,
      sourceObservationIds: [],
      active: true,
      visibility: { kind: "child_scoped", childEntityId },
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: registrationAlmanac,
      expectedRevision: 0,
    });
    const capacityOpportunity: OpportunityDefinition = {
      kind: "opportunity",
      recordId: "opportunity-summer-camp-capacity",
      householdId,
      title: "Weekday summer camp",
      subjectKey: `summer-camp:${childEntityId}:capacity`,
      subjectEntityIds: [childEntityId],
      almanacEntryRecordId: registrationAlmanac.recordId,
      opensAt: "2027-03-01T08:00:00.000Z",
      closesAt: "2027-04-01T08:00:00.000Z",
      state: "available",
      coverageContribution: "none",
      confirmationEvidenceRef: null,
      plannedStructuredHoursPerWeek: 4,
      capacityPolicy: {
        preserveUnstructuredTime: true,
        maximumStructuredHoursPerWeek: 10,
        existingStructuredHoursPerWeek: 8,
        evidenceRefs: ["family-policy:unstructured-time"],
      },
      proposedEffect: "registration",
      approvalRequirement: "owner_approval",
      effectIdempotencyKey: "camp-registration:capacity-option",
      provenance: provenance("camp-source-capacity", 1, {
        kind: "source_document",
        authority: "document_extracted",
      }),
      active: true,
      visibility: { kind: "child_scoped", childEntityId },
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: capacityOpportunity,
      expectedRevision: 0,
    });
    expect(
      await service.evaluateOpportunity({
        principalEntityId: SELF_ENTITY_ID,
        opportunityRecordId: capacityOpportunity.recordId,
      }),
    ).toMatchObject({
      state: "do_not_recommend",
      countsAsCoverage: false,
      effectDraft: null,
    });

    const campOpportunity: OpportunityDefinition = {
      ...capacityOpportunity,
      recordId: "opportunity-summer-camp-status",
      subjectKey: `summer-camp:${childEntityId}:status`,
      plannedStructuredHoursPerWeek: 1,
      capacityPolicy: {
        preserveUnstructuredTime: true,
        maximumStructuredHoursPerWeek: 10,
        existingStructuredHoursPerWeek: 8,
        evidenceRefs: ["family-policy:unstructured-time"],
      },
      effectIdempotencyKey: "camp-registration:status-option",
      provenance: provenance("camp-source-status", 1, {
        kind: "source_document",
        authority: "document_extracted",
      }),
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: campOpportunity,
      expectedRevision: 0,
    });
    expect(
      await service.evaluateOpportunity({
        principalEntityId: SELF_ENTITY_ID,
        opportunityRecordId: campOpportunity.recordId,
      }),
    ).toMatchObject({
      state: "recommend",
      countsAsCoverage: false,
      effectDraft: {
        effect: "registration",
        idempotencyKey: "camp-registration:status-option",
        approvalRequirement: "owner_approval",
      },
    });
    const waitlisted: OpportunityDefinition = {
      ...campOpportunity,
      state: "waitlisted",
      provenance: provenance("camp-source-status", 2, {
        kind: "provider_receipt",
        authority: "provider_confirmed",
      }),
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: waitlisted,
      expectedRevision: 1,
    });
    expect(
      await service.evaluateOpportunity({
        principalEntityId: SELF_ENTITY_ID,
        opportunityRecordId: campOpportunity.recordId,
      }),
    ).toMatchObject({
      state: "do_not_recommend",
      countsAsCoverage: false,
      effectDraft: null,
    });
    await expect(
      service.putRevision({
        principalEntityId: SELF_ENTITY_ID,
        definition: {
          ...waitlisted,
          state: "confirmed",
          coverageContribution: "confirmed",
          confirmationEvidenceRef: null,
        },
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    });
    const confirmed: OpportunityDefinition = {
      ...waitlisted,
      state: "confirmed",
      coverageContribution: "confirmed",
      confirmationEvidenceRef: "provider-confirmation:camp-seat",
      provenance: provenance("camp-source-status", 3, {
        kind: "provider_receipt",
        authority: "provider_confirmed",
      }),
    };
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: confirmed,
      expectedRevision: 2,
    });
    expect(
      await service.evaluateOpportunity({
        principalEntityId: SELF_ENTITY_ID,
        opportunityRecordId: campOpportunity.recordId,
      }),
    ).toMatchObject({
      state: "complete",
      countsAsCoverage: true,
      effectDraft: null,
    });
    expect(
      await repository.listRevisionHistory(
        "opportunity",
        campOpportunity.recordId,
      ),
    ).toHaveLength(3);
  });

  it("G38 proposes multi-party renegotiation after non-use and never returns responsibility to the owner", async () => {
    const assignmentId = "responsibility-school-morning";
    await service.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      definition: responsibility(assignmentId, "routine:school-morning"),
      expectedRevision: 0,
    });
    await expect(
      service.recordResponsibilitySignal({
        actingEntityId: SELF_ENTITY_ID,
        signal: {
          signalKey: "dismissal-owner-hearsay",
          householdId,
          assignmentRecordId: assignmentId,
          assignmentRevision: 1,
          phase: "execution",
          ownerEntityId: partnerEntityId,
          signalKind: "dismissed",
          relatedTaskId: "scheduled-task:school-morning",
          provenance: provenance("owner-hearsay", 1),
        },
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
    });
    await service.recordResponsibilitySignal({
      actingEntityId: partnerEntityId,
      signal: {
        signalKey: "dismissal-authenticated-1",
        householdId,
        assignmentRecordId: assignmentId,
        assignmentRevision: 1,
        phase: "execution",
        ownerEntityId: partnerEntityId,
        signalKind: "dismissed",
        relatedTaskId: "scheduled-task:school-morning:1",
        provenance: provenance("partner-direct-response", 1),
      },
    });
    await service.recordResponsibilitySignal({
      actingEntityId: SELF_ENTITY_ID,
      signal: {
        signalKey: "dismissal-provider-2",
        householdId,
        assignmentRecordId: assignmentId,
        assignmentRevision: 1,
        phase: "execution",
        ownerEntityId: partnerEntityId,
        signalKind: "dismissed",
        relatedTaskId: "scheduled-task:school-morning:2",
        provenance: provenance("provider-dismissal", 1, {
          kind: "provider_receipt",
          authority: "provider_confirmed",
        }),
      },
    });
    await expect(
      service.recordResponsibilitySignal({
        actingEntityId: childEntityId,
        signal: {
          signalKey: "child-impersonates-partner",
          householdId,
          assignmentRecordId: assignmentId,
          assignmentRevision: 1,
          phase: "execution",
          ownerEntityId: partnerEntityId,
          signalKind: "dismissed",
          relatedTaskId: null,
          provenance: provenance("child-impersonation", 1),
        },
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
    });

    const proposal = await service.assessResponsibility({
      principalEntityId: SELF_ENTITY_ID,
      assignmentRecordId: assignmentId,
    });
    expect(proposal).toMatchObject({
      trigger: "repeated_dismissal",
      replayed: false,
      currentOwners: {
        executionOwnerId: partnerEntityId,
        monitoringOwnerId: partnerEntityId,
      },
      ownerChanges: [],
      state: "proposed",
      proposedMode: "private_renegotiation",
    });
    expect(proposal?.requiredApproverEntityIds).toEqual(
      expect.arrayContaining([SELF_ENTITY_ID, partnerEntityId]),
    );
    const replay = await service.assessResponsibility({
      principalEntityId: SELF_ENTITY_ID,
      assignmentRecordId: assignmentId,
    });
    expect(replay?.reviewId).toBe(proposal?.reviewId);
    expect(replay?.replayed).toBe(true);
    const assignment = await repository.getCurrentRevision(
      "responsibility_assignment",
      assignmentId,
    );
    expect(assignment).toMatchObject({
      owners: {
        executionOwnerId: partnerEntityId,
        monitoringOwnerId: partnerEntityId,
      },
    });

    await service.recordResponsibilitySignal({
      actingEntityId: SELF_ENTITY_ID,
      signal: {
        signalKey: "completion-provider-receipt",
        householdId,
        assignmentRecordId: assignmentId,
        assignmentRevision: 1,
        phase: "execution",
        ownerEntityId: partnerEntityId,
        signalKind: "completed",
        relatedTaskId: "scheduled-task:school-morning:2",
        provenance: provenance("provider-completion", 1, {
          kind: "provider_receipt",
          authority: "provider_confirmed",
        }),
      },
    });
    expect(
      await service.assessResponsibility({
        principalEntityId: SELF_ENTITY_ID,
        assignmentRecordId: assignmentId,
      }),
    ).toBeNull();
    const resolvedBrief = await service.generateWeeklyBrief({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      window: {
        startsAt: "2027-03-01T00:00:00.000Z",
        endsAt: "2027-04-02T00:00:00.000Z",
      },
      calendarChecks: [],
    });
    expect(
      resolvedBrief.items.some(
        (item) =>
          item.kind === "responsibility_review" &&
          item.subjectKey === "routine:school-morning",
      ),
    ).toBe(false);
  });

  it("builds a maximum-three-question brief and redacts owner-private maintenance from child and unrelated views", async () => {
    nowMs = Date.parse("2027-03-10T12:00:00.000Z");
    const brief = await service.generateWeeklyBrief({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      window: {
        startsAt: "2027-03-01T00:00:00.000Z",
        endsAt: "2027-04-02T00:00:00.000Z",
      },
      calendarChecks: [],
    });
    expect(brief.questions.length).toBeLessThanOrEqual(3);
    expect(
      brief.items.some(
        (item) =>
          item.kind === "maintenance_due" &&
          item.subjectKey === maintenanceSubjectKey,
      ),
    ).toBe(true);
    expect(brief.items.some((item) => item.kind === "item_replacement")).toBe(
      true,
    );

    const childView = await service.readWeeklyBrief({
      principalEntityId: childEntityId,
      briefId: brief.briefId,
    });
    expect(
      childView.items.some((item) => item.subjectKey === maintenanceSubjectKey),
    ).toBe(false);
    expect(
      childView.items.some((item) => item.kind === "item_replacement"),
    ).toBe(true);
    await expect(
      service.readWeeklyBrief({
        principalEntityId: outsiderEntityId,
        briefId: brief.briefId,
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
    });
  });
});
