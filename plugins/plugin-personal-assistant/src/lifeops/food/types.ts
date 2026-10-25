/**
 * Typed food-domain contracts keep meal suggestions separate from the safety,
 * inventory, approval, and provider facts that must be deterministic. Every
 * person reference is an existing knowledge-graph entity; these records do not
 * create a parallel household identity graph.
 */
import { ElizaError } from "@elizaos/core";

export const FOOD_UNITS = [
  "serving",
  "each",
  "package",
  "can",
  "bunch",
  "head",
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "cup",
  "tbsp",
  "tsp",
] as const;
export type FoodUnit = (typeof FOOD_UNITS)[number];

export const INVENTORY_CONFIDENCE_STATES = [
  "confirmed_on_hand",
  "likely_on_hand",
  "low",
  "unknown",
  "confirmed_absent",
] as const;
export type InventoryConfidenceState =
  (typeof INVENTORY_CONFIDENCE_STATES)[number];

export const FOOD_PROVENANCE_KINDS = [
  "user_confirmed",
  "receipt",
  "order",
  "consumption_inference",
  "document",
  "connector",
] as const;
export type FoodProvenanceKind = (typeof FOOD_PROVENANCE_KINDS)[number];

export interface FoodProvenance {
  kind: FoodProvenanceKind;
  sourceId: string;
  sourceRevision: number;
  observedAt: string;
  evidenceRef: string;
  confidence: number;
}

export const HARD_FOOD_CONSTRAINT_KINDS = [
  "allergen_exclusion",
  "cross_contact_exclusion",
  "medical_diet",
  "age_safety",
  "religious_diet",
  "ethical_diet",
] as const;
export type HardFoodConstraintKind =
  (typeof HARD_FOOD_CONSTRAINT_KINDS)[number];

export interface HardFoodConstraint {
  id: string;
  householdId: string;
  appliesToEntityId: string | null;
  kind: HardFoodConstraintKind;
  excludedTags: string[];
  label: string;
  version: number;
  provenance: FoodProvenance;
  active: boolean;
}

export interface FoodPreference {
  id: string;
  householdId: string;
  appliesToEntityId: string | null;
  preferredTags: string[];
  avoidedTags: string[];
  weight: number;
  version: number;
  provenance: FoodProvenance;
  active: boolean;
}

export interface FoodHouseholdProfile {
  householdId: string;
  memberEntityIds: string[];
  version: number;
  updatedAt: string;
}

export interface MealParticipant {
  entityId: string;
  portionServings: number;
  attendanceProvenance: FoodProvenance;
}

export interface MealIngredient {
  itemId: string;
  name: string;
  quantity: number;
  unit: FoodUnit;
  dietaryTags: string[];
  allergenTags: string[];
  ageRiskTags: string[];
  safetyEvidence: "verified_label" | "recipe_source" | "unknown";
  upcs: string[];
  brandFilters: string[];
}

export interface MealCandidate {
  mealId: string;
  title: string;
  baseServings: number;
  ingredients: MealIngredient[];
  tags: string[];
  leftoverInventoryItemId: string | null;
}

export interface InventoryLot {
  lotId: string;
  householdId: string;
  itemId: string;
  name: string;
  quantity: number;
  unit: FoodUnit;
  confidence: InventoryConfidenceState;
  expiresAt: string | null;
  allergenTags: string[];
  dietaryTags: string[];
  provenance: FoodProvenance;
  rowVersion: number;
  updatedAt: string;
}

export interface InventoryObservation {
  lot: Omit<InventoryLot, "rowVersion" | "updatedAt">;
}

export interface ShoppingDeltaLine {
  itemId: string;
  name: string;
  quantity: number;
  unit: FoodUnit;
  upcs: string[];
  brandFilters: string[];
  allergenTags: string[];
  dietaryTags: string[];
  conditionalOnInventoryCheck: boolean;
}

export interface MealPlanEvaluation {
  meal: MealCandidate;
  householdId: string;
  plannedFor: string;
  participants: MealParticipant[];
  requiredServings: number;
  leftoverServingsUsed: number;
  servingsToCook: number;
  hardConstraintIds: string[];
  blockedReasons: string[];
  preferenceScore: number;
  requiredInventoryChecks: string[];
  shoppingDelta: ShoppingDeltaLine[];
  inventorySnapshotSha256: string;
  safetyPolicySha256: string;
  contentSha256: string;
}

export const SUBSTITUTION_POLICIES = [
  "never",
  "exact_identifier_only",
  "safe_equivalent_with_renewed_approval",
] as const;
export type SubstitutionPolicy = (typeof SUBSTITUTION_POLICIES)[number];

export interface ProductSafetyFacts {
  productRef: string;
  itemId: string;
  name: string;
  upc: string | null;
  allergenTags: string[];
  dietaryTags: string[];
  ageRiskTags: string[];
  labelEvidence: "provider_verified_label" | "human_verified_label" | "unknown";
}

export interface SubstitutionDecision {
  outcome: "allow_exact" | "requires_renewed_approval" | "block";
  reasons: string[];
  constraintIds: string[];
}

export interface FoodShoppingListContent {
  householdId: string;
  title: string;
  lines: ShoppingDeltaLine[];
  safetyConstraintIds: string[];
  safetyPolicySha256: string;
  inventorySnapshotSha256: string;
  sourceMealPlanSha256: string;
  requiresHumanLabelReview: boolean;
  contentSha256: string;
}

