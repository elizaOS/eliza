/**
 * Planner-facing JSON Schema for the nested HOUSEHOLD_FOOD parameters.
 *
 * Mirrors the shape action-io.ts narrows, so validateToolArgs reports every
 * missing field and every allowed enum value before the handler runs, and the
 * tool schema shows the planner the contract instead of a bare object. Enum
 * values come from types.ts; semantic rules (tag limits, timestamp parsing,
 * quantity ranges) stay in the domain validators.
 */
import type { ActionParameterSchema } from "@elizaos/core";
import {
  FOOD_PROVENANCE_KINDS,
  FOOD_UNITS,
  HARD_FOOD_CONSTRAINT_KINDS,
  INVENTORY_CONFIDENCE_STATES,
} from "./types.js";

const text = (description?: string): ActionParameterSchema => ({
  type: "string",
  minLength: 1,
  ...(description ? { description } : {}),
});

const tags = (description?: string): ActionParameterSchema => ({
  type: "array",
  items: { type: "string", minLength: 1 },
  ...(description ? { description } : {}),
});

const nullableText = (description: string): ActionParameterSchema => ({
  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
  description,
});

/** Closed object whose every declared property is required unless listed. */
function record(
  properties: Record<string, ActionParameterSchema>,
  optional: readonly string[] = [],
): ActionParameterSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  };
}

const unit: ActionParameterSchema = { type: "string", enum: [...FOOD_UNITS] };

const provenance = record({
  kind: { type: "string", enum: [...FOOD_PROVENANCE_KINDS] },
  sourceId: text("Stable identifier of the source that asserted this fact."),
  sourceRevision: { type: "integer", minimum: 0 },
  observedAt: text("ISO-8601 timestamp the source was observed."),
  evidenceRef: text("Reference to the evidence, e.g. a message or receipt id."),
  confidence: { type: "number", minimum: 0, maximum: 1 },
});

const appliesToEntityId = nullableText(
  "Knowledge-graph entity ID of the one household member this applies to; null or omitted applies it to the whole household.",
);

export const FOOD_CONSTRAINT_SCHEMA = record(
  {
    id: text("Stable constraint identifier."),
    householdId: text(),
    appliesToEntityId,
    kind: { type: "string", enum: [...HARD_FOOD_CONSTRAINT_KINDS] },
    excludedTags: tags("Ingredient/allergen tags the constraint excludes."),
    label: text("Owner-visible name of the constraint."),
    version: { type: "integer", minimum: 0 },
    provenance,
    active: { type: "boolean" },
  },
  ["appliesToEntityId"],
);

export const FOOD_PREFERENCE_SCHEMA = record(
  {
    id: text("Stable preference identifier."),
    householdId: text(),
    appliesToEntityId,
    preferredTags: tags(),
    avoidedTags: tags(),
    weight: { type: "number", minimum: 0, maximum: 10 },
    version: { type: "integer", minimum: 0 },
    provenance,
    active: { type: "boolean" },
  },
  ["appliesToEntityId"],
);

export const FOOD_INVENTORY_LOT_SCHEMA = record(
  {
    lotId: text("Stable inventory lot identifier."),
    householdId: text(),
    itemId: text("Stable pantry item identifier."),
    name: text(),
    quantity: { type: "number", minimum: 0 },
    unit,
    confidence: { type: "string", enum: [...INVENTORY_CONFIDENCE_STATES] },
    expiresAt: nullableText("ISO-8601 expiry timestamp, or null when unknown."),
    allergenTags: tags(),
    dietaryTags: tags(),
    provenance,
  },
  ["expiresAt"],
);

const ingredient = record({
  itemId: text("Stable pantry item identifier."),
  name: text(),
  quantity: { type: "number" },
  unit,
  dietaryTags: tags(),
  allergenTags: tags(),
  ageRiskTags: tags(),
  safetyEvidence: {
    type: "string",
    enum: ["verified_label", "recipe_source", "unknown"],
  },
  upcs: tags(),
  brandFilters: tags(),
});

export const FOOD_MEAL_SCHEMA = record(
  {
    mealId: text("Stable meal identifier."),
    title: text(),
    baseServings: { type: "number" },
    ingredients: { type: "array", items: ingredient },
    tags: tags(),
    leftoverInventoryItemId: nullableText(
      "Pantry item ID of leftovers this meal uses, or null.",
    ),
  },
  ["leftoverInventoryItemId"],
);

export const FOOD_PARTICIPANTS_SCHEMA: ActionParameterSchema = {
  type: "array",
  items: record({
    entityId: text("Knowledge-graph entity ID of the attending member."),
    portionServings: { type: "number" },
    attendanceProvenance: provenance,
  }),
};
