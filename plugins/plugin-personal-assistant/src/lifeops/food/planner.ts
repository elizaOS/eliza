/**
 * Deterministic meal safety, portion, leftover, inventory, and shopping-delta
 * evaluation. LLM output may supply candidates, but this module is the policy
 * gate that decides whether a candidate can advance to an approval handoff.
 */
import crypto from "node:crypto";
import { stableStringify } from "@elizaos/core";
import {
  assertConfidence,
  assertIsoTimestamp,
  assertNonEmptyText,
  assertNonNegativeInteger,
  assertPositiveQuantity,
  FoodDomainError,
  type FoodPreference,
  type FoodProvenance,
  type FoodShoppingListContent,
  type FoodUnit,
  type HardFoodConstraint,
  type InventoryLot,
  isFoodProvenanceKind,
  isFoodUnit,
  isHardFoodConstraintKind,
  isInventoryConfidenceState,
  type MealCandidate,
  type MealIngredient,
  type MealParticipant,
  type MealPlanEvaluation,
  normalizeTags,
  type ProductSafetyFacts,
  roundFoodQuantity,
  type ShoppingDeltaLine,
  SUBSTITUTION_POLICIES,
  type SubstitutionDecision,
  type SubstitutionPolicy,
} from "./types.js";

const UNIT_TO_BASE: Readonly<
  Record<FoodUnit, { dimension: string; multiplier: number }>
> = {
  serving: { dimension: "serving", multiplier: 1 },
  each: { dimension: "each", multiplier: 1 },
  package: { dimension: "package", multiplier: 1 },
  can: { dimension: "can", multiplier: 1 },
  bunch: { dimension: "bunch", multiplier: 1 },
  head: { dimension: "head", multiplier: 1 },
  g: { dimension: "mass", multiplier: 1 },
  kg: { dimension: "mass", multiplier: 1_000 },
  oz: { dimension: "mass", multiplier: 28.349523125 },
  lb: { dimension: "mass", multiplier: 453.59237 },
  ml: { dimension: "volume", multiplier: 1 },
  l: { dimension: "volume", multiplier: 1_000 },
  cup: { dimension: "volume", multiplier: 236.5882365 },
  tbsp: { dimension: "volume", multiplier: 14.78676478125 },
  tsp: { dimension: "volume", multiplier: 4.92892159375 },
};

function sha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function normalizeIdentifier(value: string, field: string): string {
  return assertNonEmptyText(value, field, 200);
}

function normalizeStringList(
  values: readonly string[],
  field: string,
  max = 100,
): string[] {
  if (values.length > max) {
    throw new FoodDomainError(
      `${field} may contain at most ${max} entries`,
      "FOOD_INVALID_CONTRACT",
      { field, count: values.length },
    );
  }
  return Array.from(
    new Set(values.map((value) => assertNonEmptyText(value, field, 200))),
  ).sort();
}

function normalizeUpcs(upcs: readonly string[], field: string): string[] {
  const values = normalizeStringList(upcs, field, 20);
  for (const upc of values) {
    if (!/^(?:\d{12}|\d{14})$/u.test(upc)) {
      throw new FoodDomainError(
        `${field} entries must be 12- or 14-digit UPC values`,
        "FOOD_INVALID_CONTRACT",
        { field },
      );
    }
  }
  return values;
}

export function normalizeFoodProvenance(
  provenance: FoodProvenance,
): FoodProvenance {
  if (!isFoodProvenanceKind(provenance.kind)) {
    throw new FoodDomainError(
      `Unsupported food provenance kind: ${provenance.kind}`,
      "FOOD_INVALID_CONTRACT",
      { kind: provenance.kind },
    );
  }
  return {
    kind: provenance.kind,
    sourceId: normalizeIdentifier(provenance.sourceId, "provenance.sourceId"),
    sourceRevision: assertNonNegativeInteger(
      provenance.sourceRevision,
      "provenance.sourceRevision",
    ),
    observedAt: assertIsoTimestamp(
      provenance.observedAt,
      "provenance.observedAt",
    ),
    evidenceRef: normalizeIdentifier(
      provenance.evidenceRef,
      "provenance.evidenceRef",
    ),
    confidence: assertConfidence(
      provenance.confidence,
      "provenance.confidence",
    ),
  };
}

