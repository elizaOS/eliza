/**
 * Real-PGlite coverage for resource revisions, structural conflict solving,
 * authorization, idempotent proposal reviews, shared ScheduledTasks, restart,
 * and concurrent writers.
 */
import { randomUUID } from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import {
  type AgentRuntime,
  createMessageMemory,
  type Memory,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalQueue } from "../approval-queue.types.js";
import {
  authenticatedHouseholdInboundIdentity,
  parseHouseholdInboundApprovalCommand,
  processHouseholdInboundApproval,
} from "../household/inbound-approval.js";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
  type HouseholdCoordinationService,
} from "../household/service.js";
import { getScheduledTaskRunner } from "../scheduled-task/service.js";
import { executeRawSql } from "../sql.js";
import { createResourceCapacityAction } from "./action.js";
import { ResourceCapacityRepository } from "./repository.js";
import { ResourceCapacityService } from "./service.js";
import {
  type CapacityNeed,
  type CaregiverResourceDefinition,
  type CarSeatResourceDefinition,
  type HouseholdResourceDefinition,
  RESOURCE_CAPACITY_POLICY_VERSION,
  type ResourceCapacityAssignment,
  type ResourceCapacityEvaluationInput,
  type ResourceCapacityPlan,
  type ResourceTransitionEvidence,
  type VehicleResourceDefinition,
} from "./types.js";

