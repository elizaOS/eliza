/**
 * Real-PGlite reachability proof for the HOUSEHOLD_FOOD conversational action:
 * plugin registration, owner authorization, planner-JSON shape rejection, the
 * full profile -> constraint -> preference -> inventory -> evaluate -> publish
 * -> shopping-handoff flow against the production runtime service, and the
 * stale-contentSha256 guard. Deterministic evidence, not a live-model journey.
 */
import { randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  type ActionResult,
  type AgentRuntime,
  createMessageMemory,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { personalAssistantPlugin } from "../../plugin.js";
import { createApprovalQueue } from "../approval-queue.js";
import { createFoodDomainAction, FOOD_DOMAIN_ACTION } from "./action.js";
import { FOOD_DOMAIN_SERVICE, getFoodDomainService } from "./service.js";
import type {
  FoodOwnerView,
  FoodPreference,
  FoodShoppingHandoff,
  HardFoodConstraint,
  MealPlanEvaluation,
  PublishedMealPlan,
} from "./types.js";

describe("HOUSEHOLD_FOOD action — real PGlite production wiring", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  const householdId = `food-action-household-${randomUUID()}`;
  const childEntityId = `ent_food_action_child_${randomUUID()}`;
  const action = createFoodDomainAction({ authorize: async () => true });

  function ownerMessage(): Memory {
    return createMessageMemory({
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: randomUUID() as UUID,
      content: { text: "Plan dinner for the family.", source: "client_chat" },
    });
  }

  async function run(
    subaction: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const result = await action.handler?.(
      runtime,
      ownerMessage(),
      undefined,
      { parameters: { action: subaction, subaction, ...params } },
      undefined,
    );
    if (!result || typeof result === "boolean") {
      throw new Error("food action returned no ActionResult");
    }
    return result;
  }

  // Fixed observation instant: attendance provenance feeds the deterministic
  // evaluation contentSha256, so the meal input must be byte-identical across
  // the evaluate -> publish -> handoff calls for the hash guard to hold.
  const observedAt = "2027-04-01T12:00:00.000Z";

  function provenance(sourceId: string): Record<string, unknown> {
    return {
      kind: "user_confirmed",
      sourceId,
      sourceRevision: 1,
      observedAt,
      evidenceRef: `source:${sourceId}:1`,
      confidence: 1,
    };
  }

  function mealInput(): Record<string, unknown> {
    return {
      mealId: "food-action-meal-tacos",
      title: "Bean tacos",
      baseServings: 2,
      tags: ["family_favorite"],
      leftoverInventoryItemId: null,
      ingredients: [
        {
          itemId: "corn-tortillas",
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

  function participants(): Record<string, unknown>[] {
    return [
      {
        entityId: SELF_ENTITY_ID,
        portionServings: 1,
        attendanceProvenance: provenance("attendance-owner"),
      },
      {
        entityId: childEntityId,
        portionServings: 1,
        attendanceProvenance: provenance("attendance-child"),
      },
    ];
  }

  function mealParams(): Record<string, unknown> {
    return {
      householdId,
      plannedFor: "2027-04-02T23:30:00.000Z",
      meal: mealInput(),
      participants: participants(),
    };
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    await graph.getEntityStore(runtime.agentId).ensureSelf();
    await graph.getEntityStore(runtime.agentId).upsert({
      entityId: childEntityId,
      type: "person",
      preferredName: "Food action child",
      identities: [],
      tags: ["food-action-integration"],
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
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("registers the umbrella, its promoted virtuals, and the runtime service in production composition", () => {
    const names = personalAssistantPlugin.actions?.map(
      (candidate) => candidate.name,
    );
    expect(names).toContain(FOOD_DOMAIN_ACTION);
    expect(names).toContain("HOUSEHOLD_FOOD_EVALUATE_MEAL");
    expect(names).toContain("HOUSEHOLD_FOOD_REQUEST_SHOPPING_HANDOFF");
    expect(
      personalAssistantPlugin.services?.map(
        (candidate) => candidate.serviceType,
      ),
    ).toContain(FOOD_DOMAIN_SERVICE);
    expect(() => getFoodDomainService(runtime)).not.toThrow();
  });

  it("denies unauthenticated principals with a failed effect receipt", async () => {
    const denied = createFoodDomainAction({ authorize: async () => false });
    const result = await denied.handler?.(
      runtime,
      ownerMessage(),
      undefined,
      { parameters: { action: "view", subaction: "view", householdId } },
      undefined,
    );
    if (!result || typeof result === "boolean") {
      throw new Error("denied food action returned no ActionResult");
    }
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
    expect(result.effectReceipts?.[0]?.outcome).toBe("failed");
  });

  it("rejects malformed planner JSON with a typed contract error", async () => {
    await expect(
      run("put_constraint", {
        constraint: {
          id: "bad-constraint",
          householdId,
          appliesToEntityId: childEntityId,
          kind: "not-a-real-kind",
          excludedTags: ["peanut"],
          label: "Bad kind",
          version: 1,
          provenance: provenance("bad-kind"),
          active: true,
        },
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "FOOD_INVALID_CONTRACT" });
  });

  it("drives the full authoring surface through the production service", async () => {
    const profile = await run("put_household_profile", {
      householdId,
      memberEntityIds: [SELF_ENTITY_ID, childEntityId],
      expectedVersion: 0,
    });
    expect(profile.success).toBe(true);
    expect(profile.effectReceipts?.[0]?.outcome).toBe("applied");

    const constraint = await run("put_constraint", {
      constraint: {
        id: "food-action-constraint-peanut",
        householdId,
        appliesToEntityId: childEntityId,
        kind: "allergen_exclusion",
        excludedTags: ["peanut"],
        label: "Peanut exclusion",
        version: 1,
        provenance: provenance("constraint-source"),
        active: true,
      },
      expectedVersion: 0,
    });
    expect(constraint.success).toBe(true);
    expect(
      (constraint.data as { constraint: HardFoodConstraint }).constraint.kind,
    ).toBe("allergen_exclusion");

    const preference = await run("put_preference", {
      preference: {
        id: "food-action-preference-tacos",
        householdId,
        appliesToEntityId: null,
        preferredTags: ["family_favorite"],
        avoidedTags: ["spicy"],
        weight: 2,
        version: 1,
        provenance: provenance("preference-source"),
        active: true,
      },
      expectedVersion: 0,
    });
    expect(preference.success).toBe(true);
    expect(
      (preference.data as { preference: FoodPreference }).preference
        .preferredTags,
    ).toEqual(["family_favorite"]);

    const inventory = await run("record_inventory", {
      lot: {
        lotId: "food-action-lot-beans",
        householdId,
        itemId: "black-beans",
        name: "black beans",
        quantity: 4,
        unit: "can",
        confidence: "confirmed_on_hand",
        expiresAt: null,
        allergenTags: [],
        dietaryTags: [],
        provenance: provenance("inventory-beans"),
      },
    });
    expect(inventory.success).toBe(true);
    expect(inventory.effectReceipts?.[0]?.outcome).toBe("applied");

    const evaluated = await run("evaluate_meal", mealParams());
    expect(evaluated.success).toBe(true);
    expect(evaluated.effectReceipts?.[0]?.outcome).toBe("noop");
    const evaluation = (evaluated.data as { evaluation: MealPlanEvaluation })
      .evaluation;
    expect(evaluation.blockedReasons).toEqual([]);
    expect(evaluation.shoppingDelta.length).toBeGreaterThan(0);
    expect(evaluated.text).toContain(evaluation.contentSha256);

    const published = await run("publish_meal_plan", {
      ...mealParams(),
      planId: "food-action-plan-tacos",
      expectedContentSha256: evaluation.contentSha256,
    });
    expect(published.success).toBe(true);
    expect(
      (published.data as { plan: PublishedMealPlan }).plan.attendeeEntityIds,
    ).toContain(childEntityId);
    expect(published.effectReceipts?.[0]?.outcome).toBe("applied");

    const view = await run("view", { householdId });
    expect(view.success).toBe(true);
    const ownerView = (view.data as { view: FoodOwnerView }).view;
    expect(ownerView.constraints).toHaveLength(1);
    expect(ownerView.mealPlans.map((plan) => plan.planId)).toContain(
      "food-action-plan-tacos",
    );
  });

  it("rejects publishing against a stale contentSha256 instead of shipping unreviewed content", async () => {
    const stale = await run("publish_meal_plan", {
      ...mealParams(),
      planId: "food-action-plan-stale",
      expectedContentSha256: "0".repeat(64),
    });
    expect(stale.success).toBe(false);
    expect(stale.data).toMatchObject({ error: "FOOD_STALE_SOURCE" });
    expect(stale.effectReceipts?.[0]?.outcome).toBe("failed");
  });

  it("queues an approval-bound shopping handoff and replays the exact same intent idempotently", async () => {
    const evaluated = await run("evaluate_meal", mealParams());
    const evaluation = (evaluated.data as { evaluation: MealPlanEvaluation })
      .evaluation;

    const first = await run("request_shopping_handoff", {
      ...mealParams(),
      expectedContentSha256: evaluation.contentSha256,
      idempotencyKey: "food-action-handoff-1",
    });
    expect(first.success).toBe(true);
    const firstHandoff = (
      first.data as {
        handoff: { handoff: FoodShoppingHandoff; replayed: boolean };
      }
    ).handoff;
    expect(firstHandoff.replayed).toBe(false);
    expect(firstHandoff.handoff.state).toBe("awaiting_approval");
    expect(firstHandoff.handoff.approvalRequestId).not.toBeNull();
    expect(first.effectReceipts?.[0]?.idempotency.replayed).toBe(false);

    const approvals = createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    });
    const approvalRequestId = firstHandoff.handoff.approvalRequestId;
    if (!approvalRequestId) throw new Error("approval binding missing");
    const request = await approvals.byId(approvalRequestId);
    expect(request?.state).toBe("pending");
    expect(request?.payload).toMatchObject({
      action: "execute_workflow",
      workflowId: "food.instacart.create_products_link",
    });

    const replayed = await run("request_shopping_handoff", {
      ...mealParams(),
      expectedContentSha256: evaluation.contentSha256,
      idempotencyKey: "food-action-handoff-1",
    });
    expect(replayed.success).toBe(true);
    const replayedHandoff = (
      replayed.data as {
        handoff: { handoff: FoodShoppingHandoff; replayed: boolean };
      }
    ).handoff;
    expect(replayedHandoff.replayed).toBe(true);
    expect(replayedHandoff.handoff.handoffId).toBe(
      firstHandoff.handoff.handoffId,
    );
    expect(replayed.effectReceipts?.[0]?.idempotency.replayed).toBe(true);
  });
});