export function normalizeIngredient(
  ingredient: MealIngredient,
): MealIngredient {
  if (!isFoodUnit(ingredient.unit)) {
    throw new FoodDomainError(
      `Unsupported ingredient unit: ${ingredient.unit}`,
      "FOOD_INVALID_CONTRACT",
      { unit: ingredient.unit },
    );
  }
  if (
    ingredient.safetyEvidence !== "verified_label" &&
    ingredient.safetyEvidence !== "recipe_source" &&
    ingredient.safetyEvidence !== "unknown"
  ) {
    throw new FoodDomainError(
      "ingredient.safetyEvidence is invalid",
      "FOOD_INVALID_CONTRACT",
    );
  }
  return {
    itemId: normalizeIdentifier(ingredient.itemId, "ingredient.itemId"),
    name: assertNonEmptyText(ingredient.name, "ingredient.name", 200),
    quantity: assertPositiveQuantity(
      ingredient.quantity,
      "ingredient.quantity",
    ),
    unit: ingredient.unit,
    dietaryTags: normalizeTags(
      ingredient.dietaryTags,
      "ingredient.dietaryTags",
    ),
    allergenTags: normalizeTags(
      ingredient.allergenTags,
      "ingredient.allergenTags",
    ),
    ageRiskTags: normalizeTags(
      ingredient.ageRiskTags,
      "ingredient.ageRiskTags",
    ),
    safetyEvidence: ingredient.safetyEvidence,
    upcs: normalizeUpcs(ingredient.upcs, "ingredient.upcs"),
    brandFilters: normalizeStringList(
      ingredient.brandFilters,
      "ingredient.brandFilters",
      20,
    ),
  };
}

export function normalizeMealCandidate(meal: MealCandidate): MealCandidate {
  if (meal.ingredients.length === 0 || meal.ingredients.length > 100) {
    throw new FoodDomainError(
      "meal.ingredients must contain between 1 and 100 ingredients",
      "FOOD_INVALID_CONTRACT",
      { count: meal.ingredients.length },
    );
  }
  const ingredients = meal.ingredients.map(normalizeIngredient);
  const itemIds = new Set<string>();
  for (const ingredient of ingredients) {
    if (itemIds.has(ingredient.itemId)) {
      throw new FoodDomainError(
        `meal.ingredients contains duplicate itemId ${ingredient.itemId}`,
        "FOOD_INVALID_CONTRACT",
        { itemId: ingredient.itemId },
      );
    }
    itemIds.add(ingredient.itemId);
  }
  return {
    mealId: normalizeIdentifier(meal.mealId, "meal.mealId"),
    title: assertNonEmptyText(meal.title, "meal.title", 200),
    baseServings: assertPositiveQuantity(
      meal.baseServings,
      "meal.baseServings",
    ),
    ingredients,
    tags: normalizeTags(meal.tags, "meal.tags"),
    leftoverInventoryItemId:
      meal.leftoverInventoryItemId === null
        ? null
        : normalizeIdentifier(
            meal.leftoverInventoryItemId,
            "meal.leftoverInventoryItemId",
          ),
  };
}

