/**
 * Owner conversational surface over the food domain: household profile, hard
 * constraints, preferences, inventory observations, deterministic meal
 * evaluation, plan publishing, and the approval-bound shopping handoff.
 *
 * Publishing and handoff requests never accept a model-authored evaluation.
 * The handler recomputes the canonical evaluation from current repository
 * state and requires the planner to echo the contentSha256 the owner already
 * reviewed, so what ships is exactly what was evaluated — a changed
 * constraint, preference, or pantry state surfaces as an explicit stale
 * rejection instead of silently publishing different content. Approved
 * handoffs are materialized elsewhere (RESOLVE_REQUEST), never here.
 */
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { resolveActionArgs, type SubactionsMap } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../action-effect-result.js";
import {
  foodInteger,
  foodStringArray,
  foodText,
  normalizeFoodPreferenceInput,
  normalizeHardFoodConstraintInput,
  normalizeInventoryObservationInput,
  normalizeMealCandidateInput,
  normalizeMealParticipantsInput,
} from "./action-io.js";
import { type FoodDomainService, getFoodDomainService } from "./service.js";
import type { MealPlanEvaluation } from "./types.js";

export const FOOD_DOMAIN_ACTION = "HOUSEHOLD_FOOD";

const FOOD_SUBACTIONS = [
  "put_household_profile",
  "put_constraint",
  "put_preference",
  "record_inventory",
  "evaluate_meal",
  "publish_meal_plan",
  "request_shopping_handoff",
  "view",
] as const;
type FoodSubaction = (typeof FOOD_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<FoodSubaction> = {
  put_household_profile: {
    description:
      "Register or revise the food household membership roster from canonical graph entities.",
    descriptionCompressed: "put food household member roster",
    required: ["householdId", "memberEntityIds", "expectedVersion"],
  },
  put_constraint: {
    description:
      "Append a hard allergy, cross-contact, medical, age-safety, religious, or ethical food constraint with provenance.",
    descriptionCompressed: "append hard food constraint w/ provenance",
    required: ["constraint", "expectedVersion"],
  },
  put_preference: {
    description:
      "Append a soft food preference (preferred/avoided tags with weight) that ranks but never overrides hard constraints.",
    descriptionCompressed: "append soft food preference",
    required: ["preference", "expectedVersion"],
  },
  record_inventory: {
    description:
      "Record a provenance-stamped pantry inventory observation; stale source revisions are rejected, not merged.",
    descriptionCompressed: "record pantry inventory observation",
    required: ["lot"],
  },
  evaluate_meal: {
    description:
      "Deterministically evaluate a meal candidate against hard constraints, preferences, headcount, leftovers, and inventory confidence. Returns the contentSha256 that publish and shopping-handoff requests must echo.",
    descriptionCompressed:
      "evaluate meal vs constraints/inventory; returns contentSha256",
    required: ["householdId", "plannedFor", "meal", "participants"],
  },
  publish_meal_plan: {
    description:
      "Publish a previously evaluated safe meal plan. Requires the exact contentSha256 from evaluate_meal; a changed constraint or pantry state rejects as stale.",
    descriptionCompressed: "publish evaluated meal plan by contentSha256",
    required: [
      "planId",
      "householdId",
      "plannedFor",
      "meal",
      "participants",
      "expectedContentSha256",
    ],
  },
  request_shopping_handoff: {
    description:
      "Queue an owner approval for an immutable shopping-list handoff built from the evaluated shopping delta. Approval creates only a human-review Instacart Products Link later; it is never a cart, order, or purchase.",
    descriptionCompressed:
      "queue approval-bound shopping handoff; link only, never an order",
    required: [
      "householdId",
      "plannedFor",
      "meal",
      "participants",
      "expectedContentSha256",
      "idempotencyKey",
    ],
  },
  view: {
    description:
      "Read the owner food view: profile, constraints, preferences, inventory, published plans, and handoff states.",
    descriptionCompressed: "read owner food-domain view",
    required: ["householdId"],
  },
};

export interface FoodDomainActionDependencies {
  authorize(runtime: IAgentRuntime, message: Memory): Promise<boolean>;
  getService?(runtime: IAgentRuntime): FoodDomainService;
}

function requestId(message: Memory): string {
  return message.id ?? `room:${message.roomId}`;
}

function receiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `${FOOD_DOMAIN_ACTION}:${operation}:${requestId(message)}:${resourceId}`;
}

