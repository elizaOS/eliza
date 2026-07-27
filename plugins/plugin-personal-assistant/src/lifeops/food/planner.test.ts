/**
 * Pure food-policy coverage for hard constraints, headcount, leftovers,
 * uncertain inventory, deterministic deltas, and substitution safety.
 */
import { describe, expect, it } from "vitest";
import {
  assertMealPlanSafe,
  buildShoppingListContent,
  evaluateMealPlan,
  evaluateSubstitution,
} from "./planner.js";
import type {
  FoodPreference,
  HardFoodConstraint,
  InventoryLot,
  MealCandidate,
} from "./types.js";

const plannedFor = "2027-03-12T18:00:00.000Z";

function provenance(
  sourceId: string,
  sourceRevision = 1,
): InventoryLot["provenance"] {
  return {
    kind: "user_confirmed",
    sourceId,
    sourceRevision,
    observedAt: "2027-03-12T12:00:00.000Z",
    evidenceRef: `memory:${sourceId}`,
    confidence: 1,
  };
}

function participant(entityId: string, portionServings = 1) {
  return {
    entityId,
    portionServings,
    attendanceProvenance: provenance(`headcount-${entityId}`),
  };
}

function constraint(): HardFoodConstraint {
  return {
    id: "constraint-peanut",
    householdId: "household-main",
    appliesToEntityId: "child-a",
    kind: "allergen_exclusion",
    excludedTags: ["peanut"],
    label: "Child A peanut allergy",
    version: 1,
    provenance: provenance("allergy-confirmation"),
    active: true,
  };
}

function preference(): FoodPreference {
  return {
    id: "preference-family-favorite",
    householdId: "household-main",
    appliesToEntityId: null,
    preferredTags: ["family_favorite"],
    avoidedTags: ["spicy"],
    weight: 2,
    version: 1,
    provenance: provenance("preference-confirmation"),
    active: true,
  };
}

function safeMeal(): MealCandidate {
  return {
    mealId: "meal-rice-beans",
    title: "Rice and beans",
    baseServings: 4,
    tags: ["family_favorite"],
    leftoverInventoryItemId: "leftover-rice-beans",
    ingredients: [
      {
        itemId: "rice",
        name: "white rice",
        quantity: 400,
        unit: "g",
        dietaryTags: ["gluten_free"],
        allergenTags: [],
        ageRiskTags: [],
        safetyEvidence: "recipe_source",
        upcs: [],
        brandFilters: [],
      },
      {
        itemId: "black-beans",
        name: "black beans",
        quantity: 2,
        unit: "can",
        dietaryTags: ["vegan"],
        allergenTags: [],
        ageRiskTags: [],
        safetyEvidence: "verified_label",
        upcs: ["000000000012"],
        brandFilters: ["S&W"],
      },
    ],
  };
}

function inventory(input: {
  lotId: string;
  itemId: string;
  quantity: number;
  unit: InventoryLot["unit"];
  confidence: InventoryLot["confidence"];
  expiresAt?: string | null;
}): InventoryLot {
  return {
    lotId: input.lotId,
    householdId: "household-main",
    itemId: input.itemId,
    name: input.itemId,
    quantity: input.quantity,
    unit: input.unit,
    confidence: input.confidence,
    expiresAt: input.expiresAt ?? null,
    allergenTags: [],
    dietaryTags: [],
    provenance: provenance(input.lotId),
    rowVersion: 1,
    updatedAt: "2027-03-12T12:00:00.000Z",
  };
}