describe("household resource capacity — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let entities: EntityStore;
  let household: HouseholdCoordinationService;
  let approvals: ApprovalQueue;
  let repository: ResourceCapacityRepository;
  let service: ResourceCapacityService;

  let now = new Date("2027-03-10T12:00:00.000Z");
  const childOneId = "capacity-child-one";
  const childTwoId = "capacity-child-two";
  const caregiverId = "capacity-caregiver";
  const partnerId = "capacity-partner";
  const partnerHandle = "capacity-partner-telegram";
  const outsiderId = "capacity-outsider";

  function currentDate(): Date {
    return new Date(now);
  }

  async function upsertPerson(
    entityId: string,
    preferredName: string,
    verifiedTelegramHandle?: string,
  ): Promise<void> {
    await entities.upsert({
      entityId,
      type: "person",
      preferredName,
      identities: verifiedTelegramHandle
        ? [
            {
              platform: "telegram",
              handle: verifiedTelegramHandle,
              verified: true,
              confidence: 1,
              addedAt: now.toISOString(),
              addedVia: "import",
              evidence: ["owner-verified connector identity"],
            },
          ]
        : [],
      tags: ["resource-capacity-integration"],
      visibility: "owner_only",
      state: {},
    });
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
    await upsertPerson(childOneId, "Capacity Child One");
    await upsertPerson(childTwoId, "Capacity Child Two");
    await upsertPerson(caregiverId, "Capacity Caregiver");
    await upsertPerson(partnerId, "Capacity Partner", partnerHandle);
    await upsertPerson(outsiderId, "Capacity Outsider");

    household =
      getHouseholdCoordinationService(runtime) ??
      createHouseholdCoordinationService(runtime);
    await household.bindRole({
      entityId: childOneId,
      role: "child",
      subjectEntityIds: [childOneId],
      evidence: "Owner identified child one.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: childTwoId,
      role: "child",
      subjectEntityIds: [childTwoId],
      evidence: "Owner identified child two.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childOneId, childTwoId],
      evidence: "Owner identified the caregiver.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [childOneId, childTwoId],
      evidence: "Owner identified the current partner.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.issueGrant({
      principalEntityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [childOneId, childTwoId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-01T00:00:00.000Z",
    });

    approvals = createApprovalQueue(runtime, { agentId: runtime.agentId });
    repository = new ResourceCapacityRepository(runtime, runtime.agentId);
    service = new ResourceCapacityService({
      runtime,
      agentId: runtime.agentId,
      entityStore: entities,
      household,
      repository,
      approvalQueue: approvals,
      scheduledTasks: getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
      }),
      now: currentDate,
    });
    await service.initialize();
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function authorization(
    overrides?: Partial<HouseholdResourceDefinition["authorization"]>,
  ): HouseholdResourceDefinition["authorization"] {
    return {
      state: "authorized",
      validFrom: "2027-03-01T00:00:00.000Z",
      expiresAt: "2027-04-01T00:00:00.000Z",
      revokedAt: null,
      authorizedByEntityIds: [SELF_ENTITY_ID],
      evidenceRefs: ["owner-confirmation:resource-capacity"],
      ...overrides,
    };
  }

  function availability(
    resourceId: string,
    overrides?: Partial<HouseholdResourceDefinition["availability"][number]>,
  ): HouseholdResourceDefinition["availability"] {
    return [
      {
        windowId: `availability-${resourceId}`,
        state: "available",
        startsAt: "2027-03-10T00:00:00.000Z",
        endsAt: "2027-03-20T00:00:00.000Z",
        sourceRef: `calendar-freebusy:${resourceId}:v1`,
        observedAt: "2027-03-10T11:00:00.000Z",
        expiresAt: "2027-03-11T12:00:00.000Z",
        ...overrides,
      },
    ];
  }

  function caregiverResource(
    householdId: string,
    resourceId: string,
    overrides?: Partial<CaregiverResourceDefinition>,
  ): CaregiverResourceDefinition {
    return {
      schemaVersion: RESOURCE_CAPACITY_POLICY_VERSION,
      resourceId,
      householdId,
      kind: "caregiver",
      label: "Caregiver",
      active: true,
      capabilityIds: ["school-pickup"],
      authorization: authorization(),
      availability: availability(resourceId),
      caregiverEntityId: caregiverId,
      authorizedChildEntityIds: [childOneId, childTwoId],
      maximumConcurrentChildren: 2,
      trainingCapabilityIds: ["mobility-transfer-trained"],
      ...overrides,
    };
  }

  function vehicleResource(
    householdId: string,
    resourceId: string,
    carSeatResourceId: string,
    overrides?: Partial<VehicleResourceDefinition>,
  ): VehicleResourceDefinition {
    return {
      schemaVersion: RESOURCE_CAPACITY_POLICY_VERSION,
      resourceId,
      householdId,
      kind: "vehicle",
      label: "Family vehicle",
      active: true,
      capabilityIds: ["transport"],
      authorization: authorization(),
      availability: availability(resourceId),
      assetRef: `asset:${resourceId}`,
      passengerCapacity: 4,
      authorizedOperatorEntityIds: [caregiverId],
      supportedCarSeatResourceIds: [carSeatResourceId],
      accessibilityCapabilityIds: ["wheelchair-transfer"],
      ...overrides,
    };
  }

  function carSeatResource(
    householdId: string,
    resourceId: string,
    vehicleResourceId: string,
    overrides?: Partial<CarSeatResourceDefinition>,
  ): CarSeatResourceDefinition {
    return {
      schemaVersion: RESOURCE_CAPACITY_POLICY_VERSION,
      resourceId,
      householdId,
      kind: "car_seat",
      label: "Child restraint",
      active: true,
      capabilityIds: ["child-restraint"],
      authorization: authorization(),
      availability: availability(resourceId),
      seatClass: "high_back_booster",
      compatibleChildEntityIds: [childOneId],
      compatibleVehicleResourceIds: [vehicleResourceId],
      installationState: "confirmed",
      installationEvidenceRef: `installation:${resourceId}:v1`,
      installationObservedAt: "2027-03-10T11:00:00.000Z",
      installationExpiresAt: "2027-03-11T12:00:00.000Z",
      ...overrides,
    };
  }

  async function seedResourceSet(
    householdId: string,
    suffix: string,
  ): Promise<{
    caregiverResourceId: string;
    vehicleResourceId: string;
    carSeatResourceId: string;
  }> {
    const caregiverResourceId = `caregiver-${suffix}`;
    const vehicleResourceId = `vehicle-${suffix}`;
    const carSeatResourceId = `car-seat-${suffix}`;
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: caregiverResource(householdId, caregiverResourceId),
      expectedRevision: 0,
    });
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: vehicleResource(
        householdId,
        vehicleResourceId,
        carSeatResourceId,
      ),
      expectedRevision: 0,
    });
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: carSeatResource(
        householdId,
        carSeatResourceId,
        vehicleResourceId,
      ),
      expectedRevision: 0,
    });
    return {
      caregiverResourceId,
      vehicleResourceId,
      carSeatResourceId,
    };
  }

  function need(input: {
    needId: string;
    startsAt: string;
    endsAt: string;
    location: string;
    caregiverPrincipal?: string;
    accessibility?: readonly string[];
  }): CapacityNeed {
    return {
      needId: input.needId,
      title: input.needId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      preparationMinutes: 0,
      recoveryMinutes: 0,
      originLocationRef: input.location,
      destinationLocationRef: input.location,
      childEntityIds: [childOneId],
      requirements: {
        caregiverCount: 1,
        caregiverCapabilityIds: ["school-pickup"],
        vehicleRequired: true,
        passengerCount: 1,
        carSeats: [
          {
            childEntityId: childOneId,
            seatClass: "high_back_booster",
          },
        ],
        accessibilityCapabilityIds: [...(input.accessibility ?? [])],
      },
      handoffs: [
        {
          handoffId: `${input.needId}-pickup`,
          kind: "pickup",
          startsAt: new Date(
            Date.parse(input.startsAt) - 5 * 60 * 1000,
          ).toISOString(),
          endsAt: new Date(
            Date.parse(input.startsAt) + 5 * 60 * 1000,
          ).toISOString(),
          locationRef: input.location,
          requiredPrincipalEntityIds: [input.caregiverPrincipal ?? caregiverId],
        },
        {
          handoffId: `${input.needId}-dropoff`,
          kind: "dropoff",
          startsAt: new Date(
            Date.parse(input.endsAt) - 5 * 60 * 1000,
          ).toISOString(),
          endsAt: new Date(
            Date.parse(input.endsAt) + 5 * 60 * 1000,
          ).toISOString(),
          locationRef: input.location,
          requiredPrincipalEntityIds: [input.caregiverPrincipal ?? caregiverId],
        },
      ],
      sourceRefs: [`calendar-event:${input.needId}:v1`],
    };
  }

  function assignments(
    needs: readonly CapacityNeed[],
    resources: {
      caregiverResourceId: string;
      vehicleResourceId: string;
      carSeatResourceId: string;
    },
  ): ResourceCapacityAssignment[] {
    return needs.flatMap((capacityNeed) => [
      {
        needId: capacityNeed.needId,
        resourceId: resources.caregiverResourceId,
        role: "caregiver_primary" as const,
      },
      {
        needId: capacityNeed.needId,
        resourceId: resources.vehicleResourceId,
        role: "vehicle" as const,
      },
      {
        needId: capacityNeed.needId,
        resourceId: resources.carSeatResourceId,
        role: "car_seat" as const,
      },
    ]);
  }

  function plan(
    householdId: string,
    needs: readonly CapacityNeed[],
  ): ResourceCapacityPlan {
    return {
      householdId,
      title: `Capacity plan ${householdId}`,
      childEntityIds: [childOneId],
      needs: [...needs],
    };
  }

  function transitions(
    resources: {
      caregiverResourceId: string;
      vehicleResourceId: string;
      carSeatResourceId: string;
    },
    fromNeedId: string,
    toNeedId: string,
    minimumMinutes: number,
  ): ResourceTransitionEvidence[] {
    return Object.values(resources).map((resourceId) => ({
      resourceId,
      fromNeedId,
      toNeedId,
      minimumMinutes,
      sourceRef: `route-matrix:${fromNeedId}:${toNeedId}:v1`,
      observedAt: "2027-03-10T11:30:00.000Z",
      expiresAt: "2027-03-10T18:00:00.000Z",
    }));
  }

  function evaluationInput(
    householdId: string,
    needs: readonly CapacityNeed[],
    resources: {
      caregiverResourceId: string;
      vehicleResourceId: string;
      carSeatResourceId: string;
    },
    transitionEvidence: readonly ResourceTransitionEvidence[] = [],
  ): ResourceCapacityEvaluationInput {
    return {
      plan: plan(householdId, needs),
      assignments: assignments(needs, resources),
      transitions: [...transitionEvidence],
      maximumSourceAgeMinutes: 24 * 60,
    };
  }

  function partnerApprovalMessage(approvalRequestId: string): Memory {
    const message = createMessageMemory({
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: `approve household approval ${approvalRequestId}: reviewed exact resource plan`,
        source: "telegram",
      },
    });
    message.createdAt = now.getTime();
    message.metadata = {
      type: "message",
      provider: "telegram",
      chatType: "dm",
      accountId: "capacity-owner-bot",
      telegram: {
        userId: partnerHandle,
        id: partnerHandle,
        chatId: `chat-${partnerHandle}`,
        messageId: `capacity-message-${randomUUID()}`,
      },
    };
    return message;
  }

  it("persists append-only resource revisions and rejects concurrent stale writers", async () => {
    const householdId = "capacity-household-cas";
    const resourceId = "caregiver-capacity-cas";
    const first = await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: caregiverResource(householdId, resourceId),
      expectedRevision: 0,
    });
    expect(first).toMatchObject({ resourceId, revision: 1 });

    const results = await Promise.allSettled([
      service.putResource({
        principalEntityId: SELF_ENTITY_ID,
        definition: caregiverResource(householdId, resourceId, {
          label: "Caregiver updated by writer A",
        }),
        expectedRevision: 1,
      }),
      service.putResource({
        principalEntityId: SELF_ENTITY_ID,
        definition: caregiverResource(householdId, resourceId, {
          label: "Caregiver updated by writer B",
        }),
        expectedRevision: 1,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "RESOURCE_CAPACITY_CONFLICT",
      }),
    });

    const restarted = new ResourceCapacityRepository(runtime, runtime.agentId);
    await restarted.ensureSchema();
    expect(await restarted.getCurrentResource(resourceId)).toMatchObject({
      resourceId,
      revision: 2,
    });
    const revisionRows = await executeRawSql(
      runtime,
      `SELECT revision
       FROM app_lifeops.life_resource_capacity_revisions
       WHERE agent_id = '${runtime.agentId}'
         AND resource_id = '${resourceId}'
       ORDER BY revision`,
    );
    expect(revisionRows.map((row) => Number(row.revision))).toEqual([1, 2]);
  });

  it("rejects floating local timestamps before resource evidence is persisted", async () => {
    const householdId = "capacity-household-absolute-time";
    const resourceId = "caregiver-floating-time";
    const [window] = availability(resourceId);
    expect(window).toBeDefined();
    await expect(
      service.putResource({
        principalEntityId: SELF_ENTITY_ID,
        definition: caregiverResource(householdId, resourceId, {
          availability: [
            {
              ...window,
              startsAt: "2027-03-10T00:00:00",
            },
          ],
        }),
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_CAPACITY_INVALID_CONTRACT",
    });
    expect(await repository.getCurrentResource(resourceId)).toBeNull();
  });

  it("detects one caregiver, vehicle, and car-seat conflict across non-overlapping adult events", async () => {
    const householdId = "capacity-household-g48";
    const resources = await seedResourceSet(householdId, "g48");
    const first = need({
      needId: "school-pickup",
      startsAt: "2027-03-10T15:00:00.000Z",
      endsAt: "2027-03-10T16:00:00.000Z",
      location: "place:school",
    });
    const second = need({
      needId: "therapy-visit",
      startsAt: "2027-03-10T16:10:00.000Z",
      endsAt: "2027-03-10T17:00:00.000Z",
      location: "place:clinic",
    });
    const result = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(
        householdId,
        [first, second],
        resources,
        transitions(resources, first.needId, second.needId, 25),
      ),
    });
    expect(result.feasible).toBe(false);
    expect(
      result.conflicts.filter(
        (conflict) => conflict.kind === "transition_time_insufficient",
      ),
    ).toHaveLength(3);
    expect(
      result.conflicts.some((conflict) => conflict.kind === "direct_overlap"),
    ).toBe(false);
    expect(
      new Set(result.conflicts.flatMap((conflict) => conflict.resourceIds)),
    ).toEqual(
      new Set([
        resources.caregiverResourceId,
        resources.vehicleResourceId,
        resources.carSeatResourceId,
      ]),
    );
    expect(result.noReservationCreated).toBe(true);
  });

  it("accepts exact handoffs, authorization, restraint compatibility, accessibility, and sourced transitions", async () => {
    const householdId = "capacity-household-feasible";
    const resources = await seedResourceSet(householdId, "feasible");
    const first = need({
      needId: "accessible-school-pickup",
      startsAt: "2027-03-10T14:00:00.000Z",
      endsAt: "2027-03-10T15:00:00.000Z",
      location: "place:school",
      accessibility: ["wheelchair-transfer", "mobility-transfer-trained"],
    });
    const second = need({
      needId: "accessible-clinic",
      startsAt: "2027-03-10T16:00:00.000Z",
      endsAt: "2027-03-10T17:00:00.000Z",
      location: "place:clinic",
      accessibility: ["wheelchair-transfer", "mobility-transfer-trained"],
    });
    const result = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(
        householdId,
        [first, second],
        resources,
        transitions(resources, first.needId, second.needId, 25),
      ),
    });
    expect(result).toMatchObject({
      feasible: true,
      conflicts: [],
      noReservationCreated: true,
    });
    expect(result.resourceSnapshots).toHaveLength(3);
  });

  it("finds a feasible distinct-restraint matching instead of depending on child order", async () => {
    const householdId = "capacity-household-restraint-matching";
    const caregiverResourceId = "caregiver-restraint-matching";
    const vehicleResourceId = "vehicle-restraint-matching";
    const flexibleSeatId = "seat-flexible";
    const childSpecificSeatId = "seat-child-one";
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: caregiverResource(householdId, caregiverResourceId),
      expectedRevision: 0,
    });
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: vehicleResource(
        householdId,
        vehicleResourceId,
        flexibleSeatId,
        {
          supportedCarSeatResourceIds: [flexibleSeatId, childSpecificSeatId],
        },
      ),
      expectedRevision: 0,
    });
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: carSeatResource(
        householdId,
        flexibleSeatId,
        vehicleResourceId,
        {
          compatibleChildEntityIds: [childOneId, childTwoId],
        },
      ),
      expectedRevision: 0,
    });
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: carSeatResource(
        householdId,
        childSpecificSeatId,
        vehicleResourceId,
        {
          compatibleChildEntityIds: [childOneId],
        },
      ),
      expectedRevision: 0,
    });
    const twoChildNeed: CapacityNeed = {
      ...need({
        needId: "restraint-matching-school-run",
        startsAt: "2027-03-10T15:00:00.000Z",
        endsAt: "2027-03-10T16:00:00.000Z",
        location: "place:school",
      }),
      childEntityIds: [childOneId, childTwoId],
      requirements: {
        caregiverCount: 1,
        caregiverCapabilityIds: ["school-pickup"],
        vehicleRequired: true,
        passengerCount: 2,
        carSeats: [
          { childEntityId: childOneId, seatClass: "high_back_booster" },
          { childEntityId: childTwoId, seatClass: "high_back_booster" },
        ],
        accessibilityCapabilityIds: [],
      },
    };
    const result = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: {
        plan: {
          householdId,
          title: "Order-independent restraint matching",
          childEntityIds: [childOneId, childTwoId],
          needs: [twoChildNeed],
        },
        assignments: [
          {
            needId: twoChildNeed.needId,
            resourceId: caregiverResourceId,
            role: "caregiver_primary",
          },
          {
            needId: twoChildNeed.needId,
            resourceId: vehicleResourceId,
            role: "vehicle",
          },
          {
            needId: twoChildNeed.needId,
            resourceId: flexibleSeatId,
            role: "car_seat",
          },
          {
            needId: twoChildNeed.needId,
            resourceId: childSpecificSeatId,
            role: "car_seat",
          },
        ],
        transitions: [],
        maximumSourceAgeMinutes: 24 * 60,
      },
    });
    expect(result).toMatchObject({
      feasible: true,
      conflicts: [],
      noReservationCreated: true,
    });
    expect(result.resourceSnapshots).toHaveLength(4);
  });

  it("drives the production owner action service through the real database without an external effect", async () => {
    const householdId = "capacity-household-action";
    const resourceId = "caregiver-production-action";
    const action = createResourceCapacityAction({
      authorize: async () => true,
    });
    const result = await action.handler(
      runtime,
      createMessageMemory({
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: {
          text: "Check the school run resources.",
          source: "test",
        },
      }),
      undefined,
      {
        parameters: {
          action: "put_resource",
          subaction: "put_resource",
          resource: caregiverResource(householdId, resourceId),
          expectedRevision: 0,
        },
      },
      undefined,
    );
    expect(result).toMatchObject({
      success: true,
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_resource.put_revision",
          resource: {
            kind: "lifeops.household_resource",
            id: resourceId,
            version: "1",
          },
          commit: {
            kind: "durable",
          },
        },
      ],
      data: {
        revision: {
          resourceId,
          householdId,
          kind: "caregiver",
          revision: 1,
        },
      },
    });
    expect(await repository.getCurrentResource(resourceId)).toMatchObject({
      resourceId,
      revision: 1,
    });
  });

  it("fails closed for outsider access, self-granting caregivers, stale evidence, and incompatible constraints", async () => {
    const householdId = "capacity-household-adversarial";
    const resources = await seedResourceSet(householdId, "adversarial");
    const capacityNeed = need({
      needId: "adversarial-need",
      startsAt: "2027-03-10T15:00:00.000Z",
      endsAt: "2027-03-10T16:00:00.000Z",
      location: "place:school",
      caregiverPrincipal: outsiderId,
      accessibility: ["lift-equipped"],
    });
    await expect(
      service.evaluate({
        principalEntityId: outsiderId,
        evaluation: evaluationInput(householdId, [capacityNeed], resources),
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    await expect(
      service.putResource({
        principalEntityId: caregiverId,
        definition: caregiverResource(
          householdId,
          "caregiver-self-grant-attempt",
        ),
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_CAPACITY_ACCESS_DENIED",
    });

    const staleVehicleId = "vehicle-adversarial-stale";
    const staleSeatId = "seat-adversarial-stale";
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: vehicleResource(householdId, staleVehicleId, staleSeatId, {
        availability: availability(staleVehicleId, {
          observedAt: "2027-01-01T00:00:00.000Z",
          expiresAt: "2027-01-02T00:00:00.000Z",
        }),
      }),
      expectedRevision: 0,
    });
    const adversarialAssignments = assignments([capacityNeed], {
      ...resources,
      vehicleResourceId: staleVehicleId,
      carSeatResourceId: "missing-car-seat",
    });
    adversarialAssignments.push(adversarialAssignments[0]);
    const result = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: {
        plan: plan(householdId, [capacityNeed]),
        assignments: adversarialAssignments,
        transitions: [],
        maximumSourceAgeMinutes: 60,
      },
    });
    expect(result.conflicts.map((conflict) => conflict.kind)).toEqual(
      expect.arrayContaining([
        "source_stale",
        "availability_unknown",
        "resource_not_found",
        "car_seat_missing",
        "accessibility_capability_missing",
        "handoff_principal_missing",
        "duplicate_assignment",
      ]),
    );
  });

  it("does not reuse one driver or restraint and rejects contradictory transition evidence", async () => {
    const householdId = "capacity-household-distinct-resources";
    const resources = await seedResourceSet(householdId, "distinct-resources");
    const secondVehicleResourceId = "vehicle-distinct-resources-two";
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: vehicleResource(
        householdId,
        secondVehicleResourceId,
        resources.carSeatResourceId,
      ),
      expectedRevision: 0,
    });
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: carSeatResource(
        householdId,
        resources.carSeatResourceId,
        resources.vehicleResourceId,
        {
          compatibleChildEntityIds: [childOneId, childTwoId],
          compatibleVehicleResourceIds: [
            resources.vehicleResourceId,
            secondVehicleResourceId,
          ],
        },
      ),
      expectedRevision: 1,
    });
    const twoChildNeed: CapacityNeed = {
      ...need({
        needId: "two-child-school-run",
        startsAt: "2027-03-10T15:00:00.000Z",
        endsAt: "2027-03-10T16:00:00.000Z",
        location: "place:school",
      }),
      childEntityIds: [childOneId, childTwoId],
      requirements: {
        caregiverCount: 1,
        caregiverCapabilityIds: ["school-pickup"],
        vehicleRequired: true,
        passengerCount: 2,
        carSeats: [
          { childEntityId: childOneId, seatClass: "high_back_booster" },
          { childEntityId: childTwoId, seatClass: "high_back_booster" },
        ],
        accessibilityCapabilityIds: [],
      },
    };
    const distinctResult = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: {
        plan: {
          householdId,
          title: "Distinct physical resource matching",
          childEntityIds: [childOneId, childTwoId],
          needs: [twoChildNeed],
        },
        assignments: [
          ...assignments([twoChildNeed], resources),
          {
            needId: twoChildNeed.needId,
            resourceId: resources.caregiverResourceId,
            role: "caregiver_backup",
          },
          {
            needId: twoChildNeed.needId,
            resourceId: secondVehicleResourceId,
            role: "vehicle",
          },
        ],
        transitions: [],
        maximumSourceAgeMinutes: 24 * 60,
      },
    });
    expect(distinctResult.conflicts.map((conflict) => conflict.kind)).toEqual(
      expect.arrayContaining([
        "duplicate_assignment",
        "vehicle_operator_unauthorized",
        "car_seat_incompatible",
      ]),
    );

    const first = need({
      needId: "conflicting-route-one",
      startsAt: "2027-03-10T14:00:00.000Z",
      endsAt: "2027-03-10T15:00:00.000Z",
      location: "place:school",
    });
    const second = need({
      needId: "conflicting-route-two",
      startsAt: "2027-03-10T16:00:00.000Z",
      endsAt: "2027-03-10T17:00:00.000Z",
      location: "place:clinic",
    });
    const contradictory = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [first, second], resources, [
        ...transitions(resources, first.needId, second.needId, 20),
        ...transitions(resources, first.needId, second.needId, 35).map(
          (transition) => ({
            ...transition,
            sourceRef: `${transition.sourceRef}:conflicting`,
          }),
        ),
      ]),
    });
    expect(
      contradictory.conflicts.filter(
        (conflict) => conflict.kind === "contradictory_transition_evidence",
      ),
    ).toHaveLength(3);
  });

  it("requires fresh restraint-installation evidence", async () => {
    const householdId = "capacity-household-stale-installation";
    const resources = await seedResourceSet(householdId, "stale-installation");
    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: carSeatResource(
        householdId,
        resources.carSeatResourceId,
        resources.vehicleResourceId,
        {
          installationObservedAt: "2027-03-01T00:00:00.000Z",
          installationExpiresAt: "2027-04-01T00:00:00.000Z",
        },
      ),
      expectedRevision: 1,
    });
    const capacityNeed = need({
      needId: "stale-installation-school-run",
      startsAt: "2027-03-10T15:00:00.000Z",
      endsAt: "2027-03-10T16:00:00.000Z",
      location: "place:school",
    });
    const result = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: {
        ...evaluationInput(householdId, [capacityNeed], resources),
        maximumSourceAgeMinutes: 60,
      },
    });
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "source_stale",
          resourceIds: [resources.carSeatResourceId],
          sourceRefs: [`installation:${resources.carSeatResourceId}:v1`],
        }),
      ]),
    );
  });

  it("creates one immutable review proposal, shared approvals, and one shared ScheduledTask under concurrent retry", async () => {
    const householdId = "capacity-household-proposal";
    const resources = await seedResourceSet(householdId, "proposal");
    const capacityNeed = need({
      needId: "proposal-school-run",
      startsAt: "2027-03-12T15:00:00.000Z",
      endsAt: "2027-03-12T16:00:00.000Z",
      location: "place:school",
    });
    const input = {
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [capacityNeed], resources),
      requiredApproverEntityIds: [SELF_ENTITY_ID, partnerId],
      idempotencyKey: "capacity-proposal-concurrent-v1",
      expiresAt: "2027-03-12T12:00:00.000Z",
    } as const;
    const [first, second] = await Promise.all([
      service.createProposal(input),
      service.createProposal(input),
    ]);
    expect(first.proposal.proposalId).toBe(second.proposal.proposalId);
    expect(first).toMatchObject({
      effectiveState: "pending_review",
      noReservationCreated: true,
      noCalendarMutationCreated: true,
      noMessageSent: true,
    });
    expect(first.approvals).toHaveLength(2);
    expect(first.reviewTaskId).toBeTruthy();

    const proposalRows = await executeRawSql(
      runtime,
      `SELECT proposal_id, status
       FROM app_lifeops.life_resource_capacity_proposals
       WHERE agent_id = '${runtime.agentId}'
         AND idempotency_key = 'capacity-proposal-concurrent-v1'`,
    );
    expect(proposalRows).toHaveLength(1);
    const approvalRows = await executeRawSql(
      runtime,
      `SELECT party_entity_id, approval_request_id
       FROM app_lifeops.life_resource_capacity_approvals
       WHERE agent_id = '${runtime.agentId}'
         AND proposal_id = '${first.proposal.proposalId}'
       ORDER BY party_entity_id`,
    );
    expect(approvalRows).toHaveLength(2);
    const taskRows = await executeRawSql(
      runtime,
      `SELECT scheduled_task_id
       FROM app_lifeops.life_resource_capacity_tasks
       WHERE agent_id = '${runtime.agentId}'
         AND proposal_id = '${first.proposal.proposalId}'`,
    );
    expect(taskRows).toHaveLength(1);
    const tasks = await getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    }).list();
    const task = tasks.find(
      (candidate) => candidate.taskId === first.reviewTaskId,
    );
    expect(task).toMatchObject({
      kind: "watcher",
      trigger: { kind: "once", atIso: input.expiresAt },
      metadata: {
        proposalId: first.proposal.proposalId,
        contentSha256: first.proposal.contentSha256,
        noReservation: true,
        noCalendarMutation: true,
        noExternalSend: true,
      },
    });
    for (const approval of first.approvals) {
      const request = await approvals.byId(approval.approvalRequestId);
      expect(request).toMatchObject({
        action: "execute_workflow",
        subjectUserId: approval.partyEntityId,
        payload: {
          action: "execute_workflow",
          workflowId: "household.resource-capacity.proposal.review",
          input: {
            proposalId: first.proposal.proposalId,
            proposalVersion: 1,
            partyEntityId: approval.partyEntityId,
            contentSha256: first.proposal.contentSha256,
            noExternalEffect: true,
          },
        },
      });
    }

    const competingNeed = need({
      needId: "competing-school-run",
      startsAt: "2027-03-12T15:30:00.000Z",
      endsAt: "2027-03-12T16:30:00.000Z",
      location: "place:school",
    });
    const blocked = await service.createProposal({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [competingNeed], resources),
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      idempotencyKey: "test-key-2",
      expiresAt: "2027-03-12T12:00:00.000Z",
    });
    expect(blocked.effectiveState).toBe("blocked");
    expect(
      blocked.proposal.evaluation.conflicts.some(
        (conflict) => conflict.kind === "pending_proposal_reservation",
      ),
    ).toBe(true);
    expect(blocked.approvals).toEqual([]);
    expect(blocked.reviewTaskId).toBeNull();

    await expect(
      service.createProposal({
        ...input,
        evaluation: evaluationInput(
          householdId,
          [
            {
              ...capacityNeed,
              endsAt: "2027-03-12T16:30:00.000Z",
            },
          ],
          resources,
        ),
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_CAPACITY_CONFLICT" });
  });

  it("invalidates review after resource drift and stops treating it as a pending reservation", async () => {
    const householdId = "capacity-household-invalidated-review";
    const resources = await seedResourceSet(householdId, "invalidated-review");
    const capacityNeed = need({
      needId: "invalidated-school-run",
      startsAt: "2027-03-18T15:00:00.000Z",
      endsAt: "2027-03-18T16:00:00.000Z",
      location: "place:school",
    });
    const proposal = await service.createProposal({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [capacityNeed], resources),
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      idempotencyKey: "capacity-invalidated-review-v1",
      expiresAt: "2027-03-18T12:00:00.000Z",
    });
    const ownerApproval = proposal.approvals[0];
    if (!ownerApproval) throw new Error("owner review approval missing");

    await service.putResource({
      principalEntityId: SELF_ENTITY_ID,
      definition: caregiverResource(
        householdId,
        resources.caregiverResourceId,
        { label: "Caregiver with revised capacity evidence" },
      ),
      expectedRevision: 1,
    });
    const invalidated = await service.readProposal({
      principalEntityId: SELF_ENTITY_ID,
      proposalId: proposal.proposal.proposalId,
    });
    expect(invalidated).toMatchObject({
      effectiveState: "invalidated",
      invalidatedResourceIds: [resources.caregiverResourceId],
      noReservationCreated: true,
    });
    await expect(
      service.respondToProposal({
        principalEntityId: SELF_ENTITY_ID,
        proposalId: proposal.proposal.proposalId,
        proposalVersion: 1,
        partyEntityId: SELF_ENTITY_ID,
        approvalRequestId: ownerApproval.approvalRequestId,
        contentSha256: proposal.proposal.contentSha256,
        decision: "approve",
        reason: "This should be re-evaluated first.",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_CAPACITY_CONFLICT" });

    const replacement = await service.evaluate({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [capacityNeed], resources),
    });
    expect(replacement.feasible).toBe(true);
    expect(
      replacement.conflicts.some(
        (conflict) => conflict.kind === "pending_proposal_reservation",
      ),
    ).toBe(false);
  });

  it("invalidates review when source evidence ages out and releases the proposal-only conflict", async () => {
    const householdId = "capacity-household-stale-review";
    const resources = await seedResourceSet(householdId, "stale-review");
    const capacityNeed = need({
      needId: "stale-review-school-run",
      startsAt: "2027-03-12T15:00:00.000Z",
      endsAt: "2027-03-12T16:00:00.000Z",
      location: "place:school",
    });
    const proposal = await service.createProposal({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [capacityNeed], resources),
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      idempotencyKey: "capacity-stale-review-v1",
      expiresAt: "2027-03-12T12:00:00.000Z",
    });
    const ownerApproval = proposal.approvals[0];
    if (!ownerApproval) throw new Error("owner review approval missing");

    now = new Date("2027-03-11T12:01:00.000Z");
    try {
      const invalidated = await service.readProposal({
        principalEntityId: SELF_ENTITY_ID,
        proposalId: proposal.proposal.proposalId,
      });
      expect(invalidated).toMatchObject({
        effectiveState: "invalidated",
        invalidatedResourceIds: [],
        noReservationCreated: true,
      });
      expect(
        invalidated.invalidationConflicts.some(
          (conflict) => conflict.kind === "source_stale",
        ),
      ).toBe(true);
      await expect(
        service.respondToProposal({
          principalEntityId: SELF_ENTITY_ID,
          proposalId: proposal.proposal.proposalId,
          proposalVersion: 1,
          partyEntityId: SELF_ENTITY_ID,
          approvalRequestId: ownerApproval.approvalRequestId,
          contentSha256: proposal.proposal.contentSha256,
          decision: "approve",
          reason: "Attempted review after source expiry.",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_CAPACITY_CONFLICT" });

      const replacement = await service.evaluate({
        principalEntityId: SELF_ENTITY_ID,
        evaluation: evaluationInput(householdId, [capacityNeed], resources),
      });
      expect(
        replacement.conflicts.some(
          (conflict) => conflict.kind === "pending_proposal_reservation",
        ),
      ).toBe(false);
    } finally {
      now = new Date("2027-03-10T12:00:00.000Z");
    }
  });

  it("accepts an exact verified co-parent review through the shared replay-receipted inbound path", async () => {
    const householdId = "capacity-household-partner-inbound";
    const resources = await seedResourceSet(householdId, "partner-inbound");
    const capacityNeed = need({
      needId: "partner-reviewed-school-run",
      startsAt: "2027-03-19T15:00:00.000Z",
      endsAt: "2027-03-19T16:00:00.000Z",
      location: "place:school",
    });
    const proposal = await service.createProposal({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [capacityNeed], resources),
      requiredApproverEntityIds: [partnerId],
      idempotencyKey: "test-key-3",
      expiresAt: "2027-03-19T12:00:00.000Z",
    });
    const partnerApproval = proposal.approvals.find(
      (approval) => approval.partyEntityId === partnerId,
    );
    if (!partnerApproval) throw new Error("partner review approval missing");
    const message = partnerApprovalMessage(partnerApproval.approvalRequestId);
    const command = parseHouseholdInboundApprovalCommand(
      String(message.content.text),
    );
    const identity = authenticatedHouseholdInboundIdentity(message);
    if (!command || !identity) {
      throw new Error("partner inbound fixture is invalid");
    }

    const reviewed = await processHouseholdInboundApproval({
      runtime,
      message,
      command,
      identity,
      now: currentDate,
      resolveResourceCapacityService: () => service,
    });
    expect(reviewed).toMatchObject({
      status: "processed",
      receipt: {
        partyEntityId: partnerId,
        approvalRequestId: partnerApproval.approvalRequestId,
        proposalId: proposal.proposal.proposalId,
        proposalVersion: 1,
        decision: "approve",
        approvalState: "approved",
      },
    });
    const replayed = await processHouseholdInboundApproval({
      runtime,
      message,
      command,
      identity,
      now: currentDate,
      resolveResourceCapacityService: () => service,
    });
    expect(replayed.status).toBe("duplicate");
    expect(replayed.receipt.id).toBe(reviewed.receipt.id);
    expect(
      await approvals.byId(partnerApproval.approvalRequestId),
    ).toMatchObject({
      state: "approved",
      resolvedBy: partnerId,
    });
  });

  it("projects exact human review states without turning approval into execution", async () => {
    const householdId = "capacity-household-review";
    const resources = await seedResourceSet(householdId, "review");
    const capacityNeed = need({
      needId: "review-school-run",
      startsAt: "2027-03-14T15:00:00.000Z",
      endsAt: "2027-03-14T16:00:00.000Z",
      location: "place:school",
    });
    const proposal = await service.createProposal({
      principalEntityId: SELF_ENTITY_ID,
      evaluation: evaluationInput(householdId, [capacityNeed], resources),
      requiredApproverEntityIds: [SELF_ENTITY_ID, partnerId],
      idempotencyKey: "capacity-review-states-v1",
      expiresAt: "2027-03-14T12:00:00.000Z",
    });
    const ownerApproval = proposal.approvals.find(
      (approval) => approval.partyEntityId === SELF_ENTITY_ID,
    );
    if (!ownerApproval) throw new Error("owner review approval missing");
    await expect(
      service.respondToProposal({
        principalEntityId: SELF_ENTITY_ID,
        proposalId: proposal.proposal.proposalId,
        proposalVersion: 1,
        partyEntityId: SELF_ENTITY_ID,
        approvalRequestId: ownerApproval.approvalRequestId,
        contentSha256: "b".repeat(64),
        decision: "approve",
        reason: "Attempted altered review.",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_CAPACITY_CONFLICT" });
    for (const approval of proposal.approvals) {
      await service.respondToProposal({
        principalEntityId: approval.partyEntityId,
        proposalId: proposal.proposal.proposalId,
        proposalVersion: 1,
        partyEntityId: approval.partyEntityId,
        approvalRequestId: approval.approvalRequestId,
        contentSha256: proposal.proposal.contentSha256,
        decision: "approve",
        reason: "Reviewed exact proposal bytes.",
      });
    }
    const restartedService = new ResourceCapacityService({
      runtime,
      agentId: runtime.agentId,
      entityStore: entities,
      household,
      repository: new ResourceCapacityRepository(runtime, runtime.agentId),
      approvalQueue: createApprovalQueue(runtime, {
        agentId: runtime.agentId,
      }),
      scheduledTasks: getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
      }),
      now: currentDate,
    });
    await restartedService.initialize();
    const reviewed = await restartedService.readProposal({
      principalEntityId: SELF_ENTITY_ID,
      proposalId: proposal.proposal.proposalId,
    });
    expect(reviewed).toMatchObject({
      effectiveState: "review_complete",
      noReservationCreated: true,
      noCalendarMutationCreated: true,
      noMessageSent: true,
    });
    expect(
      reviewed.approvals.every((approval) => approval.state === "approved"),
    ).toBe(true);
    expect(reviewed.proposal.status).toBe("pending_review");
  });

  it("rejects unrelated or child reviewers before any approval artifact exists", async () => {
    const householdId = "capacity-household-review-auth";
    const resources = await seedResourceSet(householdId, "review-auth");
    const capacityNeed = need({
      needId: "review-auth-school-run",
      startsAt: "2027-03-16T15:00:00.000Z",
      endsAt: "2027-03-16T16:00:00.000Z",
      location: "place:school",
    });
    for (const approverId of [outsiderId, childOneId]) {
      await expect(
        service.createProposal({
          principalEntityId: SELF_ENTITY_ID,
          evaluation: evaluationInput(householdId, [capacityNeed], resources),
          requiredApproverEntityIds: [approverId],
          idempotencyKey: `capacity-invalid-reviewer-${approverId}`,
          expiresAt: "2027-03-16T12:00:00.000Z",
        }),
      ).rejects.toMatchObject({
        code: "RESOURCE_CAPACITY_ACCESS_DENIED",
      });
    }
    await expect(
      service.createProposal({
        principalEntityId: SELF_ENTITY_ID,
        evaluation: evaluationInput(householdId, [capacityNeed], resources),
        requiredApproverEntityIds: [caregiverId],
        idempotencyKey: "capacity-invalid-reviewer-missing-scope",
        expiresAt: "2027-03-16T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_ACCESS_DENIED",
    });
    await expect(
      service.createProposal({
        principalEntityId: SELF_ENTITY_ID,
        evaluation: evaluationInput(householdId, [capacityNeed], resources),
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        idempotencyKey: "capacity-invalid-reviewer-late-expiry",
        expiresAt: "2027-03-16T16:30:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_CAPACITY_INVALID_CONTRACT",
    });
    const rows = await executeRawSql(
      runtime,
      `SELECT proposal_id
       FROM app_lifeops.life_resource_capacity_proposals
       WHERE agent_id = '${runtime.agentId}'
         AND idempotency_key LIKE 'capacity-invalid-reviewer-%'`,
    );
    expect(rows).toEqual([]);
  });
});