function failedReceipt(input: {
  message: Memory;
  operation: string;
  code: string;
  retryable: boolean;
}) {
  const observedAt = new Date().toISOString();
  const id = requestId(input.message);
  return lifeOpsFailedEffect({
    receiptId: receiptId(input.message, input.operation, id),
    operation: input.operation,
    resource: { kind: "runtime.message", id },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    failure: {
      code: input.code,
      retryable: input.retryable,
      acceptance: "rejected",
    },
  });
}

interface MealEvaluationParams {
  householdId: string;
  plannedFor: string;
  meal: unknown;
  participants: unknown;
}

async function canonicalEvaluation(
  service: FoodDomainService,
  params: MealEvaluationParams,
): Promise<MealPlanEvaluation> {
  return service.evaluateMeal({
    principalEntityId: SELF_ENTITY_ID,
    householdId: params.householdId,
    plannedFor: params.plannedFor,
    meal: normalizeMealCandidateInput(params.meal),
    participants: normalizeMealParticipantsInput(params.participants),
  });
}

export function createFoodDomainAction(
  deps: FoodDomainActionDependencies,
): Action {
  return {
    name: FOOD_DOMAIN_ACTION,
    similes: [
      "MEAL_PLANNING",
      "FOOD_CONSTRAINTS",
      "FOOD_ALLERGY_RULE",
      "PANTRY_INVENTORY",
      "GROCERY_LIST",
      "SHOPPING_HANDOFF",
    ],
    tags: [
      "domain:household",
      "capability:read",
      "capability:write",
      "effect:receipt-required",
      "surface:internal",
    ],
    description:
      "Maintain household food policy and plan meals: hard allergy/diet constraints, preferences, provenance-stamped pantry inventory, deterministic meal evaluation, published meal plans, and approval-bound shopping-list handoffs. Never places an order, builds a retailer cart, or bypasses hard constraints.",
    descriptionCompressed:
      "food constraints|preferences|inventory|meal eval|plan publish|approval-bound shopping handoff",
    routingHint:
      "meal plan, family dinner idea, food allergy or diet rule, pantry stock update, or grocery/shopping list request -> HOUSEHOLD_FOOD",
    contexts: ["general", "tasks"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: deps.authorize,
    parameters: [
      {
        name: "action",
        description: "Food-domain verb.",
        required: true,
        schema: { type: "string", enum: [...FOOD_SUBACTIONS] },
      },
      {
        name: "householdId",
        description: "Stable food household identifier.",
        subactions: [
          "put_household_profile",
          "evaluate_meal",
          "publish_meal_plan",
          "request_shopping_handoff",
          "view",
        ],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "memberEntityIds",
        description:
          "Canonical graph entity IDs of every household member covered by food policy.",
        subactions: ["put_household_profile"],
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "expectedVersion",
        description:
          "Current record version for compare-and-swap; zero creates it.",
        subactions: [
          "put_household_profile",
          "put_constraint",
          "put_preference",
        ],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "constraint",
        description:
          "Typed hard food constraint with kind, excluded tags, subject entity, and provenance.",
        subactions: ["put_constraint"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "preference",
        description:
          "Typed soft food preference with preferred/avoided tags, weight, and provenance.",
        subactions: ["put_preference"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "lot",
        description:
          "Inventory lot observation with quantity, unit, confidence state, and provenance.",
        subactions: ["record_inventory"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "plannedFor",
        description: "ISO timestamp of the planned meal.",
        subactions: [
          "evaluate_meal",
          "publish_meal_plan",
          "request_shopping_handoff",
        ],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "meal",
        description:
          "Meal candidate with ingredients, tags, servings, and label-safety evidence.",
        subactions: [
          "evaluate_meal",
          "publish_meal_plan",
          "request_shopping_handoff",
        ],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "participants",
        description:
          "Attending household members with portion servings and attendance provenance.",
        subactions: [
          "evaluate_meal",
          "publish_meal_plan",
          "request_shopping_handoff",
        ],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "expectedContentSha256",
        description:
          "The contentSha256 returned by evaluate_meal for this exact meal; guards against publishing content the owner did not review.",
        subactions: ["publish_meal_plan", "request_shopping_handoff"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "planId",
        description: "Stable identifier for the published meal plan.",
        subactions: ["publish_meal_plan"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "idempotencyKey",
        description: "Stable key for one immutable shopping-handoff intent.",
        subactions: ["request_shopping_handoff"],
        schema: { type: "string", minLength: 1 },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      if (!(await deps.authorize(runtime, message))) {
        return completeLifeOpsEffect(
          callback,
          {
            success: false,
            text: "Food-domain operations are restricted to the authenticated owner.",
            data: { error: "PERMISSION_DENIED" },
          },
          failedReceipt({
            message,
            operation: "lifeops.food.authorize",
            code: "PERMISSION_DENIED",
            retryable: false,
          }),
        );
      }
      const resolved = await resolveActionArgs<
        FoodSubaction,
        Record<string, unknown>
      >({
        runtime,
        message,
        state,
        options,
        actionName: FOOD_DOMAIN_ACTION,
        subactions: SUBACTIONS,
      });
      if (!resolved.ok) {
        return completeLifeOpsEffect(
          callback,
          {
            success: false,
            text: resolved.clarification,
            data: {
              error: "MISSING_FOOD_PARAMETERS",
              missing: resolved.missing,
            },
          },
          failedReceipt({
            message,
            operation: "lifeops.food.resolve_request",
            code: "MISSING_FOOD_PARAMETERS",
            retryable: true,
          }),
        );
      }
      const service =
        deps.getService?.(runtime) ?? getFoodDomainService(runtime);
      const params = resolved.params;
      switch (resolved.subaction) {
        case "put_household_profile": {
          const profile = await service.putHouseholdProfile({
            principalEntityId: SELF_ENTITY_ID,
            householdId: foodText(params.householdId, "householdId"),
            memberEntityIds: foodStringArray(
              params.memberEntityIds,
              "memberEntityIds",
            ),
            expectedVersion: foodInteger(
              params.expectedVersion,
              "expectedVersion",
            ),
          });
          const operation = "lifeops.food_household_profile.put";
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: `Food household ${profile.householdId} now covers ${profile.memberEntityIds.length} member(s) at version ${profile.version}.`,
              data: { profile },
            },
            lifeOpsAppliedEffect({
              receiptId: receiptId(
                message,
                operation,
                `${profile.householdId}:${profile.version}`,
              ),
              operation,
              resource: {
                kind: "lifeops.food_household_profile",
                id: profile.householdId,
                version: String(profile.version),
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: profile.updatedAt,
              commit: {
                kind: "durable",
                id: `${profile.householdId}:${profile.version}`,
                committedAt: profile.updatedAt,
              },
            }),
          );
        }
        case "put_constraint": {
          const constraint = await service.putConstraint({
            principalEntityId: SELF_ENTITY_ID,
            constraint: normalizeHardFoodConstraintInput(params.constraint),
            expectedVersion: foodInteger(
              params.expectedVersion,
              "expectedVersion",
            ),
          });
          const operation = "lifeops.food_constraint.put";
          const observedAt = constraint.provenance.observedAt;
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: `Hard food constraint "${constraint.label}" (${constraint.kind}) is recorded at version ${constraint.version}.`,
              data: { constraint },
            },
            lifeOpsAppliedEffect({
              receiptId: receiptId(
                message,
                operation,
                `${constraint.id}:${constraint.version}`,
              ),
              operation,
              resource: {
                kind: "lifeops.food_constraint",
                id: constraint.id,
                version: String(constraint.version),
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt,
              commit: {
                kind: "durable",
                id: `${constraint.id}:${constraint.version}`,
                committedAt: observedAt,
              },
            }),
          );
        }
        case "put_preference": {
          const preference = await service.putPreference({
            principalEntityId: SELF_ENTITY_ID,
            preference: normalizeFoodPreferenceInput(params.preference),
            expectedVersion: foodInteger(
              params.expectedVersion,
              "expectedVersion",
            ),
          });
          const operation = "lifeops.food_preference.put";
          const observedAt = preference.provenance.observedAt;
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: `Food preference ${preference.id} is recorded at version ${preference.version}; it ranks meals but never overrides hard constraints.`,
              data: { preference },
            },
            lifeOpsAppliedEffect({
              receiptId: receiptId(
                message,
                operation,
                `${preference.id}:${preference.version}`,
              ),
              operation,
              resource: {
                kind: "lifeops.food_preference",
                id: preference.id,
                version: String(preference.version),
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt,
              commit: {
                kind: "durable",
                id: `${preference.id}:${preference.version}`,
                committedAt: observedAt,
              },
            }),
          );
        }
        case "record_inventory": {
          const observation = normalizeInventoryObservationInput(params.lot);
          const recorded = await service.recordInventoryObservation({
            principalEntityId: SELF_ENTITY_ID,
            observation,
          });
          const operation = "lifeops.food_inventory.observe";
          if (!recorded.applied) {
            // A superseded source revision is an explicit no-effect outcome,
            // not a failure: the durable lot state is returned unchanged.
            return completeLifeOpsEffect(
              callback,
              {
                success: true,
                text: `The inventory observation for ${recorded.current.itemId} was superseded by a newer source revision; the stored lot is unchanged.`,
                data: { inventory: recorded },
              },
              lifeOpsNoopEffect({
                receiptId: receiptId(
                  message,
                  operation,
                  `${recorded.current.lotId}:${recorded.current.rowVersion}`,
                ),
                operation,
                resource: {
                  kind: "lifeops.food_inventory_lot",
                  id: recorded.current.lotId,
                  version: String(recorded.current.rowVersion),
                },
                artifacts: [],
                idempotency: { key: null, replayed: false },
                observedAt: recorded.current.updatedAt,
                reason:
                  "A newer provenance revision already governs this lot; the observation changed nothing.",
              }),
            );
          }
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: `Inventory for ${recorded.current.itemId} is now ${recorded.current.quantity} ${recorded.current.unit} (${recorded.current.confidence}).`,
              data: { inventory: recorded },
            },
            lifeOpsAppliedEffect({
              receiptId: receiptId(
                message,
                operation,
                `${recorded.current.lotId}:${recorded.current.rowVersion}`,
              ),
              operation,
              resource: {
                kind: "lifeops.food_inventory_lot",
                id: recorded.current.lotId,
                version: String(recorded.current.rowVersion),
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: recorded.current.updatedAt,
              commit: {
                kind: "durable",
                id: `${recorded.current.lotId}:${recorded.current.rowVersion}`,
                committedAt: recorded.current.updatedAt,
              },
            }),
          );
        }
        case "evaluate_meal": {
          const evaluation = await canonicalEvaluation(service, {
            householdId: foodText(params.householdId, "householdId"),
            plannedFor: foodText(params.plannedFor, "plannedFor"),
            meal: params.meal,
            participants: params.participants,
          });
          const operation = "lifeops.food_meal.evaluate";
          const blocked = evaluation.blockedReasons.length > 0;
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: blocked
                ? `"${evaluation.meal.title}" is blocked by ${evaluation.blockedReasons.length} hard-constraint reason(s); nothing was published.`
                : `"${evaluation.meal.title}" passes every hard constraint for ${evaluation.participants.length} attendee(s); cite contentSha256 ${evaluation.contentSha256} to publish it or request a shopping handoff.`,
              data: { evaluation },
            },
            lifeOpsNoopEffect({
              receiptId: receiptId(
                message,
                operation,
                evaluation.contentSha256,
              ),
              operation,
              resource: {
                kind: "lifeops.food_meal_evaluation",
                id: evaluation.contentSha256,
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: new Date().toISOString(),
              reason:
                "Deterministic evaluation created no plan, handoff, or external effect.",
            }),
          );
        }
        case "publish_meal_plan":
        case "request_shopping_handoff": {
          const evaluation = await canonicalEvaluation(service, {
            householdId: foodText(params.householdId, "householdId"),
            plannedFor: foodText(params.plannedFor, "plannedFor"),
            meal: params.meal,
            participants: params.participants,
          });
          const expected = foodText(
            params.expectedContentSha256,
            "expectedContentSha256",
          );
          if (evaluation.contentSha256 !== expected) {
            const operation =
              resolved.subaction === "publish_meal_plan"
                ? "lifeops.food_meal_plan.publish"
                : "lifeops.food_shopping_handoff.request";
            return completeLifeOpsEffect(
              callback,
              {
                success: false,
                text: "The household's constraints, preferences, or inventory changed since this meal was evaluated. Re-run the evaluation and review it before publishing or requesting a shopping handoff.",
                data: {
                  error: "FOOD_STALE_SOURCE",
                  currentContentSha256: evaluation.contentSha256,
                },
              },
              failedReceipt({
                message,
                operation,
                code: "FOOD_STALE_SOURCE",
                retryable: true,
              }),
            );
          }
          if (resolved.subaction === "publish_meal_plan") {
            const plan = await service.publishMealPlan({
              principalEntityId: SELF_ENTITY_ID,
              planId: foodText(params.planId, "planId"),
              evaluation,
            });
            const operation = "lifeops.food_meal_plan.publish";
            return completeLifeOpsEffect(
              callback,
              {
                success: true,
                text: `Meal plan "${plan.title}" is published for ${plan.mealDate} with ${plan.attendeeEntityIds.length} attendee(s).`,
                data: { plan },
              },
              lifeOpsAppliedEffect({
                receiptId: receiptId(message, operation, plan.planId),
                operation,
                resource: {
                  kind: "lifeops.food_meal_plan",
                  id: plan.planId,
                },
                artifacts: [],
                idempotency: { key: null, replayed: false },
                observedAt: plan.updatedAt,
                commit: {
                  kind: "durable",
                  id: plan.planId,
                  committedAt: plan.createdAt,
                },
              }),
            );
          }
          const requested = await service.requestShoppingHandoffApproval({
            principalEntityId: SELF_ENTITY_ID,
            evaluation,
            idempotencyKey: foodText(params.idempotencyKey, "idempotencyKey"),
          });
          const operation = "lifeops.food_shopping_handoff.request";
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: `A shopping-list handoff with ${requested.handoff.content.lines.length} line(s) is queued for your approval. Approval creates a review link only — store, product-label, cart, and checkout stay human decisions.`,
              data: { handoff: requested },
            },
            lifeOpsAppliedEffect({
              receiptId: receiptId(
                message,
                operation,
                requested.handoff.handoffId,
              ),
              operation,
              resource: {
                kind: "lifeops.food_shopping_handoff",
                id: requested.handoff.handoffId,
                version: String(requested.handoff.version),
              },
              artifacts: [
                {
                  kind: "lifeops.approval_request",
                  id: requested.approvalRequest.id,
                },
              ],
              idempotency: {
                key: requested.handoff.idempotencyKey,
                replayed: requested.replayed,
              },
              observedAt: requested.handoff.updatedAt,
              commit: {
                kind: "durable",
                id: requested.handoff.handoffId,
                committedAt: requested.handoff.createdAt,
              },
            }),
          );
        }
        case "view": {
          const view = await service.getView({
            principalEntityId: SELF_ENTITY_ID,
            householdId: foodText(params.householdId, "householdId"),
          });
          const operation = "lifeops.food_view.read";
          const observedAt = new Date().toISOString();
          const summary =
            "constraints" in view
              ? `Food household ${view.profile.householdId}: ${view.constraints.length} constraint(s), ${view.preferences.length} preference(s), ${view.inventory.length} inventory lot(s), ${view.mealPlans.length} plan(s), ${view.handoffs.length} handoff(s).`
              : `Meals visible to this principal: ${view.meals.length}.`;
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: summary,
              data: { view },
            },
            lifeOpsNoopEffect({
              receiptId: receiptId(
                message,
                operation,
                foodText(params.householdId, "householdId"),
              ),
              operation,
              resource: {
                kind: "lifeops.food_view",
                id: foodText(params.householdId, "householdId"),
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt,
              reason:
                "The operation read food-domain state without changing it.",
            }),
          );
        }
      }
    },
  };
}