export function normalizeParticipants(
  participants: readonly MealParticipant[],
): MealParticipant[] {
  if (participants.length === 0 || participants.length > 50) {
    throw new FoodDomainError(
      "participants must contain between 1 and 50 household members",
      "FOOD_INVALID_CONTRACT",
      { count: participants.length },
    );
  }
  const normalized = participants
    .map((participant) => ({
      entityId: normalizeIdentifier(
        participant.entityId,
        "participant.entityId",
      ),
      portionServings: assertPositiveQuantity(
        participant.portionServings,
        "participant.portionServings",
      ),
      attendanceProvenance: normalizeFoodProvenance(
        participant.attendanceProvenance,
      ),
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  if (
    new Set(normalized.map((entry) => entry.entityId)).size !==
    normalized.length
  ) {
    throw new FoodDomainError(
      "participants must not contain duplicate household members",
      "FOOD_INVALID_CONTRACT",
    );
  }
  return normalized;
}

function constraintApplies(
  constraint: HardFoodConstraint,
  participantIds: ReadonlySet<string>,
): boolean {
  return (
    constraint.active &&
    (constraint.appliesToEntityId === null ||
      participantIds.has(constraint.appliesToEntityId))
  );
}

function preferenceApplies(
  preference: FoodPreference,
  participantIds: ReadonlySet<string>,
): boolean {
  return (
    preference.active &&
    (preference.appliesToEntityId === null ||
      participantIds.has(preference.appliesToEntityId))
  );
}

function ingredientSafetyTags(ingredient: MealIngredient): Set<string> {
  return new Set([
    ...ingredient.dietaryTags,
    ...ingredient.allergenTags,
    ...ingredient.ageRiskTags,
  ]);
}

function lotSafetyTags(lot: InventoryLot): Set<string> {
  return new Set([...lot.allergenTags, ...lot.dietaryTags]);
}

function matchingConstraintTags(
  constraints: readonly HardFoodConstraint[],
  tags: ReadonlySet<string>,
): HardFoodConstraint[] {
  return constraints.filter((constraint) =>
    constraint.excludedTags.some((tag) => tags.has(tag)),
  );
}

function isExpiredAt(lot: InventoryLot, at: string): boolean {
  return lot.expiresAt !== null && Date.parse(lot.expiresAt) <= Date.parse(at);
}

export function convertFoodQuantity(
  quantity: number,
  fromUnit: FoodUnit,
  toUnit: FoodUnit,
): number | null {
  const from = UNIT_TO_BASE[fromUnit];
  const to = UNIT_TO_BASE[toUnit];
  if (from.dimension !== to.dimension) return null;
  return roundFoodQuantity((quantity * from.multiplier) / to.multiplier);
}

export function inventorySnapshotSha256(lots: readonly InventoryLot[]): string {
  return sha256(
    [...lots]
      .sort((left, right) => left.lotId.localeCompare(right.lotId))
      .map((lot) => ({
        lotId: lot.lotId,
        itemId: lot.itemId,
        quantity: lot.quantity,
        unit: lot.unit,
        confidence: lot.confidence,
        expiresAt: lot.expiresAt,
        allergenTags: [...lot.allergenTags].sort(),
        dietaryTags: [...lot.dietaryTags].sort(),
        source: {
          kind: lot.provenance.kind,
          sourceId: lot.provenance.sourceId,
          sourceRevision: lot.provenance.sourceRevision,
          observedAt: lot.provenance.observedAt,
        },
        rowVersion: lot.rowVersion,
      })),
  );
}

export function safetyPolicySha256(
  constraints: readonly HardFoodConstraint[],
): string {
  return sha256(
    constraints
      .filter((constraint) => constraint.active)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((constraint) => ({
        id: constraint.id,
        appliesToEntityId: constraint.appliesToEntityId,
        kind: constraint.kind,
        excludedTags: [...constraint.excludedTags].sort(),
        version: constraint.version,
      })),
  );
}

function availableConfirmedQuantity(
  lots: readonly InventoryLot[],
  itemId: string,
  unit: FoodUnit,
  plannedFor: string,
): number {
  return roundFoodQuantity(
    lots
      .filter(
        (lot) =>
          lot.itemId === itemId &&
          lot.confidence === "confirmed_on_hand" &&
          !isExpiredAt(lot, plannedFor),
      )
      .reduce((sum, lot) => {
        const converted = convertFoodQuantity(lot.quantity, lot.unit, unit);
        return converted === null ? sum : sum + converted;
      }, 0),
  );
}

function hasLikelyInventory(
  lots: readonly InventoryLot[],
  itemId: string,
  plannedFor: string,
): boolean {
  return lots.some(
    (lot) =>
      lot.itemId === itemId &&
      lot.confidence === "likely_on_hand" &&
      !isExpiredAt(lot, plannedFor),
  );
}

export interface EvaluateMealPlanInput {
  householdId: string;
  plannedFor: string;
  meal: MealCandidate;
  participants: MealParticipant[];
  constraints: HardFoodConstraint[];
  preferences: FoodPreference[];
  inventory: InventoryLot[];
}

export function evaluateMealPlan(
  input: EvaluateMealPlanInput,
): MealPlanEvaluation {
  const householdId = normalizeIdentifier(input.householdId, "householdId");
  const plannedFor = assertIsoTimestamp(input.plannedFor, "plannedFor");
  const meal = normalizeMealCandidate(input.meal);
  const participants = normalizeParticipants(input.participants);
  const constraints = input.constraints.map(validateConstraint);
  const preferences = input.preferences.map(validatePreference);
  const inventory = input.inventory.map((lot): InventoryLot => {
    const normalized = validateInventoryLot(lot);
    if (normalized.householdId !== householdId) {
      throw new FoodDomainError(
        "Inventory lot belongs to a different household",
        "FOOD_INVALID_CONTRACT",
        { lotId: normalized.lotId, householdId: normalized.householdId },
      );
    }
    return {
      ...normalized,
      rowVersion: assertNonNegativeInteger(
        lot.rowVersion,
        "inventory.rowVersion",
      ),
      updatedAt: assertIsoTimestamp(lot.updatedAt, "inventory.updatedAt"),
    };
  });
  for (const constraint of constraints) {
    if (constraint.householdId !== householdId) {
      throw new FoodDomainError(
        "Hard food constraint belongs to a different household",
        "FOOD_INVALID_CONTRACT",
        { constraintId: constraint.id, householdId: constraint.householdId },
      );
    }
  }
  for (const preference of preferences) {
    if (preference.householdId !== householdId) {
      throw new FoodDomainError(
        "Food preference belongs to a different household",
        "FOOD_INVALID_CONTRACT",
        { preferenceId: preference.id, householdId: preference.householdId },
      );
    }
  }
  const participantIds = new Set(
    participants.map((participant) => participant.entityId),
  );
  const applicableConstraints = constraints
    .filter((constraint) => constraintApplies(constraint, participantIds))
    .sort((left, right) => left.id.localeCompare(right.id));
  const applicablePreferences = preferences.filter((preference) =>
    preferenceApplies(preference, participantIds),
  );

  const blockedReasons: string[] = [];
  for (const ingredient of meal.ingredients) {
    const matching = matchingConstraintTags(
      applicableConstraints,
      ingredientSafetyTags(ingredient),
    );
    for (const constraint of matching) {
      blockedReasons.push(
        `${ingredient.itemId} violates hard constraint ${constraint.id}`,
      );
    }
    if (
      applicableConstraints.length > 0 &&
      ingredient.safetyEvidence === "unknown"
    ) {
      blockedReasons.push(
        `${ingredient.itemId} lacks safety evidence for a constrained meal`,
      );
    }
    for (const lot of inventory.filter(
      (candidate) =>
        candidate.itemId === ingredient.itemId &&
        candidate.confidence === "confirmed_on_hand" &&
        !isExpiredAt(candidate, plannedFor),
    )) {
      for (const constraint of matchingConstraintTags(
        applicableConstraints,
        lotSafetyTags(lot),
      )) {
        blockedReasons.push(
          `${lot.lotId} inventory lot violates hard constraint ${constraint.id}`,
        );
      }
    }
  }

  const requiredServings = roundFoodQuantity(
    participants.reduce(
      (total, participant) => total + participant.portionServings,
      0,
    ),
  );
  const leftoverLots =
    meal.leftoverInventoryItemId === null
      ? []
      : inventory.filter(
          (lot) =>
            lot.itemId === meal.leftoverInventoryItemId &&
            lot.unit === "serving" &&
            !isExpiredAt(lot, plannedFor),
        );
  for (const lot of leftoverLots) {
    if (lot.confidence !== "confirmed_on_hand") continue;
    for (const constraint of matchingConstraintTags(
      applicableConstraints,
      lotSafetyTags(lot),
    )) {
      blockedReasons.push(
        `${lot.lotId} leftover violates hard constraint ${constraint.id}`,
      );
    }
  }
  const leftoverServingsUsed = Math.min(
    requiredServings,
    availableConfirmedQuantity(
      leftoverLots,
      meal.leftoverInventoryItemId ?? "",
      "serving",
      plannedFor,
    ),
  );
  const servingsToCook = roundFoodQuantity(
    Math.max(0, requiredServings - leftoverServingsUsed),
  );
  const scale = servingsToCook / meal.baseServings;
  const requiredInventoryChecks = new Set<string>();
  if (
    meal.leftoverInventoryItemId !== null &&
    hasLikelyInventory(leftoverLots, meal.leftoverInventoryItemId, plannedFor)
  ) {
    requiredInventoryChecks.add(meal.leftoverInventoryItemId);
  }

  const shoppingDelta: ShoppingDeltaLine[] = [];
  if (servingsToCook > 0) {
    for (const ingredient of meal.ingredients) {
      const required = roundFoodQuantity(ingredient.quantity * scale);
      if (required <= 0) continue;
      const confirmed = availableConfirmedQuantity(
        inventory,
        ingredient.itemId,
        ingredient.unit,
        plannedFor,
      );
      const quantity = roundFoodQuantity(Math.max(0, required - confirmed));
      const conditionalOnInventoryCheck = hasLikelyInventory(
        inventory,
        ingredient.itemId,
        plannedFor,
      );
      if (conditionalOnInventoryCheck) {
        requiredInventoryChecks.add(ingredient.itemId);
      }
      if (quantity <= 0) continue;
      shoppingDelta.push({
        itemId: ingredient.itemId,
        name: ingredient.name,
        quantity,
        unit: ingredient.unit,
        upcs: ingredient.upcs,
        brandFilters: ingredient.brandFilters,
        allergenTags: ingredient.allergenTags,
        dietaryTags: ingredient.dietaryTags,
        conditionalOnInventoryCheck,
      });
    }
  }

  const preferenceTags = new Set([
    ...meal.tags,
    ...meal.ingredients.flatMap((ingredient) => ingredient.dietaryTags),
  ]);
  const preferenceScore = applicablePreferences.reduce((score, preference) => {
    const preferred = preference.preferredTags.filter((tag) =>
      preferenceTags.has(tag),
    ).length;
    const avoided = preference.avoidedTags.filter((tag) =>
      preferenceTags.has(tag),
    ).length;
    return score + (preferred - avoided) * preference.weight;
  }, 0);

  const inventoryHash = inventorySnapshotSha256(inventory);
  const policyHash = safetyPolicySha256(constraints);
  const evaluationWithoutHash = {
    meal,
    householdId,
    plannedFor,
    participants,
    requiredServings,
    leftoverServingsUsed,
    servingsToCook,
    hardConstraintIds: applicableConstraints.map((constraint) => constraint.id),
    blockedReasons: Array.from(new Set(blockedReasons)).sort(),
    preferenceScore,
    requiredInventoryChecks: Array.from(requiredInventoryChecks).sort(),
    shoppingDelta: shoppingDelta.sort((left, right) =>
      left.itemId.localeCompare(right.itemId),
    ),
    inventorySnapshotSha256: inventoryHash,
    safetyPolicySha256: policyHash,
  };
  return {
    ...evaluationWithoutHash,
    contentSha256: sha256(evaluationWithoutHash),
  };
}

export function assertMealPlanSafe(
  evaluation: MealPlanEvaluation,
): MealPlanEvaluation {
  if (evaluation.blockedReasons.length > 0) {
    throw new FoodDomainError(
      "Meal plan violates one or more hard food constraints",
      "FOOD_UNSAFE_MEAL",
      {
        mealId: evaluation.meal.mealId,
        blockedReasons: evaluation.blockedReasons,
      },
    );
  }
  return evaluation;
}

export function buildShoppingListContent(
  evaluation: MealPlanEvaluation,
): FoodShoppingListContent {
  assertMealPlanSafe(evaluation);
  if (evaluation.requiredInventoryChecks.length > 0) {
    throw new FoodDomainError(
      "Likely inventory must be confirmed before creating a shopping handoff",
      "FOOD_STALE_SOURCE",
      {
        mealId: evaluation.meal.mealId,
        requiredInventoryChecks: evaluation.requiredInventoryChecks,
      },
    );
  }
  if (evaluation.shoppingDelta.length === 0) {
    throw new FoodDomainError(
      "A shopping handoff requires at least one missing item",
      "FOOD_INVALID_CONTRACT",
      { mealId: evaluation.meal.mealId },
    );
  }
  const contentWithoutHash = {
    householdId: evaluation.householdId,
    title: `${evaluation.meal.title} shopping list`,
    lines: evaluation.shoppingDelta,
    safetyConstraintIds: evaluation.hardConstraintIds,
    safetyPolicySha256: evaluation.safetyPolicySha256,
    inventorySnapshotSha256: evaluation.inventorySnapshotSha256,
    sourceMealPlanSha256: evaluation.contentSha256,
    // Product matching happens after this API boundary, so label review remains
    // mandatory even when the source recipe itself passed deterministic policy.
    requiresHumanLabelReview: true as const,
  };
  return {
    ...contentWithoutHash,
    contentSha256: sha256(contentWithoutHash),
  };
}

export function evaluateSubstitution(input: {
  original: ProductSafetyFacts;
  candidate: ProductSafetyFacts;
  policy: SubstitutionPolicy;
  constraints: HardFoodConstraint[];
  participantEntityIds: string[];
}): SubstitutionDecision {
  if (!SUBSTITUTION_POLICIES.some((policy) => policy === input.policy)) {
    throw new FoodDomainError(
      "Substitution policy is invalid",
      "FOOD_INVALID_CONTRACT",
      { policy: input.policy },
    );
  }
  const participantIds = new Set(
    input.participantEntityIds.map((entityId) =>
      normalizeIdentifier(entityId, "participantEntityIds"),
    ),
  );
  const constraints = input.constraints
    .map(validateConstraint)
    .filter((constraint) => constraintApplies(constraint, participantIds));
  if (
    input.candidate.labelEvidence !== "provider_verified_label" &&
    input.candidate.labelEvidence !== "human_verified_label" &&
    input.candidate.labelEvidence !== "unknown"
  ) {
    throw new FoodDomainError(
      "Candidate product label evidence is invalid",
      "FOOD_INVALID_CONTRACT",
    );
  }
  const exactIdentifier =
    input.original.upc !== null &&
    input.candidate.upc !== null &&
    input.original.upc === input.candidate.upc;
  if (input.candidate.labelEvidence === "unknown" && constraints.length > 0) {
    return {
      outcome: "block",
      reasons: [
        "Candidate product label is not verified for a constrained household member",
      ],
      constraintIds: constraints.map((constraint) => constraint.id),
    };
  }
  const tags = new Set([
    ...input.candidate.allergenTags.map((tag) =>
      tag.toLocaleLowerCase("en-US"),
    ),
    ...input.candidate.dietaryTags.map((tag) => tag.toLocaleLowerCase("en-US")),
    ...input.candidate.ageRiskTags.map((tag) => tag.toLocaleLowerCase("en-US")),
  ]);
  const violated = matchingConstraintTags(constraints, tags);
  if (violated.length > 0) {
    return {
      outcome: "block",
      reasons: ["Candidate product violates a hard food constraint"],
      constraintIds: violated.map((constraint) => constraint.id),
    };
  }
  if (exactIdentifier) {
    return { outcome: "allow_exact", reasons: [], constraintIds: [] };
  }
  if (input.policy === "never" || input.policy === "exact_identifier_only") {
    return {
      outcome: "block",
      reasons: ["Substitution policy requires the exact product identifier"],
      constraintIds: [],
    };
  }
  return {
    outcome: "requires_renewed_approval",
    reasons: [
      "A different product requires review of its exact label and a renewed approval",
    ],
    constraintIds: constraints.map((constraint) => constraint.id),
  };
}

export function validateConstraint(
  constraint: HardFoodConstraint,
): HardFoodConstraint {
  if (typeof constraint.active !== "boolean") {
    throw new FoodDomainError(
      "constraint.active must be boolean",
      "FOOD_INVALID_CONTRACT",
      { constraintId: constraint.id },
    );
  }
  if (!isHardFoodConstraintKind(constraint.kind)) {
    throw new FoodDomainError(
      `Unsupported hard food constraint kind: ${constraint.kind}`,
      "FOOD_INVALID_CONTRACT",
      { kind: constraint.kind },
    );
  }
  const excludedTags = normalizeTags(
    constraint.excludedTags,
    "constraint.excludedTags",
  );
  if (excludedTags.length === 0) {
    throw new FoodDomainError(
      "Hard food constraints require at least one excluded tag",
      "FOOD_INVALID_CONTRACT",
      { constraintId: constraint.id },
    );
  }
  return {
    ...constraint,
    id: normalizeIdentifier(constraint.id, "constraint.id"),
    householdId: normalizeIdentifier(
      constraint.householdId,
      "constraint.householdId",
    ),
    appliesToEntityId:
      constraint.appliesToEntityId === null
        ? null
        : normalizeIdentifier(
            constraint.appliesToEntityId,
            "constraint.appliesToEntityId",
          ),
    excludedTags,
    label: assertNonEmptyText(constraint.label, "constraint.label", 200),
    version: assertNonNegativeInteger(constraint.version, "constraint.version"),
    provenance: normalizeFoodProvenance(constraint.provenance),
  };
}

export function validatePreference(preference: FoodPreference): FoodPreference {
  if (typeof preference.active !== "boolean") {
    throw new FoodDomainError(
      "preference.active must be boolean",
      "FOOD_INVALID_CONTRACT",
      { preferenceId: preference.id },
    );
  }
  if (
    !Number.isFinite(preference.weight) ||
    preference.weight < 0 ||
    preference.weight > 10
  ) {
    throw new FoodDomainError(
      "preference.weight must be between zero and ten",
      "FOOD_INVALID_CONTRACT",
      { preferenceId: preference.id },
    );
  }
  return {
    ...preference,
    id: normalizeIdentifier(preference.id, "preference.id"),
    householdId: normalizeIdentifier(
      preference.householdId,
      "preference.householdId",
    ),
    appliesToEntityId:
      preference.appliesToEntityId === null
        ? null
        : normalizeIdentifier(
            preference.appliesToEntityId,
            "preference.appliesToEntityId",
          ),
    preferredTags: normalizeTags(
      preference.preferredTags,
      "preference.preferredTags",
    ),
    avoidedTags: normalizeTags(
      preference.avoidedTags,
      "preference.avoidedTags",
    ),
    version: assertNonNegativeInteger(preference.version, "preference.version"),
    provenance: normalizeFoodProvenance(preference.provenance),
  };
}

export function validateInventoryLot(
  lot: Omit<InventoryLot, "rowVersion" | "updatedAt">,
): Omit<InventoryLot, "rowVersion" | "updatedAt"> {
  if (!isFoodUnit(lot.unit)) {
    throw new FoodDomainError(
      `Unsupported inventory unit: ${lot.unit}`,
      "FOOD_INVALID_CONTRACT",
      { unit: lot.unit },
    );
  }
  if (!isInventoryConfidenceState(lot.confidence)) {
    throw new FoodDomainError(
      `Unsupported inventory confidence state: ${lot.confidence}`,
      "FOOD_INVALID_CONTRACT",
      { confidence: lot.confidence },
    );
  }
  const quantity =
    lot.confidence === "confirmed_on_hand" ||
    lot.confidence === "likely_on_hand"
      ? assertPositiveQuantity(lot.quantity, "inventory.quantity")
      : (() => {
          if (
            !Number.isFinite(lot.quantity) ||
            lot.quantity < 0 ||
            lot.quantity > 1_000_000
          ) {
            throw new FoodDomainError(
              "inventory.quantity must be between zero and 1,000,000",
              "FOOD_INVALID_CONTRACT",
              { quantity: lot.quantity },
            );
          }
          return roundFoodQuantity(lot.quantity);
        })();
  if (lot.confidence === "confirmed_absent" && quantity !== 0) {
    throw new FoodDomainError(
      "confirmed_absent inventory observations must have zero quantity",
      "FOOD_INVALID_CONTRACT",
      { lotId: lot.lotId },
    );
  }
  const expiresAt =
    lot.expiresAt === null
      ? null
      : assertIsoTimestamp(lot.expiresAt, "inventory.expiresAt");
  return {
    ...lot,
    lotId: normalizeIdentifier(lot.lotId, "inventory.lotId"),
    householdId: normalizeIdentifier(lot.householdId, "inventory.householdId"),
    itemId: normalizeIdentifier(lot.itemId, "inventory.itemId"),
    name: assertNonEmptyText(lot.name, "inventory.name", 200),
    quantity,
    expiresAt,
    allergenTags: normalizeTags(lot.allergenTags, "inventory.allergenTags"),
    dietaryTags: normalizeTags(lot.dietaryTags, "inventory.dietaryTags"),
    provenance: normalizeFoodProvenance(lot.provenance),
  };
}
