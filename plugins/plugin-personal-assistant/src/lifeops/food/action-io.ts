/**
 * Shape boundary between planner-supplied JSON and the typed food domain.
 * The planner emits untrusted structures, so every field is narrowed to its
 * JavaScript type here before the domain validators (validateConstraint,
 * normalizeMealCandidate, ...) enforce semantic invariants. Without this pass
 * a malformed planner object would surface as a bare TypeError instead of a
 * typed FOOD_INVALID_CONTRACT rejection the planner can act on.
 */
import {
  normalizeFoodProvenance,
  normalizeMealCandidate,
  normalizeParticipants,
  validateConstraint,
  validateInventoryLot,
  validatePreference,
} from "./planner.js";
import {
  FoodDomainError,
  type FoodPreference,
  type FoodProvenance,
  type HardFoodConstraint,
  type HardFoodConstraintKind,
  type InventoryConfidenceState,
  type InventoryObservation,
  isFoodUnit,
  isHardFoodConstraintKind,
  isInventoryConfidenceState,
  type MealCandidate,
  type MealIngredient,
  type MealParticipant,
} from "./types.js";

function invalid(field: string, expected: string): never {
  throw new FoodDomainError(
    `${field} must be ${expected}`,
    "FOOD_INVALID_CONTRACT",
    { field },
  );
}

function foodRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "an object");
  }
  return value as Record<string, unknown>;
}

function foodArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(field, "an array");
  }
  return value;
}

export function foodText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    invalid(field, "a string");
  }
  return value;
}

function foodNullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return foodText(value, field);
}

function foodNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    invalid(field, "a number");
  }
  return value;
}

export function foodInteger(value: unknown, field: string): number {
  const numeric = foodNumber(value, field);
  if (!Number.isInteger(numeric)) {
    invalid(field, "an integer");
  }
  return numeric;
}

function foodBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    invalid(field, "a boolean");
  }
  return value;
}

export function foodStringArray(value: unknown, field: string): string[] {
  return foodArray(value, field).map((entry, index) =>
    foodText(entry, `${field}[${index}]`),
  );
}

function provenanceInput(value: unknown, field: string): FoodProvenance {
  const record = foodRecord(value, field);
  return normalizeFoodProvenance({
    kind: foodText(record.kind, `${field}.kind`) as FoodProvenance["kind"],
    sourceId: foodText(record.sourceId, `${field}.sourceId`),
    sourceRevision: foodInteger(
      record.sourceRevision,
      `${field}.sourceRevision`,
    ),
    observedAt: foodText(record.observedAt, `${field}.observedAt`),
    evidenceRef: foodText(record.evidenceRef, `${field}.evidenceRef`),
    confidence: foodNumber(record.confidence, `${field}.confidence`),
  });
}

export function normalizeHardFoodConstraintInput(
  value: unknown,
): HardFoodConstraint {
  const record = foodRecord(value, "constraint");
  const kind = foodText(record.kind, "constraint.kind");
  if (!isHardFoodConstraintKind(kind)) {
    invalid("constraint.kind", "a supported hard-constraint kind");
  }
  return validateConstraint({
    id: foodText(record.id, "constraint.id"),
    householdId: foodText(record.householdId, "constraint.householdId"),
    appliesToEntityId: foodNullableText(
      record.appliesToEntityId,
      "constraint.appliesToEntityId",
    ),
    kind: kind as HardFoodConstraintKind,
    excludedTags: foodStringArray(
      record.excludedTags,
      "constraint.excludedTags",
    ),
    label: foodText(record.label, "constraint.label"),
    version: foodInteger(record.version, "constraint.version"),
    provenance: provenanceInput(record.provenance, "constraint.provenance"),
    active: foodBoolean(record.active, "constraint.active"),
  });
}

export function normalizeFoodPreferenceInput(value: unknown): FoodPreference {
  const record = foodRecord(value, "preference");
  return validatePreference({
    id: foodText(record.id, "preference.id"),
    householdId: foodText(record.householdId, "preference.householdId"),
    appliesToEntityId: foodNullableText(
      record.appliesToEntityId,
      "preference.appliesToEntityId",
    ),
    preferredTags: foodStringArray(
      record.preferredTags,
      "preference.preferredTags",
    ),
    avoidedTags: foodStringArray(record.avoidedTags, "preference.avoidedTags"),
    weight: foodNumber(record.weight, "preference.weight"),
    version: foodInteger(record.version, "preference.version"),
    provenance: provenanceInput(record.provenance, "preference.provenance"),
    active: foodBoolean(record.active, "preference.active"),
  });
}

