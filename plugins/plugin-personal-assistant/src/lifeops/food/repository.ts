/**
 * PostgreSQL persistence for food profiles, policies, inventory observations,
 * published plans, and approval-bound shopping handoffs. Entity identity and
 * household relationships remain in the runtime knowledge graph; this store
 * holds only food-domain projections that reference those canonical IDs.
 */
import crypto from "node:crypto";
import { type IAgentRuntime, stableStringify } from "@elizaos/core";
import { z } from "zod";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlJson,
  sqlQuote,
  withRequiredTransaction,
} from "../sql.js";
import {
  inventorySnapshotSha256,
  safetyPolicySha256,
  validateConstraint,
  validateInventoryLot,
  validatePreference,
} from "./planner.js";
import {
  assertIsoTimestamp,
  assertNonEmptyText,
  assertNonNegativeInteger,
  FOOD_PROVENANCE_KINDS,
  FOOD_UNITS,
  FoodDomainError,
  type FoodHandoffState,
  type FoodHouseholdProfile,
  type FoodPreference,
  type FoodShoppingHandoff,
  type FoodShoppingListContent,
  HARD_FOOD_CONSTRAINT_KINDS,
  type HardFoodConstraint,
  INVENTORY_CONFIDENCE_STATES,
  type InventoryLot,
  type InventoryObservation,
  isFoodHandoffState,
  type PublishedMealPlan,
} from "./types.js";

