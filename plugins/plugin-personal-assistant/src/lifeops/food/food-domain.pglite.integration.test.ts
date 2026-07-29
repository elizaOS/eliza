/**
 * Real-PGlite food-domain coverage through the canonical graph, owner approval
 * queue, restartable repository, and real loopback provider wire.
 */
import { once } from "node:events";
import http from "node:http";
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
import { InstacartProductsLinkClient } from "./instacart.js";
import { FoodRepository } from "./repository.js";
import { FoodDomainService } from "./service.js";
import type {
  FoodPreference,
  HardFoodConstraint,
  InventoryObservation,
  MealCandidate,
  MealParticipant,
} from "./types.js";

describe("food domain — real PGlite and approval queue", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let entities: EntityStore;
  let approvals: ApprovalQueue;
  let repository: FoodRepository;
  let service: FoodDomainService;
  let providerServer: http.Server;
  let providerBaseUrl: string;
  let providerRequestCount = 0;
  let providerResponseGate: Promise<void> | null = null;
  let releaseProviderResponse: (() => void) | null = null;
  let providerRequestObserved: Promise<void> = Promise.resolve();
  let markProviderRequestObserved: (() => void) | null = null;
  let providerMode: "success" | "malformed" | "rate_limited" = "success";
  let nowMs = Date.parse("2027-03-12T12:00:00.000Z");
  const childEntityId = "food-child-a";
  const householdId = "food-household-main";

  function currentDate(): Date {
    return new Date(nowMs);
  }

  function resetProviderGate(): void {
    providerResponseGate = new Promise<void>((resolve) => {
      releaseProviderResponse = resolve;
    });
    providerRequestObserved = new Promise<void>((resolve) => {
      markProviderRequestObserved = resolve;
    });
  }

  function provenance(
    sourceId: string,
    sourceRevision = 1,
    kind: InventoryObservation["lot"]["provenance"]["kind"] = "user_confirmed",
  ): InventoryObservation["lot"]["provenance"] {
    return {
      kind,
      sourceId,
      sourceRevision,
      observedAt: currentDate().toISOString(),
      evidenceRef: `source:${sourceId}:${sourceRevision}`,
      confidence: kind === "consumption_inference" ? 0.6 : 1,
    };
  }

  function mealParticipant(
    entityId: string,
    portionServings = 1,
  ): MealParticipant {
    return {
      entityId,
      portionServings,
      attendanceProvenance: provenance(`headcount-${entityId}`),
    };
  }

  function constraint(): HardFoodConstraint {
    return {
      id: "food-constraint-peanut",
      householdId,
      appliesToEntityId: childEntityId,
      kind: "allergen_exclusion",
      excludedTags: ["peanut"],
      label: "Peanut exclusion",
      version: 1,
      provenance: provenance("constraint-source"),
      active: true,
    };
  }

  function preference(): FoodPreference {
    return {
      id: "food-preference-tacos",
      householdId,
      appliesToEntityId: null,
      preferredTags: ["family_favorite"],
      avoidedTags: ["spicy"],
      weight: 2,
      version: 1,
      provenance: provenance("preference-source"),
      active: true,
    };
  }

  function safeMeal(suffix: string): MealCandidate {
    return {
      mealId: `food-meal-${suffix}`,
      title: "Bean tacos",
      baseServings: 2,
      tags: ["family_favorite"],
      leftoverInventoryItemId: null,
      ingredients: [
        {
          itemId: `tortillas-${suffix}`,
          name: "corn tortillas",
          quantity: 1,
          unit: "package",
          dietaryTags: ["gluten_free"],
          allergenTags: [],
          ageRiskTags: [],
          safetyEvidence: "verified_label",
          upcs: ["000000000012"],
          brandFilters: [],
        },
      ],
    };
  }

  function inventoryObservation(input: {
    lotId: string;
    itemId: string;
    quantity: number;
    sourceRevision: number;
    kind?: InventoryObservation["lot"]["provenance"]["kind"];
    confidence?: InventoryObservation["lot"]["confidence"];
  }): InventoryObservation {
    return {
      lot: {
        lotId: input.lotId,
        householdId,
        itemId: input.itemId,
        name: input.itemId,
        quantity: input.quantity,
        unit: "each",
        confidence: input.confidence ?? "confirmed_on_hand",
        expiresAt: null,
        allergenTags: [],
        dietaryTags: [],
        provenance: provenance(
          `inventory-${input.lotId}`,
          input.sourceRevision,
          input.kind,
        ),
      },
    };
  }

  beforeAll(async () => {
    providerServer = http.createServer((request, response) => {
      void (async () => {
        for await (const _chunk of request) {
          // Fully consume request bytes so the test exercises a real HTTP exchange.
        }
        providerRequestCount += 1;
        markProviderRequestObserved?.();
        if (providerResponseGate) await providerResponseGate;
        if (providerMode === "malformed") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{malformed-provider-json");
          return;
        }
        if (providerMode === "rate_limited") {
          response.writeHead(429, {
            "content-type": "application/json",
            "x-request-id": "food-provider-rate-limit",
          });
          response.end('{"error":"provider detail remains private"}');
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": `food-provider-${providerRequestCount}`,
        });
        response.end(
          JSON.stringify({
            products_link_url:
              "https://www.instacart.com/store/shopping-list/food-test",
          }),
        );
      })();
    });
    providerServer.listen(0, "127.0.0.1");
    await once(providerServer, "listening");
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      throw new Error("food provider server failed to bind");
    }
    providerBaseUrl = `http://127.0.0.1:${address.port}`;

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
    await entities.upsert({
      entityId: childEntityId,
      type: "person",
      preferredName: "Child A",
      identities: [],
      tags: ["household-test"],
      visibility: "owner_only",
      state: {},
    });
    await graph.getRelationshipStore(runtime.agentId).upsert({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: childEntityId,
      type: "parent_of",
      metadata: {
        householdRole: "child",
        householdSubjectEntityIds: [childEntityId],
      },
      state: {},
      evidence: ["Owner identified this child."],
      confidence: 1,
      source: "user_chat",
    });
    approvals = createApprovalQueue(runtime, { agentId: runtime.agentId });
    repository = new FoodRepository(runtime, runtime.agentId);
    service = new FoodDomainService({
      runtime,
      agentId: runtime.agentId,
      entityStore: entities,
      relationshipStore: graph.getRelationshipStore(runtime.agentId),
      approvalQueue: approvals,
      repository,
      instacart: new InstacartProductsLinkClient({
        apiKey: "food-integration-provider-secret",
        testBaseUrl: providerBaseUrl,
      }),
      now: currentDate,
    });
    await service.initialize();
    await service.putHouseholdProfile({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      memberEntityIds: [SELF_ENTITY_ID, childEntityId],
      expectedVersion: 0,
    });
    await service.putConstraint({
      principalEntityId: SELF_ENTITY_ID,
      constraint: constraint(),
      expectedVersion: 0,
    });
    await service.putPreference({
      principalEntityId: SELF_ENTITY_ID,
      preference: preference(),
      expectedVersion: 0,
    });
  }, 180_000);

  afterAll(async () => {
    releaseProviderResponse?.();
    if (providerServer?.listening) {
      providerServer.close();
      await once(providerServer, "close");
    }
    await runtimeResult?.cleanup();
  });

  it("G23 rejects child and unknown-principal inventory or purchase mutations", async () => {
    const observation = inventoryObservation({
      lotId: "voice-requested",
      itemId: "cookies",
      quantity: 1,
      sourceRevision: 1,
    });
    await expect(
      service.recordInventoryObservation({
        principalEntityId: childEntityId,
        observation,
      }),
    ).rejects.toMatchObject({ code: "FOOD_ACCESS_DENIED" });
    await expect(
      service.requestShoppingHandoffApproval({
        principalEntityId: "television-guest",
        evaluation: await service.evaluateMeal({
          principalEntityId: SELF_ENTITY_ID,
          householdId,
          plannedFor: "2027-03-12T18:00:00.000Z",
          meal: safeMeal("voice"),
          participants: [mealParticipant(SELF_ENTITY_ID)],
        }),
        idempotencyKey: "voice-request-must-not-purchase",
      }),
    ).rejects.toMatchObject({ code: "FOOD_ACCESS_DENIED" });
  });

  it("G40 persists idempotent observations and refuses duplicate or out-of-order source corruption", async () => {
    const revisionTwo = inventoryObservation({
      lotId: "pantry-apples",
      itemId: "apples",
      quantity: 2,
      sourceRevision: 2,
    });
    const applied = await service.recordInventoryObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: revisionTwo,
    });
    expect(applied.applied).toBe(true);
    expect(applied.current.quantity).toBe(2);

    const replay = await service.recordInventoryObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: revisionTwo,
    });
    expect(replay.applied).toBe(false);
    expect(replay.current.rowVersion).toBe(applied.current.rowVersion);

    const old = await service.recordInventoryObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: inventoryObservation({
        lotId: "pantry-apples",
        itemId: "apples",
        quantity: 10,
        sourceRevision: 1,
      }),
    });
    expect(old.applied).toBe(false);
    expect(old.current.quantity).toBe(2);

    await expect(
      service.recordInventoryObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: inventoryObservation({
          lotId: "pantry-apples",
          itemId: "apples",
          quantity: 99,
          sourceRevision: 2,
        }),
      }),
    ).rejects.toMatchObject({ code: "FOOD_IDEMPOTENCY_CONFLICT" });

    const concurrent = await Promise.allSettled([
      service.recordInventoryObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: inventoryObservation({
          lotId: "pantry-apples",
          itemId: "apples",
          quantity: 3,
          sourceRevision: 3,
        }),
      }),
      service.recordInventoryObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: inventoryObservation({
          lotId: "pantry-apples",
          itemId: "apples",
          quantity: 4,
          sourceRevision: 3,
        }),
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winningResult = concurrent.find(
      (result) => result.status === "fulfilled",
    );
    if (winningResult?.status !== "fulfilled") {
      throw new Error("concurrent inventory update produced no winner");
    }

    const restartedRepository = new FoodRepository(runtime, runtime.agentId);
    const restartedService = new FoodDomainService({
      runtime,
      agentId: runtime.agentId,
      entityStore: entities,
      relationshipStore:
        resolveKnowledgeGraphService(runtime)?.getRelationshipStore(
          runtime.agentId,
        ) ??
        (() => {
          throw new Error("knowledge graph unavailable after restart");
        })(),
      approvalQueue: approvals,
      repository: restartedRepository,
      instacart: new InstacartProductsLinkClient({
        apiKey: "food-integration-provider-secret",
        testBaseUrl: providerBaseUrl,
      }),
      now: currentDate,
    });
    await restartedService.initialize();
    expect(await restartedRepository.listInventory(householdId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lotId: "pantry-apples",
          quantity: winningResult.value.current.quantity,
          rowVersion: 2,
        }),
      ]),
    );

    const inferred = inventoryObservation({
      lotId: "cross-source-bananas",
      itemId: "bananas",
      quantity: 9,
      sourceRevision: 50,
      kind: "consumption_inference",
      confidence: "likely_on_hand",
    });
    inferred.lot.provenance = provenance(
      "consumption-model-bananas",
      50,
      "consumption_inference",
    );
    const confirmed = inventoryObservation({
      lotId: "cross-source-bananas",
      itemId: "bananas",
      quantity: 2,
      sourceRevision: 1,
      kind: "user_confirmed",
    });
    confirmed.lot.provenance = provenance(
      "owner-count-bananas",
      1,
      "user_confirmed",
    );
    await Promise.all([
      service.recordInventoryObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: inferred,
      }),
      service.recordInventoryObservation({
        principalEntityId: SELF_ENTITY_ID,
        observation: confirmed,
      }),
    ]);
    expect(await restartedRepository.listInventory(householdId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lotId: "cross-source-bananas",
          quantity: 2,
          confidence: "confirmed_on_hand",
          provenance: expect.objectContaining({
            sourceId: "owner-count-bananas",
          }),
        }),
      ]),
    );
  });

  it("G25 publishes a safe, source-fresh plan and G47 exposes only the child-safe projection", async () => {
    const evaluation = await service.evaluateMeal({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      plannedFor: "2027-03-12T18:00:00.000Z",
      meal: safeMeal("published"),
      participants: [
        mealParticipant(SELF_ENTITY_ID),
        mealParticipant(childEntityId),
      ],
    });
    const plan = await service.publishMealPlan({
      principalEntityId: SELF_ENTITY_ID,
      planId: "food-plan-family-week",
      evaluation,
    });
    expect(plan.contentSha256).toBe(evaluation.contentSha256);

    const childView = await service.getView({
      principalEntityId: childEntityId,
      householdId,
    });
    expect(childView).toEqual({
      householdId,
      principalEntityId: childEntityId,
      meals: [
        {
          planId: "food-plan-family-week",
          mealDate: "2027-03-12T18:00:00.000Z",
          title: "Bean tacos",
          attending: true,
        },
      ],
    });
    expect(childView).not.toHaveProperty("inventory");
    expect(childView).not.toHaveProperty("preferences");
    expect(childView).not.toHaveProperty("constraints");
    expect(childView).not.toHaveProperty("handoffs");
  });

  it("G27 binds approval and content hashes, admits one concurrent provider call, and reuses the URL", async () => {
    const evaluation = await service.evaluateMeal({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      plannedFor: "2027-03-13T18:00:00.000Z",
      meal: safeMeal("idempotent"),
      participants: [
        mealParticipant(SELF_ENTITY_ID),
        mealParticipant(childEntityId),
      ],
    });
    const first = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "weekly-order-retry-1",
    });
    const replay = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "weekly-order-retry-1",
    });
    expect(replay.handoff.handoffId).toBe(first.handoff.handoffId);
    expect(replay.approvalRequest.id).toBe(first.approvalRequest.id);
    const contentCacheReplay = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "same-content-new-voice-utterance",
    });
    expect(contentCacheReplay.handoff.handoffId).toBe(first.handoff.handoffId);
    expect(contentCacheReplay.approvalRequest.id).toBe(
      first.approvalRequest.id,
    );
    expect(first.approvalRequest.state).toBe("pending");
    await expect(
      service.materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId: first.handoff.handoffId,
      }),
    ).rejects.toMatchObject({ code: "FOOD_APPROVAL_REQUIRED" });
    expect(providerRequestCount).toBe(0);

    await approvals.approve(
      first.approvalRequest.id,
      first.approvalRequest.subjectUserId,
      {
        resolvedBy: SELF_ENTITY_ID,
        resolutionReason: "Create this exact shopping-list link.",
      },
    );
    resetProviderGate();
    const materializing = service.materializeApprovedShoppingHandoff({
      principalEntityId: SELF_ENTITY_ID,
      handoffId: first.handoff.handoffId,
    });
    await providerRequestObserved;
    await expect(
      service.materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId: first.handoff.handoffId,
      }),
    ).rejects.toMatchObject({ code: "FOOD_HANDOFF_BUSY" });
    releaseProviderResponse?.();
    providerResponseGate = null;
    const completed = await materializing;
    expect(completed).toEqual(
      expect.objectContaining({
        state: "link_created",
        providerResultKind: "shopping_list_link",
        providerLinkUrl:
          "https://www.instacart.com/store/shopping-list/food-test",
        approvalRequestId: first.approvalRequest.id,
      }),
    );
    expect(completed).not.toHaveProperty("cart");
    expect(completed).not.toHaveProperty("order");
    expect(completed).not.toHaveProperty("checkout");
    expect(providerRequestCount).toBe(1);
    expect(
      await approvals.byId(
        first.approvalRequest.id,
        first.approvalRequest.subjectUserId,
      ),
    ).toMatchObject({
      state: "done",
    });

    const cached = await service.materializeApprovedShoppingHandoff({
      principalEntityId: SELF_ENTITY_ID,
      handoffId: first.handoff.handoffId,
    });
    expect(cached.providerLinkUrl).toBe(completed.providerLinkUrl);
    expect(providerRequestCount).toBe(1);
    expect(
      JSON.stringify(await repository.listHandoffs(householdId)),
    ).not.toContain("food-integration-provider-secret");
  });

  it("invalidates approval when inventory changes after the approved snapshot", async () => {
    const evaluation = await service.evaluateMeal({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      plannedFor: "2027-03-14T18:00:00.000Z",
      meal: safeMeal("stale"),
      participants: [mealParticipant(SELF_ENTITY_ID)],
    });
    const prepared = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "stale-source-handoff",
    });
    await approvals.approve(
      prepared.approvalRequest.id,
      prepared.approvalRequest.subjectUserId,
      {
        resolvedBy: SELF_ENTITY_ID,
        resolutionReason: "Approved exact pre-change list.",
      },
    );
    nowMs += 1_000;
    await service.recordInventoryObservation({
      principalEntityId: SELF_ENTITY_ID,
      observation: inventoryObservation({
        lotId: "new-receipt-item",
        itemId: "new-pantry-item",
        quantity: 1,
        sourceRevision: 1,
        kind: "receipt",
      }),
    });
    await expect(
      service.materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId: prepared.handoff.handoffId,
      }),
    ).rejects.toMatchObject({ code: "FOOD_STALE_SOURCE" });
    expect(
      await approvals.byId(
        prepared.approvalRequest.id,
        prepared.approvalRequest.subjectUserId,
      ),
    ).toMatchObject({
      state: "expired",
    });
    expect(
      await repository.getHandoff(prepared.handoff.handoffId),
    ).toMatchObject({
      state: "blocked",
      failureCode: "source_changed_after_approval",
    });
    expect(providerRequestCount).toBe(1);
  });

  it("persists ambiguous state before rejecting an expired provider lease retry", async () => {
    const evaluation = await service.evaluateMeal({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      plannedFor: "2027-03-14T20:00:00.000Z",
      meal: safeMeal("expired-lease"),
      participants: [mealParticipant(SELF_ENTITY_ID)],
    });
    const prepared = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "expired-provider-lease",
    });
    await approvals.approve(
      prepared.approvalRequest.id,
      prepared.approvalRequest.subjectUserId,
      {
        resolvedBy: SELF_ENTITY_ID,
        resolutionReason: "Exercise crash recovery for this exact list.",
      },
    );
    await repository.claimHandoff({
      handoffId: prepared.handoff.handoffId,
      now: currentDate().toISOString(),
      leaseMs: 1_000,
    });
    nowMs += 1_001;

    await expect(
      repository.claimHandoff({
        handoffId: prepared.handoff.handoffId,
        now: currentDate().toISOString(),
        leaseMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "FOOD_HANDOFF_AMBIGUOUS" });
    expect(
      await repository.getHandoff(prepared.handoff.handoffId),
    ).toMatchObject({
      state: "ambiguous",
      failureCode: "provider_outcome_unknown_after_lease",
      attemptToken: null,
      leaseExpiresAt: null,
    });
  });

  it("quarantines an ambiguous provider success response and never retries it automatically", async () => {
    const evaluation = await service.evaluateMeal({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      plannedFor: "2027-03-15T18:00:00.000Z",
      meal: safeMeal("ambiguous"),
      participants: [mealParticipant(SELF_ENTITY_ID)],
    });
    const prepared = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "ambiguous-provider-outcome",
    });
    await approvals.approve(
      prepared.approvalRequest.id,
      prepared.approvalRequest.subjectUserId,
      {
        resolvedBy: SELF_ENTITY_ID,
        resolutionReason: "Approved exact list for ambiguous-path test.",
      },
    );
    providerMode = "malformed";
    await expect(
      service.materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId: prepared.handoff.handoffId,
      }),
    ).rejects.toMatchObject({ code: "FOOD_PROVIDER_RESPONSE_INVALID" });
    expect(
      await repository.getHandoff(prepared.handoff.handoffId),
    ).toMatchObject({
      state: "ambiguous",
      failureCode: "FOOD_PROVIDER_RESPONSE_INVALID",
    });
    const requestCountAfterAmbiguous = providerRequestCount;
    await expect(
      service.materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId: prepared.handoff.handoffId,
      }),
    ).rejects.toMatchObject({ code: "FOOD_HANDOFF_AMBIGUOUS" });
    expect(providerRequestCount).toBe(requestCountAfterAmbiguous);
    providerMode = "success";
  });

  it("persists a rate limit as explicitly retryable without an automatic provider replay", async () => {
    const evaluation = await service.evaluateMeal({
      principalEntityId: SELF_ENTITY_ID,
      householdId,
      plannedFor: "2027-03-16T18:00:00.000Z",
      meal: safeMeal("rate-limited"),
      participants: [mealParticipant(SELF_ENTITY_ID)],
    });
    const prepared = await service.requestShoppingHandoffApproval({
      principalEntityId: SELF_ENTITY_ID,
      evaluation,
      idempotencyKey: "rate-limited-provider-outcome",
    });
    await approvals.approve(
      prepared.approvalRequest.id,
      prepared.approvalRequest.subjectUserId,
      {
        resolvedBy: SELF_ENTITY_ID,
        resolutionReason:
          "Approve this exact list despite a possible rate limit.",
      },
    );
    providerMode = "rate_limited";
    const requestsBeforeRateLimit = providerRequestCount;
    await expect(
      service.materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId: prepared.handoff.handoffId,
      }),
    ).rejects.toMatchObject({ code: "FOOD_PROVIDER_RATE_LIMITED" });
    expect(providerRequestCount).toBe(requestsBeforeRateLimit + 1);
    expect(
      await repository.getHandoff(prepared.handoff.handoffId),
    ).toMatchObject({
      state: "awaiting_approval",
      failureCode: "FOOD_PROVIDER_RATE_LIMITED",
    });
    expect(providerRequestCount).toBe(requestsBeforeRateLimit + 1);

    providerMode = "success";
    const completed = await service.materializeApprovedShoppingHandoff({
      principalEntityId: SELF_ENTITY_ID,
      handoffId: prepared.handoff.handoffId,
    });
    expect(completed.state).toBe("link_created");
    expect(providerRequestCount).toBe(requestsBeforeRateLimit + 2);
  });
});