export function normalizeInventoryObservationInput(
  value: unknown,
): InventoryObservation {
  const record = foodRecord(value, "lot");
  const unit = foodText(record.unit, "lot.unit");
  if (!isFoodUnit(unit)) {
    invalid("lot.unit", "a supported food unit");
  }
  const confidence = foodText(record.confidence, "lot.confidence");
  if (!isInventoryConfidenceState(confidence)) {
    invalid("lot.confidence", "a supported inventory confidence state");
  }
  return {
    lot: validateInventoryLot({
      lotId: foodText(record.lotId, "lot.lotId"),
      householdId: foodText(record.householdId, "lot.householdId"),
      itemId: foodText(record.itemId, "lot.itemId"),
      name: foodText(record.name, "lot.name"),
      quantity: foodNumber(record.quantity, "lot.quantity"),
      unit: unit as InventoryObservation["lot"]["unit"],
      confidence: confidence as InventoryConfidenceState,
      expiresAt: foodNullableText(record.expiresAt, "lot.expiresAt"),
      allergenTags: foodStringArray(record.allergenTags, "lot.allergenTags"),
      dietaryTags: foodStringArray(record.dietaryTags, "lot.dietaryTags"),
      provenance: provenanceInput(record.provenance, "lot.provenance"),
    }),
  };
}

const MEAL_SAFETY_EVIDENCE = [
  "verified_label",
  "recipe_source",
  "unknown",
] as const;

function ingredientInput(value: unknown, field: string): MealIngredient {
  const record = foodRecord(value, field);
  const unit = foodText(record.unit, `${field}.unit`);
  if (!isFoodUnit(unit)) {
    invalid(`${field}.unit`, "a supported food unit");
  }
  const safetyEvidence = foodText(
    record.safetyEvidence,
    `${field}.safetyEvidence`,
  );
  if (
    !MEAL_SAFETY_EVIDENCE.includes(
      safetyEvidence as MealIngredient["safetyEvidence"],
    )
  ) {
    invalid(`${field}.safetyEvidence`, "a supported safety-evidence state");
  }
  return {
    itemId: foodText(record.itemId, `${field}.itemId`),
    name: foodText(record.name, `${field}.name`),
    quantity: foodNumber(record.quantity, `${field}.quantity`),
    unit: unit as MealIngredient["unit"],
    dietaryTags: foodStringArray(record.dietaryTags, `${field}.dietaryTags`),
    allergenTags: foodStringArray(record.allergenTags, `${field}.allergenTags`),
    ageRiskTags: foodStringArray(record.ageRiskTags, `${field}.ageRiskTags`),
    safetyEvidence: safetyEvidence as MealIngredient["safetyEvidence"],
    upcs: foodStringArray(record.upcs, `${field}.upcs`),
    brandFilters: foodStringArray(record.brandFilters, `${field}.brandFilters`),
  };
}

export function normalizeMealCandidateInput(value: unknown): MealCandidate {
  const record = foodRecord(value, "meal");
  return normalizeMealCandidate({
    mealId: foodText(record.mealId, "meal.mealId"),
    title: foodText(record.title, "meal.title"),
    baseServings: foodNumber(record.baseServings, "meal.baseServings"),
    ingredients: foodArray(record.ingredients, "meal.ingredients").map(
      (entry, index) => ingredientInput(entry, `meal.ingredients[${index}]`),
    ),
    tags: foodStringArray(record.tags, "meal.tags"),
    leftoverInventoryItemId: foodNullableText(
      record.leftoverInventoryItemId,
      "meal.leftoverInventoryItemId",
    ),
  });
}

export function normalizeMealParticipantsInput(
  value: unknown,
): MealParticipant[] {
  return normalizeParticipants(
    foodArray(value, "participants").map((entry, index) => {
      const record = foodRecord(entry, `participants[${index}]`);
      return {
        entityId: foodText(record.entityId, `participants[${index}].entityId`),
        portionServings: foodNumber(
          record.portionServings,
          `participants[${index}].portionServings`,
        ),
        attendanceProvenance: provenanceInput(
          record.attendanceProvenance,
          `participants[${index}].attendanceProvenance`,
        ),
      };
    }),
  );
}