const FOOD_SCHEMA_STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_households (
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     member_entity_ids_json TEXT NOT NULL,
     version INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, household_id)
   )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_constraints (
     agent_id TEXT NOT NULL,
     constraint_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     value_json TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, constraint_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_food_constraints_household_idx
     ON app_lifeops.life_food_constraints (agent_id, household_id)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_preferences (
     agent_id TEXT NOT NULL,
     preference_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     value_json TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, preference_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_food_preferences_household_idx
     ON app_lifeops.life_food_preferences (agent_id, household_id)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_inventory_observations (
     observation_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     lot_id TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_id TEXT NOT NULL,
     source_revision INTEGER NOT NULL,
     observed_at TEXT NOT NULL,
     payload_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (agent_id, source_kind, source_id, source_revision, lot_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_food_inventory_observations_lot_idx
     ON app_lifeops.life_food_inventory_observations
       (agent_id, household_id, lot_id, observed_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_inventory_lots (
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     lot_id TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_id TEXT NOT NULL,
     source_revision INTEGER NOT NULL,
     observed_at TEXT NOT NULL,
     value_json TEXT NOT NULL,
     row_version INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, household_id, lot_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_food_inventory_item_idx
     ON app_lifeops.life_food_inventory_lots (agent_id, household_id)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_meal_plans (
     agent_id TEXT NOT NULL,
     plan_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     meal_date TEXT NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, plan_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_food_meal_plans_household_idx
     ON app_lifeops.life_food_meal_plans (agent_id, household_id, meal_date)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_food_handoffs (
     handoff_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     requested_by_entity_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     content_sha256 TEXT NOT NULL,
     content_json TEXT NOT NULL,
     state TEXT NOT NULL,
     approval_request_id TEXT,
     provider TEXT NOT NULL,
     provider_link_url TEXT,
     provider_result_kind TEXT,
     attempt_token TEXT,
     lease_expires_at TEXT,
     failure_code TEXT,
     version INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (agent_id, idempotency_key),
     UNIQUE (agent_id, content_sha256)
   )`,
  `CREATE INDEX IF NOT EXISTS life_food_handoffs_household_idx
     ON app_lifeops.life_food_handoffs (agent_id, household_id, created_at)`,
] as const;

const PROVENANCE_AUTHORITY: Readonly<Record<string, number>> = {
  user_confirmed: 60,
  receipt: 50,
  order: 40,
  connector: 30,
  document: 20,
  consumption_inference: 10,
};

function stableSha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

const provenanceSchema = z
  .object({
    kind: z.enum(FOOD_PROVENANCE_KINDS),
    sourceId: z.string(),
    sourceRevision: z.number(),
    observedAt: z.string(),
    evidenceRef: z.string(),
    confidence: z.number(),
  })
  .strict();

const constraintSchema = z
  .object({
    id: z.string(),
    householdId: z.string(),
    appliesToEntityId: z.string().nullable(),
    kind: z.enum(HARD_FOOD_CONSTRAINT_KINDS),
    excludedTags: z.array(z.string()),
    label: z.string(),
    version: z.number(),
    provenance: provenanceSchema,
    active: z.boolean(),
  })
  .strict();

const preferenceSchema = z
  .object({
    id: z.string(),
    householdId: z.string(),
    appliesToEntityId: z.string().nullable(),
    preferredTags: z.array(z.string()),
    avoidedTags: z.array(z.string()),
    weight: z.number(),
    version: z.number(),
    provenance: provenanceSchema,
    active: z.boolean(),
  })
  .strict();

const inventoryLotValueSchema = z
  .object({
    lotId: z.string(),
    householdId: z.string(),
    itemId: z.string(),
    name: z.string(),
    quantity: z.number(),
    unit: z.enum(FOOD_UNITS),
    confidence: z.enum(INVENTORY_CONFIDENCE_STATES),
    expiresAt: z.string().nullable(),
    allergenTags: z.array(z.string()),
    dietaryTags: z.array(z.string()),
    provenance: provenanceSchema,
  })
  .strict();

const mealIngredientSchema = z
  .object({
    itemId: z.string(),
    name: z.string(),
    quantity: z.number(),
    unit: z.enum(FOOD_UNITS),
    dietaryTags: z.array(z.string()),
    allergenTags: z.array(z.string()),
    ageRiskTags: z.array(z.string()),
    safetyEvidence: z.enum(["verified_label", "recipe_source", "unknown"]),
    upcs: z.array(z.string()),
    brandFilters: z.array(z.string()),
  })
  .strict();

const mealCandidateSchema = z
  .object({
    mealId: z.string(),
    title: z.string(),
    baseServings: z.number(),
    ingredients: z.array(mealIngredientSchema),
    tags: z.array(z.string()),
    leftoverInventoryItemId: z.string().nullable(),
  })
  .strict();

const mealParticipantSchema = z
  .object({
    entityId: z.string(),
    portionServings: z.number(),
    attendanceProvenance: provenanceSchema,
  })
  .strict();

const shoppingDeltaLineSchema = z
  .object({
    itemId: z.string(),
    name: z.string(),
    quantity: z.number(),
    unit: z.enum(FOOD_UNITS),
    upcs: z.array(z.string()),
    brandFilters: z.array(z.string()),
    allergenTags: z.array(z.string()),
    dietaryTags: z.array(z.string()),
    conditionalOnInventoryCheck: z.boolean(),
  })
  .strict();

const mealPlanEvaluationSchema = z
  .object({
    meal: mealCandidateSchema,
    householdId: z.string(),
    plannedFor: z.string(),
    participants: z.array(mealParticipantSchema),
    requiredServings: z.number(),
    leftoverServingsUsed: z.number(),
    servingsToCook: z.number(),
    hardConstraintIds: z.array(z.string()),
    blockedReasons: z.array(z.string()),
    preferenceScore: z.number(),
    requiredInventoryChecks: z.array(z.string()),
    shoppingDelta: z.array(shoppingDeltaLineSchema),
    inventorySnapshotSha256: z.string(),
    safetyPolicySha256: z.string(),
    contentSha256: z.string(),
  })
  .strict();

const shoppingListContentSchema = z
  .object({
    householdId: z.string(),
    title: z.string(),
    lines: z.array(shoppingDeltaLineSchema),
    safetyConstraintIds: z.array(z.string()),
    safetyPolicySha256: z.string(),
    inventorySnapshotSha256: z.string(),
    sourceMealPlanSha256: z.string(),
    requiresHumanLabelReview: z.boolean(),
    contentSha256: z.string(),
  })
  .strict();

const publishedMealPlanSchema = z
  .object({
    planId: z.string(),
    agentId: z.string(),
    householdId: z.string(),
    mealDate: z.string(),
    title: z.string(),
    attendeeEntityIds: z.array(z.string()),
    evaluation: mealPlanEvaluationSchema,
    contentSha256: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

function parsePersisted<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new FoodDomainError(
      `Persisted food row has invalid ${field}`,
      "FOOD_INVALID_CONTRACT",
      { field, issueCount: result.error.issues.length },
    );
  }
  return result.data;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FoodDomainError(
      `Persisted food row is missing ${field}`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new FoodDomainError(
      `Persisted food row has invalid ${field}`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FoodDomainError(
      `Persisted food row has invalid ${field}`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return parsed;
}

function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      // error-policy:J3 persisted JSON is untrusted input and malformed rows
      // surface as explicit invalid data rather than a fabricated empty value.
      throw new FoodDomainError(
        `Persisted food row has malformed ${field}`,
        "FOOD_INVALID_CONTRACT",
        { field },
        error,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FoodDomainError(
      `Persisted food row has invalid ${field}`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return parsed as Record<string, unknown>;
}

function parseStringArray(value: unknown, field: string): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      // error-policy:J3 persisted JSON is untrusted input and malformed rows
      // surface as explicit invalid data rather than a fabricated empty value.
      throw new FoodDomainError(
        `Persisted food row has malformed ${field}`,
        "FOOD_INVALID_CONTRACT",
        { field },
        error,
      );
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new FoodDomainError(
      `Persisted food row has invalid ${field}`,
      "FOOD_INVALID_CONTRACT",
      { field },
    );
  }
  return parsed as string[];
}

function constraintFromRow(row: Record<string, unknown>): HardFoodConstraint {
  const parsed = parseJsonObject(row.value_json, "constraint.value");
  return validateConstraint(
    parsePersisted(constraintSchema, parsed, "constraint.value"),
  );
}

function preferenceFromRow(row: Record<string, unknown>): FoodPreference {
  const parsed = parseJsonObject(row.value_json, "preference.value");
  return validatePreference(
    parsePersisted(preferenceSchema, parsed, "preference.value"),
  );
}

function inventoryLotFromRow(row: Record<string, unknown>): InventoryLot {
  const parsed = parseJsonObject(row.value_json, "inventory.value");
  const normalized = validateInventoryLot(
    parsePersisted(inventoryLotValueSchema, parsed, "inventory.value"),
  );
  return {
    ...normalized,
    rowVersion: requiredInteger(row.row_version, "inventory.rowVersion"),
    updatedAt: assertIsoTimestamp(
      requiredText(row.updated_at, "inventory.updatedAt"),
      "inventory.updatedAt",
    ),
  };
}

function publishedMealPlanFromRow(
  row: Record<string, unknown>,
): PublishedMealPlan {
  const parsed = parseJsonObject(row.value_json, "mealPlan.value");
  const plan = parsePersisted(
    publishedMealPlanSchema,
    parsed,
    "mealPlan.value",
  );
  const { contentSha256: evaluationContentSha256, ...evaluationWithoutHash } =
    plan.evaluation;
  if (
    evaluationContentSha256 !== stableSha256(evaluationWithoutHash) ||
    plan.contentSha256 !== evaluationContentSha256
  ) {
    throw new FoodDomainError(
      "Persisted meal plan content hash does not match its evaluation",
      "FOOD_INVALID_CONTRACT",
      { planId: plan.planId },
    );
  }
  return {
    ...plan,
    planId: requiredText(plan.planId, "mealPlan.planId"),
    agentId: requiredText(plan.agentId, "mealPlan.agentId"),
    householdId: requiredText(plan.householdId, "mealPlan.householdId"),
    mealDate: assertIsoTimestamp(plan.mealDate, "mealPlan.mealDate"),
    title: requiredText(plan.title, "mealPlan.title"),
    attendeeEntityIds: parseStringArray(
      plan.attendeeEntityIds,
      "mealPlan.attendeeEntityIds",
    ),
    contentSha256: requiredText(plan.contentSha256, "mealPlan.contentSha256"),
    createdAt: assertIsoTimestamp(plan.createdAt, "mealPlan.createdAt"),
    updatedAt: assertIsoTimestamp(plan.updatedAt, "mealPlan.updatedAt"),
  };
}

function handoffFromRow(row: Record<string, unknown>): FoodShoppingHandoff {
  const stateText = requiredText(row.state, "handoff.state");
  if (!isFoodHandoffState(stateText)) {
    throw new FoodDomainError(
      `Persisted food handoff has unknown state ${stateText}`,
      "FOOD_INVALID_CONTRACT",
      { state: stateText },
    );
  }
  const provider = requiredText(row.provider, "handoff.provider");
  if (provider !== "instacart") {
    throw new FoodDomainError(
      `Persisted food handoff has unknown provider ${provider}`,
      "FOOD_INVALID_CONTRACT",
      { provider },
    );
  }
  const providerResultKind = nullableText(
    row.provider_result_kind,
    "handoff.providerResultKind",
  );
  const providerLinkUrl = nullableText(
    row.provider_link_url,
    "handoff.providerLinkUrl",
  );
  if (
    providerResultKind !== null &&
    providerResultKind !== "shopping_list_link"
  ) {
    throw new FoodDomainError(
      "Persisted food handoff has invalid providerResultKind",
      "FOOD_INVALID_CONTRACT",
    );
  }
  if (
    (stateText === "link_created" &&
      (providerResultKind !== "shopping_list_link" ||
        providerLinkUrl === null)) ||
    (stateText !== "link_created" &&
      (providerResultKind !== null || providerLinkUrl !== null))
  ) {
    throw new FoodDomainError(
      "Persisted food handoff state does not match its provider receipt",
      "FOOD_INVALID_CONTRACT",
      { state: stateText },
    );
  }
  const content = parsePersisted(
    shoppingListContentSchema,
    parseJsonObject(row.content_json, "handoff.content"),
    "handoff.content",
  );
  const { contentSha256: embeddedContentSha256, ...contentWithoutHash } =
    content;
  const rowContentSha256 = requiredText(
    row.content_sha256,
    "handoff.contentSha256",
  );
  if (
    content.requiresHumanLabelReview !== true ||
    embeddedContentSha256 !== stableSha256(contentWithoutHash) ||
    rowContentSha256 !== embeddedContentSha256
  ) {
    throw new FoodDomainError(
      "Persisted shopping handoff content hash or review gate is invalid",
      "FOOD_INVALID_CONTRACT",
      { handoffId: row.handoff_id },
    );
  }
  return {
    handoffId: requiredText(row.handoff_id, "handoff.id"),
    agentId: requiredText(row.agent_id, "handoff.agentId"),
    householdId: requiredText(row.household_id, "handoff.householdId"),
    requestedByEntityId: requiredText(
      row.requested_by_entity_id,
      "handoff.requestedByEntityId",
    ),
    idempotencyKey: requiredText(row.idempotency_key, "handoff.idempotencyKey"),
    content,
    contentSha256: rowContentSha256,
    state: stateText,
    approvalRequestId: nullableText(
      row.approval_request_id,
      "handoff.approvalRequestId",
    ),
    provider: "instacart",
    providerLinkUrl,
    providerResultKind,
    attemptToken: nullableText(row.attempt_token, "handoff.attemptToken"),
    leaseExpiresAt: nullableText(
      row.lease_expires_at,
      "handoff.leaseExpiresAt",
    ),
    failureCode: nullableText(row.failure_code, "handoff.failureCode"),
    version: requiredInteger(row.version, "handoff.version"),
    createdAt: assertIsoTimestamp(
      requiredText(row.created_at, "handoff.createdAt"),
      "handoff.createdAt",
    ),
    updatedAt: assertIsoTimestamp(
      requiredText(row.updated_at, "handoff.updatedAt"),
      "handoff.updatedAt",
    ),
  };
}

function incomingObservationWins(
  current: InventoryLot,
  incoming: Omit<InventoryLot, "rowVersion" | "updatedAt">,
): boolean {
  if (
    current.provenance.kind === incoming.provenance.kind &&
    current.provenance.sourceId === incoming.provenance.sourceId
  ) {
    return (
      incoming.provenance.sourceRevision > current.provenance.sourceRevision
    );
  }
  const currentAuthority = PROVENANCE_AUTHORITY[current.provenance.kind];
  const incomingAuthority = PROVENANCE_AUTHORITY[incoming.provenance.kind];
  if (incomingAuthority !== currentAuthority) {
    return incomingAuthority > currentAuthority;
  }
  const observedComparison =
    Date.parse(incoming.provenance.observedAt) -
    Date.parse(current.provenance.observedAt);
  if (observedComparison !== 0) return observedComparison > 0;
  return incoming.provenance.sourceId > current.provenance.sourceId;
}

export class FoodRepository {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const statement of FOOD_SCHEMA_STATEMENTS) {
          await executeRawSql(this.runtime, statement);
        }
      })();
    }
    return this.schemaReady;
  }

  async putHouseholdProfile(input: {
    householdId: string;
    memberEntityIds: string[];
    expectedVersion: number;
    now: string;
  }): Promise<FoodHouseholdProfile> {
    await this.ensureSchema();
    const householdId = assertNonEmptyText(
      input.householdId,
      "householdId",
      200,
    );
    const expectedVersion = assertNonNegativeInteger(
      input.expectedVersion,
      "expectedVersion",
    );
    const now = assertIsoTimestamp(input.now, "now");
    const memberEntityIds = Array.from(
      new Set(
        input.memberEntityIds.map((id) =>
          assertNonEmptyText(id, "memberEntityIds", 200),
        ),
      ),
    ).sort();
    if (memberEntityIds.length === 0) {
      throw new FoodDomainError(
        "A food household profile requires at least one member entity",
        "FOOD_INVALID_CONTRACT",
      );
    }
    const nextVersion = expectedVersion + 1;
    const rows = await executeRawSql(
      this.runtime,
      expectedVersion === 0
        ? `INSERT INTO app_lifeops.life_food_households (
             agent_id, household_id, member_entity_ids_json, version,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote(this.agentId)}, ${sqlQuote(householdId)},
             ${sqlJson(memberEntityIds)}, ${sqlInteger(nextVersion)},
             ${sqlQuote(now)}, ${sqlQuote(now)}
           )
           ON CONFLICT (agent_id, household_id) DO NOTHING
           RETURNING *`
        : `UPDATE app_lifeops.life_food_households
             SET member_entity_ids_json = ${sqlJson(memberEntityIds)},
                 version = ${sqlInteger(nextVersion)},
                 updated_at = ${sqlQuote(now)}
           WHERE agent_id = ${sqlQuote(this.agentId)}
             AND household_id = ${sqlQuote(householdId)}
             AND version = ${sqlInteger(expectedVersion)}
           RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new FoodDomainError(
        "Food household profile version changed concurrently",
        "FOOD_INVENTORY_CONFLICT",
        { householdId, expectedVersion },
      );
    }
    return {
      householdId,
      memberEntityIds: parseStringArray(
        row.member_entity_ids_json,
        "profile.memberEntityIds",
      ),
      version: requiredInteger(row.version, "profile.version"),
      updatedAt: assertIsoTimestamp(
        requiredText(row.updated_at, "profile.updatedAt"),
        "profile.updatedAt",
      ),
    };
  }

  async getHouseholdProfile(
    householdId: string,
  ): Promise<FoodHouseholdProfile | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_food_households
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND household_id = ${sqlQuote(householdId)}
       LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      householdId: requiredText(row.household_id, "profile.householdId"),
      memberEntityIds: parseStringArray(
        row.member_entity_ids_json,
        "profile.memberEntityIds",
      ),
      version: requiredInteger(row.version, "profile.version"),
      updatedAt: assertIsoTimestamp(
        requiredText(row.updated_at, "profile.updatedAt"),
        "profile.updatedAt",
      ),
    };
  }

  async putConstraint(
    constraintInput: HardFoodConstraint,
    expectedVersion: number,
    now: string,
  ): Promise<HardFoodConstraint> {
    await this.ensureSchema();
    const constraint = validateConstraint(constraintInput);
    if (constraint.version !== expectedVersion + 1) {
      throw new FoodDomainError(
        "constraint.version must advance expectedVersion by exactly one",
        "FOOD_INVALID_CONTRACT",
        { constraintId: constraint.id, expectedVersion },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      expectedVersion === 0
        ? `INSERT INTO app_lifeops.life_food_constraints (
             agent_id, constraint_id, household_id, value_json, version, updated_at
           ) VALUES (
             ${sqlQuote(this.agentId)}, ${sqlQuote(constraint.id)},
             ${sqlQuote(constraint.householdId)}, ${sqlJson(constraint)},
             ${sqlInteger(constraint.version)}, ${sqlQuote(assertIsoTimestamp(now, "now"))}
           )
           ON CONFLICT (agent_id, constraint_id) DO NOTHING
           RETURNING *`
        : `UPDATE app_lifeops.life_food_constraints
             SET household_id = ${sqlQuote(constraint.householdId)},
                 value_json = ${sqlJson(constraint)},
                 version = ${sqlInteger(constraint.version)},
                 updated_at = ${sqlQuote(assertIsoTimestamp(now, "now"))}
           WHERE agent_id = ${sqlQuote(this.agentId)}
             AND constraint_id = ${sqlQuote(constraint.id)}
             AND version = ${sqlInteger(expectedVersion)}
           RETURNING *`,
    );
    if (!rows[0]) {
      throw new FoodDomainError(
        "Hard food constraint version changed concurrently",
        "FOOD_INVENTORY_CONFLICT",
        { constraintId: constraint.id, expectedVersion },
      );
    }
    return constraintFromRow(rows[0]);
  }

  async listConstraints(householdId: string): Promise<HardFoodConstraint[]> {
    await this.ensureSchema();
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_food_constraints
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
         ORDER BY constraint_id ASC`,
      )
    ).map(constraintFromRow);
  }

  async putPreference(
    preferenceInput: FoodPreference,
    expectedVersion: number,
    now: string,
  ): Promise<FoodPreference> {
    await this.ensureSchema();
    const preference = validatePreference(preferenceInput);
    if (preference.version !== expectedVersion + 1) {
      throw new FoodDomainError(
        "preference.version must advance expectedVersion by exactly one",
        "FOOD_INVALID_CONTRACT",
        { preferenceId: preference.id, expectedVersion },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      expectedVersion === 0
        ? `INSERT INTO app_lifeops.life_food_preferences (
             agent_id, preference_id, household_id, value_json, version, updated_at
           ) VALUES (
             ${sqlQuote(this.agentId)}, ${sqlQuote(preference.id)},
             ${sqlQuote(preference.householdId)}, ${sqlJson(preference)},
             ${sqlInteger(preference.version)}, ${sqlQuote(assertIsoTimestamp(now, "now"))}
           )
           ON CONFLICT (agent_id, preference_id) DO NOTHING
           RETURNING *`
        : `UPDATE app_lifeops.life_food_preferences
             SET household_id = ${sqlQuote(preference.householdId)},
                 value_json = ${sqlJson(preference)},
                 version = ${sqlInteger(preference.version)},
                 updated_at = ${sqlQuote(assertIsoTimestamp(now, "now"))}
           WHERE agent_id = ${sqlQuote(this.agentId)}
             AND preference_id = ${sqlQuote(preference.id)}
             AND version = ${sqlInteger(expectedVersion)}
           RETURNING *`,
    );
    if (!rows[0]) {
      throw new FoodDomainError(
        "Food preference version changed concurrently",
        "FOOD_INVENTORY_CONFLICT",
        { preferenceId: preference.id, expectedVersion },
      );
    }
    return preferenceFromRow(rows[0]);
  }

  async listPreferences(householdId: string): Promise<FoodPreference[]> {
    await this.ensureSchema();
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_food_preferences
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
         ORDER BY preference_id ASC`,
      )
    ).map(preferenceFromRow);
  }

  async recordInventoryObservation(
    observation: InventoryObservation,
    nowInput: string,
  ): Promise<{ current: InventoryLot; applied: boolean }> {
    await this.ensureSchema();
    const lot = validateInventoryLot(observation.lot);
    const now = assertIsoTimestamp(nowInput, "now");
    const payloadSha256 = stableSha256(lot);
    return withRequiredTransaction(this.runtime, async (tx) => {
      const householdLock = await executeRawSqlTx(
        tx,
        `SELECT household_id FROM app_lifeops.life_food_households
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(lot.householdId)}
         FOR UPDATE`,
      );
      if (!householdLock[0]) {
        throw new FoodDomainError(
          "Inventory observation references an unknown food household",
          "FOOD_INVALID_CONTRACT",
          { householdId: lot.householdId },
        );
      }
      // A household row is the stable lock target even when a lot has not been
      // created yet, so cross-source first writes cannot bypass ordering.
      const inserted = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_food_inventory_observations (
           observation_id, agent_id, household_id, lot_id, source_kind,
           source_id, source_revision, observed_at, payload_sha256,
           value_json, created_at
         ) VALUES (
           ${sqlQuote(`food_obs_${crypto.randomUUID()}`)},
           ${sqlQuote(this.agentId)}, ${sqlQuote(lot.householdId)},
           ${sqlQuote(lot.lotId)}, ${sqlQuote(lot.provenance.kind)},
           ${sqlQuote(lot.provenance.sourceId)},
           ${sqlInteger(lot.provenance.sourceRevision)},
           ${sqlQuote(lot.provenance.observedAt)}, ${sqlQuote(payloadSha256)},
           ${sqlJson(lot)}, ${sqlQuote(now)}
         )
         ON CONFLICT DO NOTHING
         RETURNING observation_id`,
      );
      if (!inserted[0]) {
        const existing = await executeRawSqlTx(
          tx,
          `SELECT payload_sha256 FROM app_lifeops.life_food_inventory_observations
           WHERE agent_id = ${sqlQuote(this.agentId)}
             AND source_kind = ${sqlQuote(lot.provenance.kind)}
             AND source_id = ${sqlQuote(lot.provenance.sourceId)}
             AND source_revision = ${sqlInteger(lot.provenance.sourceRevision)}
             AND lot_id = ${sqlQuote(lot.lotId)}
           LIMIT 1`,
        );
        if (
          !existing[0] ||
          requiredText(
            existing[0].payload_sha256,
            "observation.payloadSha256",
          ) !== payloadSha256
        ) {
          throw new FoodDomainError(
            "An inventory source revision was replayed with different bytes",
            "FOOD_IDEMPOTENCY_CONFLICT",
            {
              sourceId: lot.provenance.sourceId,
              sourceRevision: lot.provenance.sourceRevision,
            },
          );
        }
      }

      const currentRows = await executeRawSqlTx(
        tx,
        `SELECT * FROM app_lifeops.life_food_inventory_lots
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(lot.householdId)}
           AND lot_id = ${sqlQuote(lot.lotId)}
         FOR UPDATE`,
      );
      const current = currentRows[0]
        ? inventoryLotFromRow(currentRows[0])
        : null;
      if (current && !incomingObservationWins(current, lot)) {
        return { current, applied: false };
      }
      const nextVersion = (current?.rowVersion ?? 0) + 1;
      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_food_inventory_lots (
           agent_id, household_id, lot_id, source_kind, source_id,
           source_revision, observed_at, value_json, row_version, updated_at
         ) VALUES (
           ${sqlQuote(this.agentId)}, ${sqlQuote(lot.householdId)},
           ${sqlQuote(lot.lotId)}, ${sqlQuote(lot.provenance.kind)},
           ${sqlQuote(lot.provenance.sourceId)},
           ${sqlInteger(lot.provenance.sourceRevision)},
           ${sqlQuote(lot.provenance.observedAt)}, ${sqlJson(lot)},
           ${sqlInteger(nextVersion)}, ${sqlQuote(now)}
         )
         ON CONFLICT (agent_id, household_id, lot_id) DO UPDATE SET
           source_kind = EXCLUDED.source_kind,
           source_id = EXCLUDED.source_id,
           source_revision = EXCLUDED.source_revision,
           observed_at = EXCLUDED.observed_at,
           value_json = EXCLUDED.value_json,
           row_version = EXCLUDED.row_version,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
      );
      if (!rows[0]) {
        throw new FoodDomainError(
          "Inventory lot update did not return its persisted row",
          "FOOD_INVALID_CONTRACT",
          { lotId: lot.lotId },
        );
      }
      return { current: inventoryLotFromRow(rows[0]), applied: true };
    });
  }

  async listInventory(householdId: string): Promise<InventoryLot[]> {
    await this.ensureSchema();
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_food_inventory_lots
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
         ORDER BY lot_id ASC`,
      )
    ).map(inventoryLotFromRow);
  }

  async getInventorySnapshotSha256(householdId: string): Promise<string> {
    return inventorySnapshotSha256(await this.listInventory(householdId));
  }

  async getSafetyPolicySha256(householdId: string): Promise<string> {
    return safetyPolicySha256(await this.listConstraints(householdId));
  }

  async publishMealPlan(
    input: Omit<PublishedMealPlan, "agentId" | "createdAt" | "updatedAt">,
    nowInput: string,
  ): Promise<PublishedMealPlan> {
    await this.ensureSchema();
    const now = assertIsoTimestamp(nowInput, "now");
    const plan: PublishedMealPlan = {
      ...input,
      planId: assertNonEmptyText(input.planId, "planId", 200),
      agentId: this.agentId,
      householdId: assertNonEmptyText(input.householdId, "householdId", 200),
      mealDate: assertIsoTimestamp(input.mealDate, "mealDate"),
      title: assertNonEmptyText(input.title, "title", 200),
      attendeeEntityIds: Array.from(new Set(input.attendeeEntityIds)).sort(),
      contentSha256: assertNonEmptyText(
        input.contentSha256,
        "contentSha256",
        64,
      ),
      createdAt: now,
      updatedAt: now,
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_food_meal_plans (
         agent_id, plan_id, household_id, meal_date, content_sha256,
         value_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(plan.planId)},
         ${sqlQuote(plan.householdId)}, ${sqlQuote(plan.mealDate)},
         ${sqlQuote(plan.contentSha256)}, ${sqlJson(plan)},
         ${sqlQuote(now)}, ${sqlQuote(now)}
       )
       ON CONFLICT (agent_id, plan_id) DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) return publishedMealPlanFromRow(rows[0]);
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_food_meal_plans
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND plan_id = ${sqlQuote(plan.planId)}
       LIMIT 1`,
    );
    const existing = existingRows[0]
      ? publishedMealPlanFromRow(existingRows[0])
      : null;
    if (!existing || existing.contentSha256 !== plan.contentSha256) {
      throw new FoodDomainError(
        "Meal plan id was reused with different content",
        "FOOD_IDEMPOTENCY_CONFLICT",
        { planId: plan.planId },
      );
    }
    return existing;
  }

  async listMealPlans(householdId: string): Promise<PublishedMealPlan[]> {
    await this.ensureSchema();
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_food_meal_plans
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
         ORDER BY meal_date ASC, plan_id ASC`,
      )
    ).map(publishedMealPlanFromRow);
  }

  async prepareHandoff(input: {
    handoffId?: string;
    householdId: string;
    requestedByEntityId: string;
    idempotencyKey: string;
    content: FoodShoppingListContent;
    now: string;
  }): Promise<FoodShoppingHandoff> {
    await this.ensureSchema();
    const now = assertIsoTimestamp(input.now, "now");
    const handoffId =
      input.handoffId === undefined
        ? `food_handoff_${crypto.randomUUID()}`
        : assertNonEmptyText(input.handoffId, "handoffId", 200);
    const idempotencyKey = assertNonEmptyText(
      input.idempotencyKey,
      "idempotencyKey",
      300,
    );
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_food_handoffs (
         handoff_id, agent_id, household_id, requested_by_entity_id,
         idempotency_key, content_sha256, content_json, state,
         approval_request_id, provider, provider_link_url,
         provider_result_kind, attempt_token, lease_expires_at, failure_code,
         version, created_at, updated_at
       ) VALUES (
         ${sqlQuote(handoffId)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.householdId)}, ${sqlQuote(input.requestedByEntityId)},
         ${sqlQuote(idempotencyKey)}, ${sqlQuote(input.content.contentSha256)},
         ${sqlJson(input.content)}, 'awaiting_approval', NULL, 'instacart',
         NULL, NULL, NULL, NULL, NULL, 1, ${sqlQuote(now)}, ${sqlQuote(now)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) return handoffFromRow(rows[0]);
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_food_handoffs
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND idempotency_key = ${sqlQuote(idempotencyKey)}
       LIMIT 1`,
    );
    let existing = existingRows[0] ? handoffFromRow(existingRows[0]) : null;
    if (!existing) {
      const cachedRows = await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_food_handoffs
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND content_sha256 = ${sqlQuote(input.content.contentSha256)}
         LIMIT 1`,
      );
      existing = cachedRows[0] ? handoffFromRow(cachedRows[0]) : null;
    }
    if (
      !existing ||
      existing.contentSha256 !== input.content.contentSha256 ||
      existing.householdId !== input.householdId ||
      existing.requestedByEntityId !== input.requestedByEntityId
    ) {
      throw new FoodDomainError(
        "Shopping handoff idempotency key was reused for different content",
        "FOOD_IDEMPOTENCY_CONFLICT",
        { idempotencyKey },
      );
    }
    return existing;
  }

  async bindApproval(
    handoffId: string,
    approvalRequestId: string,
    nowInput: string,
  ): Promise<FoodShoppingHandoff> {
    await this.ensureSchema();
    const now = assertIsoTimestamp(nowInput, "now");
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_food_handoffs
       SET approval_request_id = ${sqlQuote(approvalRequestId)},
           version = version + 1,
           updated_at = ${sqlQuote(now)}
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND handoff_id = ${sqlQuote(handoffId)}
         AND state = 'awaiting_approval'
         AND (
           approval_request_id IS NULL
           OR approval_request_id = ${sqlQuote(approvalRequestId)}
         )
       RETURNING *`,
    );
    if (rows[0]) return handoffFromRow(rows[0]);
    const existing = await this.getHandoff(handoffId);
    if (existing?.approvalRequestId === approvalRequestId) return existing;
    throw new FoodDomainError(
      "Shopping handoff could not bind the exact approval request",
      "FOOD_APPROVAL_MISMATCH",
      { handoffId },
    );
  }

  async getHandoff(handoffId: string): Promise<FoodShoppingHandoff | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_food_handoffs
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND handoff_id = ${sqlQuote(handoffId)}
       LIMIT 1`,
    );
    return rows[0] ? handoffFromRow(rows[0]) : null;
  }

  async listHandoffs(householdId: string): Promise<FoodShoppingHandoff[]> {
    await this.ensureSchema();
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_food_handoffs
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
         ORDER BY created_at ASC`,
      )
    ).map(handoffFromRow);
  }

  async blockHandoff(
    handoffId: string,
    failureCode: string,
    nowInput: string,
  ): Promise<FoodShoppingHandoff> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_food_handoffs
       SET state = 'blocked',
           failure_code = ${sqlQuote(failureCode)},
           attempt_token = NULL,
           lease_expires_at = NULL,
           version = version + 1,
           updated_at = ${sqlQuote(assertIsoTimestamp(nowInput, "now"))}
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND handoff_id = ${sqlQuote(handoffId)}
         AND state IN ('awaiting_approval', 'creating_link')
       RETURNING *`,
    );
    if (!rows[0]) {
      throw new FoodDomainError(
        "Shopping handoff could not transition to blocked",
        "FOOD_INVALID_CONTRACT",
        { handoffId },
      );
    }
    return handoffFromRow(rows[0]);
  }

  async claimHandoff(input: {
    handoffId: string;
    now: string;
    leaseMs: number;
  }): Promise<{ handoff: FoodShoppingHandoff; attemptToken: string }> {
    await this.ensureSchema();
    const now = assertIsoTimestamp(input.now, "now");
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 1_000 ||
      input.leaseMs > 10 * 60 * 1000
    ) {
      throw new FoodDomainError(
        "handoff lease must be between one second and ten minutes",
        "FOOD_INVALID_CONTRACT",
        { leaseMs: input.leaseMs },
      );
    }
    const result = await withRequiredTransaction(this.runtime, async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `SELECT * FROM app_lifeops.life_food_handoffs
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND handoff_id = ${sqlQuote(input.handoffId)}
         FOR UPDATE`,
      );
      const handoff = rows[0] ? handoffFromRow(rows[0]) : null;
      if (!handoff) {
        throw new FoodDomainError(
          "Shopping handoff does not exist",
          "FOOD_INVALID_CONTRACT",
          { handoffId: input.handoffId },
        );
      }
      if (handoff.state === "creating_link") {
        const leaseExpiresAt = handoff.leaseExpiresAt;
        if (
          leaseExpiresAt !== null &&
          Date.parse(leaseExpiresAt) > Date.parse(now)
        ) {
          throw new FoodDomainError(
            "Shopping handoff link creation is already in progress",
            "FOOD_HANDOFF_BUSY",
            { handoffId: input.handoffId },
          );
        }
        const ambiguousRows = await executeRawSqlTx(
          tx,
          `UPDATE app_lifeops.life_food_handoffs
           SET state = 'ambiguous',
               failure_code = 'provider_outcome_unknown_after_lease',
               attempt_token = NULL,
               lease_expires_at = NULL,
               version = version + 1,
               updated_at = ${sqlQuote(now)}
           WHERE agent_id = ${sqlQuote(this.agentId)}
             AND handoff_id = ${sqlQuote(handoff.handoffId)}
           RETURNING *`,
        );
        if (!ambiguousRows[0]) {
          throw new FoodDomainError(
            "Expired shopping handoff lease could not be quarantined",
            "FOOD_HANDOFF_AMBIGUOUS",
            { handoffId: handoff.handoffId },
          );
        }
        return {
          outcome: "ambiguous" as const,
          handoff: handoffFromRow(ambiguousRows[0]),
        };
      }
      if (handoff.state === "ambiguous") {
        throw new FoodDomainError(
          "Shopping handoff provider outcome is ambiguous",
          "FOOD_HANDOFF_AMBIGUOUS",
          { handoffId: handoff.handoffId },
        );
      }
      if (handoff.state !== "awaiting_approval") {
        throw new FoodDomainError(
          `Shopping handoff cannot be claimed from ${handoff.state}`,
          "FOOD_INVALID_CONTRACT",
          { handoffId: handoff.handoffId, state: handoff.state },
        );
      }
      const attemptToken = `food_attempt_${crypto.randomUUID()}`;
      const leaseExpiresAt = new Date(
        Date.parse(now) + input.leaseMs,
      ).toISOString();
      const updated = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_food_handoffs
         SET state = 'creating_link',
             attempt_token = ${sqlQuote(attemptToken)},
             lease_expires_at = ${sqlQuote(leaseExpiresAt)},
             failure_code = NULL,
             version = version + 1,
             updated_at = ${sqlQuote(now)}
         WHERE handoff_id = ${sqlQuote(handoff.handoffId)}
           AND version = ${sqlInteger(handoff.version)}
         RETURNING *`,
      );
      if (!updated[0]) {
        throw new FoodDomainError(
          "Shopping handoff claim lost a concurrent race",
          "FOOD_HANDOFF_BUSY",
          { handoffId: handoff.handoffId },
        );
      }
      return {
        outcome: "claimed" as const,
        handoff: handoffFromRow(updated[0]),
        attemptToken,
      };
    });
    if (result.outcome === "ambiguous") {
      throw new FoodDomainError(
        "A prior provider call may have succeeded; automatic retry is unsafe",
        "FOOD_HANDOFF_AMBIGUOUS",
        { handoffId: result.handoff.handoffId },
      );
    }
    return { handoff: result.handoff, attemptToken: result.attemptToken };
  }

  async completeHandoff(input: {
    handoffId: string;
    attemptToken: string;
    providerLinkUrl: string;
    now: string;
  }): Promise<FoodShoppingHandoff> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_food_handoffs
       SET state = 'link_created',
           provider_link_url = ${sqlQuote(input.providerLinkUrl)},
           provider_result_kind = 'shopping_list_link',
           attempt_token = NULL,
           lease_expires_at = NULL,
           failure_code = NULL,
           version = version + 1,
           updated_at = ${sqlQuote(assertIsoTimestamp(input.now, "now"))}
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND handoff_id = ${sqlQuote(input.handoffId)}
         AND state = 'creating_link'
         AND attempt_token = ${sqlQuote(input.attemptToken)}
       RETURNING *`,
    );
    if (!rows[0]) {
      throw new FoodDomainError(
        "Provider result could not bind to its exact shopping handoff attempt",
        "FOOD_HANDOFF_AMBIGUOUS",
        { handoffId: input.handoffId },
      );
    }
    return handoffFromRow(rows[0]);
  }

  async failClaim(input: {
    handoffId: string;
    attemptToken: string;
    state: Extract<
      FoodHandoffState,
      "awaiting_approval" | "blocked" | "ambiguous"
    >;
    failureCode: string;
    now: string;
  }): Promise<FoodShoppingHandoff> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_food_handoffs
       SET state = ${sqlQuote(input.state)},
           failure_code = ${sqlQuote(input.failureCode)},
           attempt_token = NULL,
           lease_expires_at = NULL,
           version = version + 1,
           updated_at = ${sqlQuote(assertIsoTimestamp(input.now, "now"))}
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND handoff_id = ${sqlQuote(input.handoffId)}
         AND state = 'creating_link'
         AND attempt_token = ${sqlQuote(input.attemptToken)}
       RETURNING *`,
    );
    if (!rows[0]) {
      throw new FoodDomainError(
        "Shopping handoff failure could not bind to its exact attempt",
        "FOOD_HANDOFF_AMBIGUOUS",
        { handoffId: input.handoffId },
      );
    }
    return handoffFromRow(rows[0]);
  }

  async recoverStaleHandoffs(nowInput: string): Promise<FoodShoppingHandoff[]> {
    await this.ensureSchema();
    const now = assertIsoTimestamp(nowInput, "now");
    return (
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_food_handoffs
         SET state = 'ambiguous',
             failure_code = 'provider_outcome_unknown_after_lease',
             attempt_token = NULL,
             lease_expires_at = NULL,
             version = version + 1,
             updated_at = ${sqlQuote(now)}
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND state = 'creating_link'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ${sqlQuote(now)}
         RETURNING *`,
      )
    ).map(handoffFromRow);
  }
}

export async function ensureFoodSchema(
  runtime: IAgentRuntime,
  agentId = runtime.agentId,
): Promise<void> {
  await new FoodRepository(runtime, agentId).ensureSchema();
}
