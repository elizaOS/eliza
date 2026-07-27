/**
 * Action-construction seam for household-operation records and projections.
 *
 * Hosts inject owner authentication and register the runtime service. The
 * action persists evidence, evaluates policy, and creates drafts or review
 * proposals only; it has no send, purchase, registration, calendar-mutation,
 * vendor-booking, or responsibility-reassignment verb.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { resolveActionArgs, type SubactionsMap } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  getHouseholdOperationsService,
  type HouseholdOperationsService,
} from "./service.js";
import {
  type HouseholdCalendarCheck,
  HouseholdOperationsError,
  normalizeCalendarCheck,
  normalizeObservationInput,
  normalizeOperationDefinition,
  normalizeResponsibilitySignalInput,
  normalizeServiceEventInput,
  normalizeServiceWindow,
  requireOperationsInteger,
  requireOperationsText,
} from "./types.js";

const ACTION_NAME = "HOUSEHOLD_OPERATIONS";
const HOUSEHOLD_OPERATION_SUBACTIONS = [
  "put_record",
  "record_observation",
  "record_service_event",
  "record_responsibility_signal",
  "evaluate_opportunity",
  "evaluate_item_replacement",
  "assess_responsibility",
  "generate_weekly_brief",
  "read_weekly_brief",
] as const;
type HouseholdOperationSubaction =
  (typeof HOUSEHOLD_OPERATION_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<HouseholdOperationSubaction> = {
  put_record: {
    description:
      "Append a versioned vendor, almanac, opportunity, child-item threshold, or accepted C/P/E/M responsibility record.",
    descriptionCompressed:
      "append versioned household-operation record with CAS",
    required: ["input", "expectedRevision"],
  },
  record_observation: {
    description:
      "Append a provenance- and confidence-bearing home, inventory, or child-size observation, optionally correcting or superseding an earlier observation.",
    descriptionCompressed: "append source-grounded household observation",
    required: ["input"],
  },
  record_service_event: {
    description:
      "Append an evidenced vendor/service-history event; completion requires completion evidence and sent/scheduled states require approval plus provider receipt.",
    descriptionCompressed: "append evidenced vendor service history",
    required: ["input"],
  },
  record_responsibility_signal: {
    description:
      "Append an authenticated or provider-observed delivery, dismissal, overdue, or completion signal for the exact responsibility version.",
    descriptionCompressed:
      "append exact-version responsibility engagement signal",
    required: ["input"],
  },
  evaluate_opportunity: {
    description:
      "Evaluate availability, confirmed coverage, and protected unstructured-time capacity without registering or charging.",
    descriptionCompressed: "evaluate opportunity state and family capacity",
    required: ["recordId"],
  },
  evaluate_item_replacement: {
    description:
      "Evaluate current child-size and usable-count evidence and return no action, a verification request, or an approval-gated replacement draft.",
    descriptionCompressed:
      "evaluate child item size/count threshold; no purchase",
    required: ["recordId"],
  },
  assess_responsibility: {
    description:
      "Evaluate repeated dismissal or overdue signals and propose human responsibility renegotiation without changing any owner.",
    descriptionCompressed:
      "propose non-use responsibility review; never reassign",
    required: ["recordId"],
  },
  generate_weekly_brief: {
    description:
      "Create a scoped structural weekly brief from current revisions, source events, observations, calendar-check evidence, and non-use reviews.",
    descriptionCompressed: "generate structural weekly household brief",
    required: ["householdId", "window", "calendarChecks"],
  },
  read_weekly_brief: {
    description:
      "Read a weekly brief through the caller's graph-backed household and child visibility.",
    descriptionCompressed: "read role-scoped weekly household brief",
    required: ["briefId"],
  },
};

export interface HouseholdOperationsActionDependencies {
  authorize(runtime: IAgentRuntime, message: Memory): Promise<boolean>;
  getService?(runtime: IAgentRuntime): HouseholdOperationsService | null;
}

function serviceFor(
  runtime: IAgentRuntime,
  deps: HouseholdOperationsActionDependencies,
): HouseholdOperationsService {
  const service =
    deps.getService?.(runtime) ?? getHouseholdOperationsService(runtime);
  if (!service) {
    throw new HouseholdOperationsError(
      "Household-operations runtime service is unavailable",
      "HOUSEHOLD_OPERATIONS_GRAPH_UNAVAILABLE",
      { agentId: runtime.agentId },
    );
  }
  return service;
}

async function complete(
  callback: HandlerCallback | undefined,
  result: ActionResult,
): Promise<ActionResult> {
  if (result.text) await callback?.({ text: result.text });
  return result;
}

export function createHouseholdOperationsAction(
  deps: HouseholdOperationsActionDependencies,
): Action {
  return {
    name: ACTION_NAME,
    similes: [
      "HOME_MAINTENANCE",
      "HOUSEHOLD_VENDOR",
      "SEASONAL_PLANNING",
      "CHILD_CLOTHING_SIZE",
      "HOUSEHOLD_RESPONSIBILITY",
      "HOUSEHOLD_WEEKLY_BRIEF",
    ],
    tags: [
      "domain:household",
      "domain:tasks",
      "capability:read",
      "capability:write",
      "surface:internal",
    ],
    description:
      "Capture source-grounded household observations and vendor history; version seasonal, child-item, and C/P/E/M policy; and create scoped weekly briefs or approval-gated drafts. This action never sends, purchases, registers, books, mutates calendars, or silently reassigns another adult.",
    descriptionCompressed:
      "household vendors|maintenance|seasonal opportunities|child sizes|CPEM|weekly brief; drafts only",
    routingHint:
      "vendor/service history, due home work, seasonal registration, child clothing size, household responsibility non-use, or weekly family brief -> HOUSEHOLD_OPERATIONS",
    contexts: ["general", "calendar", "tasks", "finances", "documents"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: deps.authorize,
    parameters: [
      {
        name: "action",
        description: "Household-operation verb.",
        required: true,
        schema: {
          type: "string",
          enum: [...HOUSEHOLD_OPERATION_SUBACTIONS],
        },
      },
      {
        name: "input",
        description:
          "Typed record, observation, service event, or responsibility signal.",
        subactions: [
          "put_record",
          "record_observation",
          "record_service_event",
          "record_responsibility_signal",
        ],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "expectedRevision",
        description:
          "Current revision for compare-and-swap; zero creates a record.",
        subactions: ["put_record"],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "recordId",
        description:
          "Opportunity, item-threshold, or responsibility-assignment record ID.",
        subactions: [
          "evaluate_opportunity",
          "evaluate_item_replacement",
          "assess_responsibility",
        ],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "householdId",
        description: "Household projection ID.",
        subactions: ["generate_weekly_brief"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "window",
        description: "Weekly brief ISO start/end window.",
        subactions: ["generate_weekly_brief"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "calendarChecks",
        description:
          "Provider-neutral availability results for exact maintenance windows; absent evidence blocks outreach drafting.",
        subactions: ["generate_weekly_brief"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "briefId",
        description: "Persisted household weekly-brief ID.",
        subactions: ["read_weekly_brief"],
        schema: { type: "string", minLength: 1 },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      if (!(await deps.authorize(runtime, message))) {
        return complete(callback, {
          success: false,
          text: "Household operations are restricted to the authenticated owner.",
          data: { error: "PERMISSION_DENIED" },
        });
      }
      const resolved = await resolveActionArgs<
        HouseholdOperationSubaction,
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
        return complete(callback, {
          success: false,
          text: resolved.clarification,
          data: {
            error: "MISSING_HOUSEHOLD_OPERATION_PARAMETERS",
            missing: resolved.missing,
          },
        });
      }
      const service = serviceFor(runtime, deps);
      if (resolved.subaction === "put_record") {
        const revision = await service.putRevision({
          principalEntityId: SELF_ENTITY_ID,
          definition: normalizeOperationDefinition(resolved.params.input),
          expectedRevision: requireOperationsInteger(
            resolved.params.expectedRevision,
            "expectedRevision",
            0,
          ),
        });
        return complete(callback, {
          success: true,
          text: `Household ${revision.kind} revision ${revision.revision} was appended.`,
          data: { revision },
        });
      }
      if (resolved.subaction === "record_observation") {
        const result = await service.recordObservation({
          principalEntityId: SELF_ENTITY_ID,
          observation: normalizeObservationInput(resolved.params.input),
        });
        return complete(callback, {
          success: true,
          text: result.inserted
            ? "The household observation was appended."
            : "The exact household observation was already recorded.",
          data: result,
        });
      }
      if (resolved.subaction === "record_service_event") {
        const result = await service.recordServiceEvent({
          principalEntityId: SELF_ENTITY_ID,
          event: normalizeServiceEventInput(resolved.params.input),
        });
        return complete(callback, {
          success: true,
          text: result.inserted
            ? "The service-history event was appended."
            : "The exact service-history event was already recorded.",
          data: result,
        });
      }
      if (resolved.subaction === "record_responsibility_signal") {
        const result = await service.recordResponsibilitySignal({
          actingEntityId: SELF_ENTITY_ID,
          signal: normalizeResponsibilitySignalInput(resolved.params.input),
        });
        return complete(callback, {
          success: true,
          text: result.inserted
            ? "The responsibility signal was appended."
            : "The exact responsibility signal was already recorded.",
          data: result,
        });
      }
      if (resolved.subaction === "evaluate_opportunity") {
        const evaluation = await service.evaluateOpportunity({
          principalEntityId: SELF_ENTITY_ID,
          opportunityRecordId: requireOperationsText(
            resolved.params.recordId,
            "recordId",
            300,
          ),
        });
        return complete(callback, {
          success: true,
          text: "The opportunity was evaluated without registration or charge.",
          data: { evaluation },
        });
      }
      if (resolved.subaction === "evaluate_item_replacement") {
        const recommendation = await service.evaluateItemReplacement({
          principalEntityId: SELF_ENTITY_ID,
          thresholdRecordId: requireOperationsText(
            resolved.params.recordId,
            "recordId",
            300,
          ),
        });
        return complete(callback, {
          success: true,
          text:
            recommendation.state === "replacement_draft"
              ? "A replacement draft is available; no purchase was made."
              : "The child-item threshold was evaluated; no purchase was made.",
          data: { recommendation },
        });
      }
      if (resolved.subaction === "assess_responsibility") {
        const proposal = await service.assessResponsibility({
          principalEntityId: SELF_ENTITY_ID,
          assignmentRecordId: requireOperationsText(
            resolved.params.recordId,
            "recordId",
            300,
          ),
        });
        return complete(callback, {
          success: true,
          text: proposal
            ? "A responsibility-renegotiation proposal was created; no owner changed."
            : "The responsibility record does not currently cross its non-use review threshold.",
          data: { proposal },
        });
      }
      if (resolved.subaction === "generate_weekly_brief") {
        const calendarChecksValue = resolved.params.calendarChecks;
        if (!Array.isArray(calendarChecksValue)) {
          throw new HouseholdOperationsError(
            "calendarChecks must be an array",
            "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          );
        }
        const calendarChecks: HouseholdCalendarCheck[] =
          calendarChecksValue.map((check, index) =>
            normalizeCalendarCheck(check, `calendarChecks[${index}]`),
          );
        const brief = await service.generateWeeklyBrief({
          principalEntityId: SELF_ENTITY_ID,
          householdId: requireOperationsText(
            resolved.params.householdId,
            "householdId",
            300,
          ),
          window: normalizeServiceWindow(resolved.params.window, "window"),
          calendarChecks,
        });
        return complete(callback, {
          success: true,
          text: `The weekly brief contains ${brief.items.length} material items and ${brief.questions.length} questions.`,
          data: { brief },
        });
      }
      const view = await service.readWeeklyBrief({
        principalEntityId: SELF_ENTITY_ID,
        briefId: requireOperationsText(resolved.params.briefId, "briefId", 300),
      });
      return complete(callback, {
        success: true,
        text: `The weekly brief contains ${view.items.length} visible material items.`,
        data: { brief: view },
      });
    },
  };
}