describe("food planner policy", () => {
  it("G25 scales by real headcount, uses only safe confirmed leftovers, and asks about likely pantry stock", () => {
    const evaluation = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal: safeMeal(),
      participants: [participant("owner"), participant("child-a")],
      constraints: [constraint()],
      preferences: [preference()],
      inventory: [
        inventory({
          lotId: "leftover-confirmed",
          itemId: "leftover-rice-beans",
          quantity: 0.5,
          unit: "serving",
          confidence: "confirmed_on_hand",
        }),
        inventory({
          lotId: "leftover-expired",
          itemId: "leftover-rice-beans",
          quantity: 5,
          unit: "serving",
          confidence: "confirmed_on_hand",
          expiresAt: "2027-03-11T18:00:00.000Z",
        }),
        inventory({
          lotId: "rice-confirmed",
          itemId: "rice",
          quantity: 50,
          unit: "g",
          confidence: "confirmed_on_hand",
        }),
        inventory({
          lotId: "beans-likely",
          itemId: "black-beans",
          quantity: 1,
          unit: "can",
          confidence: "likely_on_hand",
        }),
      ],
    });

    expect(evaluation.blockedReasons).toEqual([]);
    expect(evaluation.requiredServings).toBe(2);
    expect(evaluation.leftoverServingsUsed).toBe(0.5);
    expect(evaluation.servingsToCook).toBe(1.5);
    expect(evaluation.preferenceScore).toBe(2);
    expect(evaluation.requiredInventoryChecks).toEqual(["black-beans"]);
    expect(evaluation.shoppingDelta).toEqual([
      expect.objectContaining({
        itemId: "black-beans",
        quantity: 0.75,
        unit: "can",
        conditionalOnInventoryCheck: true,
      }),
      expect.objectContaining({
        itemId: "rice",
        quantity: 100,
        unit: "g",
        conditionalOnInventoryCheck: false,
      }),
    ]);
    expect(() => buildShoppingListContent(evaluation)).toThrowError(
      expect.objectContaining({ code: "FOOD_STALE_SOURCE" }),
    );
  });

  it("G25 treats dislikes as ranking signals but blocks a hard allergen even when the meal is preferred", () => {
    const meal = safeMeal();
    meal.ingredients[0] = {
      ...meal.ingredients[0],
      allergenTags: ["peanut"],
      safetyEvidence: "verified_label",
    };
    meal.tags.push("spicy");
    const evaluation = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal,
      participants: [participant("child-a")],
      constraints: [constraint()],
      preferences: [preference()],
      inventory: [],
    });

    expect(evaluation.preferenceScore).toBe(0);
    expect(evaluation.blockedReasons).toEqual([
      "rice violates hard constraint constraint-peanut",
    ]);
    expect(() => assertMealPlanSafe(evaluation)).toThrowError(
      expect.objectContaining({ code: "FOOD_UNSAFE_MEAL" }),
    );
  });

  it("blocks confirmed unsafe pantry stock but does not treat absent stock as an ingredient", () => {
    const unsafeOnHand = inventory({
      lotId: "rice-cross-contact",
      itemId: "rice",
      quantity: 100,
      unit: "g",
      confidence: "confirmed_on_hand",
    });
    unsafeOnHand.allergenTags = ["peanut"];
    const unsafe = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal: safeMeal(),
      participants: [participant("child-a")],
      constraints: [constraint()],
      preferences: [],
      inventory: [unsafeOnHand],
    });
    expect(unsafe.blockedReasons).toContain(
      "rice-cross-contact inventory lot violates hard constraint constraint-peanut",
    );

    const absent = {
      ...unsafeOnHand,
      quantity: 0,
      confidence: "confirmed_absent" as const,
    };
    const withoutAbsentStock = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal: safeMeal(),
      participants: [participant("child-a")],
      constraints: [constraint()],
      preferences: [],
      inventory: [absent],
    });
    expect(withoutAbsentStock.blockedReasons).toEqual([]);
  });

  it("G26 blocks allergenic or unknown-label substitutions and requires new approval for a verified alternative", () => {
    const original = {
      productRef: "product-original",
      itemId: "beans",
      name: "Original beans",
      upc: "000000000012",
      allergenTags: [],
      dietaryTags: ["vegan"],
      ageRiskTags: [],
      labelEvidence: "human_verified_label" as const,
    };
    const unsafe = evaluateSubstitution({
      original,
      candidate: {
        ...original,
        productRef: "product-unsafe",
        upc: "000000000029",
        allergenTags: ["peanut"],
        labelEvidence: "provider_verified_label",
      },
      policy: "safe_equivalent_with_renewed_approval",
      constraints: [constraint()],
      participantEntityIds: ["child-a"],
    });
    expect(unsafe).toEqual({
      outcome: "block",
      reasons: ["Candidate product violates a hard food constraint"],
      constraintIds: ["constraint-peanut"],
    });

    const unsafeExactIdentifier = evaluateSubstitution({
      original,
      candidate: {
        ...original,
        productRef: "product-unsafe-exact-upc",
        allergenTags: ["peanut"],
        labelEvidence: "provider_verified_label",
      },
      policy: "exact_identifier_only",
      constraints: [constraint()],
      participantEntityIds: ["child-a"],
    });
    expect(unsafeExactIdentifier.outcome).toBe("block");

    const unknown = evaluateSubstitution({
      original,
      candidate: {
        ...original,
        productRef: "product-unknown",
        upc: "000000000029",
        labelEvidence: "unknown",
      },
      policy: "safe_equivalent_with_renewed_approval",
      constraints: [constraint()],
      participantEntityIds: ["child-a"],
    });
    expect(unknown.outcome).toBe("block");

    const reviewed = evaluateSubstitution({
      original,
      candidate: {
        ...original,
        productRef: "product-reviewed",
        upc: "000000000029",
        labelEvidence: "human_verified_label",
      },
      policy: "safe_equivalent_with_renewed_approval",
      constraints: [constraint()],
      participantEntityIds: ["child-a"],
    });
    expect(reviewed.outcome).toBe("requires_renewed_approval");

    const exact = evaluateSubstitution({
      original,
      candidate: { ...original, productRef: "provider-alias" },
      policy: "exact_identifier_only",
      constraints: [constraint()],
      participantEntityIds: ["child-a"],
    });
    expect(exact.outcome).toBe("allow_exact");
  });

  it("produces a hash-bound handoff only after all uncertain inventory is resolved", () => {
    const evaluation = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal: safeMeal(),
      participants: [participant("owner")],
      constraints: [],
      preferences: [],
      inventory: [],
    });
    const content = buildShoppingListContent(evaluation);

    expect(content.requiresHumanLabelReview).toBe(true);
    expect(content.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(content.sourceMealPlanSha256).toBe(evaluation.contentSha256);
  });

  it("binds the meal evaluation to calendar or custody headcount provenance", () => {
    const firstParticipant = participant("child-a");
    const updatedParticipant = {
      ...firstParticipant,
      attendanceProvenance: provenance("headcount-child-a", 2),
    };
    const first = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal: safeMeal(),
      participants: [firstParticipant],
      constraints: [constraint()],
      preferences: [],
      inventory: [],
    });
    const updated = evaluateMealPlan({
      householdId: "household-main",
      plannedFor,
      meal: safeMeal(),
      participants: [updatedParticipant],
      constraints: [constraint()],
      preferences: [],
      inventory: [],
    });

    expect(updated.contentSha256).not.toBe(first.contentSha256);
    expect(updated.participants[0]?.attendanceProvenance.sourceRevision).toBe(
      2,
    );
  });
});