export const FOOD_HANDOFF_STATES = [
  "awaiting_approval",
  "creating_link",
  "link_created",
  "blocked",
  "ambiguous",
] as const;
export type FoodHandoffState = (typeof FOOD_HANDOFF_STATES)[number];

export interface FoodShoppingHandoff {
  handoffId: string;
  agentId: string;
  householdId: string;
  requestedByEntityId: string;
  idempotencyKey: string;
  content: FoodShoppingListContent;
  contentSha256: string;
  state: FoodHandoffState;
  approvalRequestId: string | null;
  provider: "instacart";
  providerLinkUrl: string | null;
  providerResultKind: "shopping_list_link" | null;
  attemptToken: string | null;
  leaseExpiresAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PublishedMealPlan {
  planId: string;
  agentId: string;
  householdId: string;
  mealDate: string;
  title: string;
  attendeeEntityIds: string[];
  evaluation: MealPlanEvaluation;
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChildMealPlanView {
  planId: string;
  mealDate: string;
  title: string;
  attending: boolean;
}

export interface FoodOwnerView {
  profile: FoodHouseholdProfile;
  constraints: HardFoodConstraint[];
  preferences: FoodPreference[];
  inventory: InventoryLot[];
  mealPlans: PublishedMealPlan[];
  handoffs: FoodShoppingHandoff[];
}

export interface FoodChildView {
  householdId: string;
  principalEntityId: string;
  meals: ChildMealPlanView[];
}

export type FoodView = FoodOwnerView | FoodChildView;

export type FoodErrorCode =
  | "FOOD_ACCESS_DENIED"
  | "FOOD_APPROVAL_MISMATCH"
  | "FOOD_APPROVAL_REQUIRED"
  | "FOOD_ENTITY_NOT_FOUND"
  | "FOOD_HANDOFF_AMBIGUOUS"
  | "FOOD_HANDOFF_BUSY"
  | "FOOD_IDEMPOTENCY_CONFLICT"
  | "FOOD_INVALID_CONTRACT"
  | "FOOD_INVENTORY_CONFLICT"
  | "FOOD_PROVIDER_RATE_LIMITED"
  | "FOOD_PROVIDER_REJECTED"
  | "FOOD_PROVIDER_RESPONSE_INVALID"
  | "FOOD_PROVIDER_UNAVAILABLE"
  | "FOOD_RELATIONSHIP_REQUIRED"
  | "FOOD_STALE_SOURCE"
  | "FOOD_UNSAFE_MEAL";

export class FoodDomainError extends ElizaError {
  override readonly name = "FoodDomainError";

  constructor(
    message: string,
    code: FoodErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity:
        code === "FOOD_INVALID_CONTRACT" ||
        code === "FOOD_PROVIDER_RESPONSE_INVALID"
          ? "fatal"
          : "ephemeral",
    });
  }
}

export function isFoodUnit(value: string): value is FoodUnit {
  return FOOD_UNITS.some((unit) => unit === value);
}

export function isInventoryConfidenceState(
  value: string,
): value is InventoryConfidenceState {
  return INVENTORY_CONFIDENCE_STATES.some((state) => state === value);
}

export function isFoodProvenanceKind(
  value: string,
): value is FoodProvenanceKind {
  return FOOD_PROVENANCE_KINDS.some((kind) => kind === value);
}

export function isHardFoodConstraintKind(
  value: string,
): value is HardFoodConstraintKind {
  return HARD_FOOD_CONSTRAINT_KINDS.some((kind) => kind === value);
}

export function isFoodHandoffState(value: string): value is FoodHandoffState {
  return FOOD_HANDOFF_STATES.some((state) => state === value);
}

export function assertNonEmptyText(
  value: string,
  field: string,
  maxLength = 512,
): string {
  const normalized = value.trim();
  const hasDisallowedControlCharacter = Array.from(normalized).some(
    (character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        ((codePoint >= 0 && codePoint <= 8) ||
          codePoint === 11 ||
          codePoint === 12 ||
          (codePoint >= 14 && codePoint <= 31) ||
          codePoint === 127)
      );
    },
  );
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    hasDisallowedControlCharacter
  ) {
    throw new FoodDomainError(
      `${field} must be non-empty printable text no longer than ${maxLength} characters`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return normalized;
}

export function assertPositiveQuantity(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new FoodDomainError(
      `${field} must be greater than zero and no more than 1,000,000`,
      "FOOD_INVALID_CONTRACT",
      { field, value },
    );
  }
  return roundFoodQuantity(value);
}

export function assertConfidence(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new FoodDomainError(
      `${field} must be between zero and one`,
      "FOOD_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value;
}

export function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new FoodDomainError(
      `${field} must be a non-negative integer`,
      "FOOD_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value;
}

export function assertIsoTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new FoodDomainError(
      `${field} must be an ISO-8601 timestamp`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return new Date(timestamp).toISOString();
}

export function normalizeTags(
  tags: readonly string[],
  field: string,
): string[] {
  if (tags.length > 100) {
    throw new FoodDomainError(
      `${field} may contain at most 100 tags`,
      "FOOD_INVALID_CONTRACT",
      { field, count: tags.length },
    );
  }
  return Array.from(
    new Set(
      tags.map((tag) =>
        assertNonEmptyText(tag, field, 80).toLocaleLowerCase("en-US"),
      ),
    ),
  ).sort();
}

export function roundFoodQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
