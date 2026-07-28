/**
 * Owner action for household resource records and capacity proposals.
 *
 * Planner parameters contain structural facts only. The action can persist
 * evidence, evaluate conflicts, and queue exact proposal reviews; it exposes
 * no reserve, calendar-write, send, purchase, or dispatch operation.
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
  getResourceCapacityService,
  type ResourceCapacityService,
} from "./service.js";
import {
  normalizeCapacityEvaluationInput,
  normalizeResourceDefinition,
  ResourceCapacityError,
  requireCapacityInteger,
  requireCapacityText,
  requireCapacityTimestamp,
  uniqueCapacityIds,
} from "./types.js";

const ACTION_NAME = "HOUSEHOLD_RESOURCE_CAPACITY";
const RESOURCE_CAPACITY_SUBACTIONS = [
  "put_resource",
  "evaluate_plan",
  "propose_plan",
  "read_proposal",
] as const;
type ResourceCapacitySubaction = (typeof RESOURCE_CAPACITY_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<ResourceCapacitySubaction> = {
  put_resource: {
    description:
      "Append an owner-authorized caregiver, vehicle, or car-seat resource revision with source-grounded availability.",
    descriptionCompressed:
      "append caregiver|vehicle|car-seat resource revision",
    required: ["resource", "expectedRevision"],
  },
  evaluate_plan: {
    description:
      "Detect caregiver, authorization, availability, vehicle, car-seat, accessibility, handoff, transition, and pending-proposal conflicts without reserving anything.",
    descriptionCompressed:
      "evaluate structural family resource capacity; no reservation",
    required: ["plan", "maximumSourceAgeMinutes"],
    optional: ["assignments", "transitions"],
  },
  propose_plan: {
    description:
      "Persist an immutable capacity proposal; a feasible proposal queues exact affected-adult reviews and one shared ScheduledTask expiry watcher, but approval never reserves or executes it.",
    descriptionCompressed:
      "persist proposal-only resource plan with shared reviews/watcher",
    required: [
      "plan",
      "maximumSourceAgeMinutes",
      "requiredApproverEntityIds",
      "idempotencyKey",
      "expiresAt",
    ],
    optional: ["assignments", "transitions"],
  },
  read_proposal: {
    description:
      "Read the exact proposal, review states, and explicit no-effect flags.",
    descriptionCompressed: "read proposal-only capacity review state",
    required: ["proposalId"],
  },
};

export interface ResourceCapacityActionDependencies {
  authorize(runtime: IAgentRuntime, message: Memory): Promise<boolean>;
  getService?(runtime: IAgentRuntime): ResourceCapacityService | null;
}

function serviceFor(
  runtime: IAgentRuntime,
  deps: ResourceCapacityActionDependencies,
): ResourceCapacityService {
  const service =
    deps.getService?.(runtime) ?? getResourceCapacityService(runtime);
  if (!service) {
    throw new ResourceCapacityError(
      "Resource-capacity runtime service is unavailable",
      "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
      { agentId: runtime.agentId },
    );
  }
  return service;
}

function requestId(message: Memory): string {
  return message.id ?? `room:${message.roomId}`;
}

function receiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `${ACTION_NAME}:${operation}:${requestId(message)}:${resourceId}`;
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

export function createResourceCapacityAction(
  deps: ResourceCapacityActionDependencies,
): Action {
  return {
    name: ACTION_NAME,
    similes: [
      "FAMILY_CAPACITY",
      "CAREGIVER_COVERAGE",
      "TRANSPORT_CAPACITY",
      "CAR_SEAT_CONFLICT",
      "PICKUP_HANDOFF",
      "ACCESSIBLE_TRANSPORT",
    ],
    tags: [
      "domain:household",
      "domain:calendar",
      "capability:read",
      "capability:write",
      "effect:receipt-required",
      "surface:internal",
    ],
    description:
      "Record household caregivers, vehicles, restraints, authorization and availability; detect shared-resource conflicts across non-overlapping events; and create proposal-only affected-adult reviews. Never treats review as a reservation, writes a calendar, or sends a message.",
    descriptionCompressed:
      "caregiver|vehicle|car-seat|accessibility|handoff capacity; proposal only",
    routingHint:
      "caregiver coverage, pickup handoff, shared vehicle, car seat, accessibility transport, or non-overlap resource conflict -> HOUSEHOLD_RESOURCE_CAPACITY",
    contexts: ["general", "calendar", "tasks"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: deps.authorize,
    parameters: [
      {
        name: "action",
        description: "Resource-capacity verb.",
        required: true,
        schema: {
          type: "string",
          enum: [...RESOURCE_CAPACITY_SUBACTIONS],
        },
      },
      {
        name: "resource",
        description:
          "Typed caregiver, vehicle, or car-seat resource definition.",
        subactions: ["put_resource"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "expectedRevision",
        description:
          "Current resource revision for compare-and-swap; zero creates it.",
        subactions: ["put_resource"],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "plan",
        description:
          "Household plan with exact needs, windows, locations, children, requirements, and handoffs.",
        subactions: ["evaluate_plan", "propose_plan"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "assignments",
        description:
          "Explicit caregiver, backup, vehicle, and car-seat assignments by need.",
        subactions: ["evaluate_plan", "propose_plan"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "transitions",
        description:
          "Exact source-grounded resource transition times between needs.",
        subactions: ["evaluate_plan", "propose_plan"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "maximumSourceAgeMinutes",
        description:
          "Maximum accepted age for availability and transition evidence.",
        subactions: ["evaluate_plan", "propose_plan"],
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "requiredApproverEntityIds",
        description:
          "Affected adult graph entity IDs who must review exact proposal bytes.",
        subactions: ["propose_plan"],
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "idempotencyKey",
        description: "Stable key for one immutable proposal intent.",
        subactions: ["propose_plan"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "expiresAt",
        description: "ISO timestamp ending the proposal-review window.",
        subactions: ["propose_plan"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "proposalId",
        description: "Persisted resource-capacity proposal ID.",
        subactions: ["read_proposal"],
        schema: { type: "string", minLength: 1 },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      if (!(await deps.authorize(runtime, message))) {
        return completeLifeOpsEffect(
          callback,
          {
            success: false,
            text: "Household resource capacity is restricted to the authenticated owner.",
            data: { error: "PERMISSION_DENIED" },
          },
          failedReceipt({
            message,
            operation: "lifeops.resource_capacity.authorize",
            code: "PERMISSION_DENIED",
            retryable: false,
          }),
        );
      }
      const resolved = await resolveActionArgs<
        ResourceCapacitySubaction,
        Record<string, unknown>
      >({
        runtime,
        message,
        state,
        options,
        actionName: ACTION_NAME,
        subactions: SUBACTIONS,
      });
      if (!resolved.ok) {
        return completeLifeOpsEffect(
          callback,
          {
            success: false,
            text: resolved.clarification,
            data: {
              error: "MISSING_RESOURCE_CAPACITY_PARAMETERS",
              missing: resolved.missing,
            },
          },
          failedReceipt({
            message,
            operation: "lifeops.resource_capacity.resolve_request",
            code: "MISSING_RESOURCE_CAPACITY_PARAMETERS",
            retryable: true,
          }),
        );
      }
      const service = serviceFor(runtime, deps);
      if (resolved.subaction === "put_resource") {
        const revision = await service.putResource({
          principalEntityId: SELF_ENTITY_ID,
          definition: normalizeResourceDefinition(resolved.params.resource),
          expectedRevision: requireCapacityInteger(
            resolved.params.expectedRevision,
            "expectedRevision",
            0,
          ),
        });
        const operation = "lifeops.household_resource.put_revision";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: `Household ${revision.kind} resource revision ${revision.revision} was appended.`,
            data: { revision },
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(
              message,
              operation,
              `${revision.resourceId}:${revision.revision}`,
            ),
            operation,
            resource: {
              kind: "lifeops.household_resource",
              id: revision.resourceId,
              version: String(revision.revision),
            },
            artifacts: [],
            idempotency: { key: null, replayed: false },
            observedAt: revision.createdAt,
            commit: {
              kind: "durable",
              id: `${revision.kind}:${revision.resourceId}:${revision.revision}`,
              committedAt: revision.createdAt,
            },
          }),
        );
      }
      if (
        resolved.subaction === "evaluate_plan" ||
        resolved.subaction === "propose_plan"
      ) {
        // Empty assignment and transition sets are valid fail-closed inputs:
        // the solver must explain missing capacity instead of blocking the
        // action router before structural evaluation can run.
        const evaluationInput = normalizeCapacityEvaluationInput({
          plan: resolved.params.plan,
          assignments:
            resolved.params.assignments === undefined
              ? []
              : resolved.params.assignments,
          transitions:
            resolved.params.transitions === undefined
              ? []
              : resolved.params.transitions,
          maximumSourceAgeMinutes: resolved.params.maximumSourceAgeMinutes,
        });
        if (resolved.subaction === "evaluate_plan") {
          const evaluation = await service.evaluate({
            principalEntityId: SELF_ENTITY_ID,
            evaluation: evaluationInput,
          });
          const operation = "lifeops.resource_capacity.evaluate";
          return completeLifeOpsEffect(
            callback,
            {
              success: true,
              text: evaluation.feasible
                ? "The resource plan has no structural conflicts; nothing was reserved or changed."
                : `The resource plan has ${evaluation.conflicts.length} structural conflict(s); nothing was reserved or changed.`,
              data: { evaluation },
            },
            lifeOpsNoopEffect({
              receiptId: receiptId(message, operation, evaluation.inputSha256),
              operation,
              resource: {
                kind: "lifeops.resource_capacity_evaluation",
                id: evaluation.inputSha256,
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: evaluation.evaluatedAt,
              reason: "Evaluation created no reservation or external mutation.",
            }),
          );
        }
        const proposal = await service.createProposal({
          principalEntityId: SELF_ENTITY_ID,
          evaluation: evaluationInput,
          requiredApproverEntityIds: uniqueCapacityIds(
            resolved.params.requiredApproverEntityIds,
            "requiredApproverEntityIds",
          ),
          idempotencyKey: requireCapacityText(
            resolved.params.idempotencyKey,
            "idempotencyKey",
          ),
          expiresAt: requireCapacityTimestamp(
            resolved.params.expiresAt,
            "expiresAt",
          ),
        });
        const operation = "lifeops.resource_capacity_proposal.create";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text:
              proposal.effectiveState === "blocked"
                ? `A blocked proposal was recorded with ${proposal.proposal.evaluation.conflicts.length} conflict(s); no approvals, reservation, or external effects were created.`
                : "A proposal-only capacity review was queued. Approval does not reserve resources or mutate calendars.",
            data: { proposal },
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(
              message,
              operation,
              proposal.proposal.proposalId,
            ),
            operation,
            resource: {
              kind: "lifeops.resource_capacity_proposal",
              id: proposal.proposal.proposalId,
              version: String(proposal.proposal.version),
            },
            artifacts: [
              ...proposal.approvals.map((approval) => ({
                kind: "lifeops.approval_request",
                id: approval.approvalRequestId,
              })),
              ...(proposal.reviewTaskId
                ? [
                    {
                      kind: "lifeops.scheduled_task",
                      id: proposal.reviewTaskId,
                    },
                  ]
                : []),
            ],
            idempotency: {
              key: proposal.proposal.idempotencyKey,
              replayed: proposal.replayed,
            },
            observedAt: proposal.proposal.createdAt,
            commit: {
              kind: "durable",
              id: proposal.proposal.proposalId,
              committedAt: proposal.proposal.createdAt,
            },
          }),
        );
      }
      const proposal = await service.readProposal({
        principalEntityId: SELF_ENTITY_ID,
        proposalId: requireCapacityText(
          resolved.params.proposalId,
          "proposalId",
        ),
      });
      const operation = "lifeops.resource_capacity_proposal.read";
      const observedAt = new Date().toISOString();
      return completeLifeOpsEffect(
        callback,
        {
          success: true,
          text: `The capacity proposal is ${proposal.effectiveState}; it has no reservation or external effect.`,
          data: { proposal },
        },
        lifeOpsNoopEffect({
          receiptId: receiptId(
            message,
            operation,
            proposal.proposal.proposalId,
          ),
          operation,
          resource: {
            kind: "lifeops.resource_capacity_proposal",
            id: proposal.proposal.proposalId,
            version: String(proposal.proposal.version),
          },
          artifacts: [],
          idempotency: { key: null, replayed: false },
          observedAt,
          reason: "The operation read proposal state without changing it.",
        }),
      );
    },
  };
}
