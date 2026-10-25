/**
 * Conversational action for low-risk, source-grounded parenting education and
 * safety-boundary handoff. Planner inference supplies topic, developmental
 * context, and an optional graph subject; the handler accepts no identity,
 * permission, risk, disclosure, or locale flags from model parameters.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  getParentingGuidanceService,
  ParentingGuidanceError,
  type ParentingGuidanceRuntimeService,
  renderParentingGuidanceDelivery,
} from "./service.js";
import {
  PARENTING_AGE_BANDS,
  PARENTING_TOPICS,
  type ParentingAgeBand,
  type ParentingTopic,
} from "./types.js";

export const PARENTING_GUIDANCE_ACTION = "PARENTING_GUIDANCE";

export interface ParentingGuidanceActionDependencies {
  resolveAuthenticatedPrincipal(
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<string | null>;
  getService?(runtime: IAgentRuntime): ParentingGuidanceRuntimeService | null;
}

interface ParentingActionParameters {
  readonly subjectEntityId?: unknown;
  readonly ageBand?: unknown;
  readonly topic?: unknown;
  readonly requestedFramework?: unknown;
}

function parameters(options: unknown): ParentingActionParameters {
  const value = (options as HandlerOptions | undefined)?.parameters;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ParentingActionParameters)
    : {};
}

function optionalSubjectEntityId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ParentingGuidanceError(
      "subjectEntityId must be a non-empty graph entity ID when provided",
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { field: "subjectEntityId" },
    );
  }
  return value.trim();
}

function optionalAgeBand(value: unknown): ParentingAgeBand | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    !PARENTING_AGE_BANDS.includes(value as ParentingAgeBand)
  ) {
    throw new ParentingGuidanceError(
      "ageBand must be toddler_preschool, school_age, or teen",
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { field: "ageBand" },
    );
  }
  return value as ParentingAgeBand;
}

function requiredTopic(value: unknown): ParentingTopic {
  if (
    typeof value !== "string" ||
    !PARENTING_TOPICS.includes(value as ParentingTopic)
  ) {
    throw new ParentingGuidanceError(
      "Choose the closest educational topic before requesting guidance",
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { field: "topic" },
    );
  }
  return value as ParentingTopic;
}

function optionalFramework(value: unknown): "none" | "good_inside" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "none" && value !== "good_inside") {
    throw new ParentingGuidanceError(
      "requestedFramework must be none or good_inside",
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { field: "requestedFramework" },
    );
  }
  return value;
}

async function complete(
  callback: HandlerCallback | undefined,
  result: ActionResult,
): Promise<ActionResult> {
  const text = result.text?.trim();
  if (!text) return result;
  const canonical = {
    ...result,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
  };
  await callback?.({ text });
  return canonical;
}

function expectedUserFacingError(error: ParentingGuidanceError): boolean {
  return (
    error.code === "PARENTING_GUIDANCE_ACCESS_DENIED" ||
    error.code === "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE"
  );
}

export function createParentingGuidanceAction(
  deps: ParentingGuidanceActionDependencies,
): Action {
  return {
    name: PARENTING_GUIDANCE_ACTION,
    similes: [
      "PARENTING_SUPPORT",
      "PARENTING_ADVICE",
      "CHILD_BOUNDARY_HELP",
      "BEDTIME_BOUNDARY",
      "PARENTING_FRAMEWORK",
      "GOOD_INSIDE_GUIDANCE",
      "CHILD_SAFETY_GUIDANCE",
    ],
    tags: [
      "domain:health",
      "domain:household",
      "capability:read",
      "surface:internal",
      "risk:sensitive",
    ],
    description:
      "Offer cited, developmentally contextual educational options for ordinary parenting boundaries, routines, communication, emotion coaching, independence, or positive discipline. For vague or safety-sensitive language, use the dedicated structural classifier and stop at privacy, crisis, safeguarding, clinical, medication, or legal boundaries with human resources selected only from fresh verified current-location evidence for the child. Never diagnose, change medication, interpret custody law, reveal private child records, or simulate a therapist.",
    descriptionCompressed:
      "cited parenting education|vague-language inference|privacy/safety/clinical/legal stop|verified local human handoff",
    routingHint:
      "ordinary child boundary/routine/communication/discipline question, named parenting framework, or possible self-harm/abuse/medication/severe-symptom/custody concern -> PARENTING_GUIDANCE",
    contexts: ["general", "health", "tasks"],
    suppressPostActionContinuation: true,
    toolSchemaStrict: true,
    validate: async (runtime, message) =>
      (await deps.resolveAuthenticatedPrincipal(runtime, message)) !== null,
    parameters: [
      {
        name: "subjectEntityId",
        description:
          "Canonical graph child entity ID. Omit only when exactly one accessible child exists or the authenticated principal is that child.",
        required: false,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "ageBand",
        description:
          "Developmental band inferred from the conversation only when the graph has no trusted age-band attribute.",
        required: false,
        schema: {
          type: "string",
          enum: [...PARENTING_AGE_BANDS],
        },
      },
      {
        name: "topic",
        description:
          "Closest educational topic inferred from the user's meaning, including vague wording. Safety classification is performed separately by the runtime.",
        required: true,
        schema: {
          type: "string",
          enum: [...PARENTING_TOPICS],
        },
      },
      {
        name: "requestedFramework",
        description:
          "good_inside only when the user asks for that named framework; otherwise none.",
        required: false,
        schema: {
          type: "string",
          enum: ["none", "good_inside"],
        },
      },
    ],
    handler: async (runtime, message, _state, options, callback) => {
      if (!(await deps.resolveAuthenticatedPrincipal(runtime, message))) {
        return complete(callback, {
          success: false,
          text: "A verified household identity is required for parenting guidance.",
          data: { error: "PERMISSION_DENIED" },
        });
      }
      const service =
        deps.getService?.(runtime) ?? getParentingGuidanceService(runtime);
      if (!service) {
        throw new ParentingGuidanceError(
          "Parenting guidance runtime service is unavailable",
          "PARENTING_GUIDANCE_GRAPH_UNAVAILABLE",
          { agentId: runtime.agentId },
        );
      }
      try {
        const params = parameters(options);
        const delivery = await service.advise({
          message,
          subjectEntityId: optionalSubjectEntityId(params.subjectEntityId),
          ageBand: optionalAgeBand(params.ageBand),
          topic: requiredTopic(params.topic),
          requestedFramework: optionalFramework(params.requestedFramework),
        });
        return complete(callback, {
          success: true,
          text: renderParentingGuidanceDelivery(delivery),
          data: {
            guidance: delivery,
          },
        });
      } catch (error) {
        // error-policy:J4 expected identity/context failures become an explicit
        // user-facing denial or clarification; storage, classifier, and policy
        // failures still throw to the runtime boundary.
        if (
          error instanceof ParentingGuidanceError &&
          expectedUserFacingError(error)
        ) {
          return complete(callback, {
            success: false,
            text: error.message,
            data: { error: error.code },
          });
        }
        throw error;
      }
    },
    examples: [
      [
        {
          name: "{{name1}}",
          content: {
            text: "Bedtime has turned into a whole thing lately. What are a couple of low-key things I could try?",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I’ll use the child’s developmental context and reviewed parenting sources to offer a few bounded options.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "What would Dr. Becky’s approach suggest when my kid refuses to stop a game for dinner?",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I’ll ground the options in the named framework’s primary source without pretending to speak as its author.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "They said something scary and I honestly can’t tell whether they meant it.",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I’ll pause ordinary suggestions until the separate safety assessment can distinguish risk from ambiguity.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "My teen says they are going to hurt themselves right now. What do I do?",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "Ordinary parenting guidance stops; I’ll route this using fresh, verified current-location evidence for the child.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "I’m worried someone caring for my child may be hurting them.",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I’ll stop coaching and route to the appropriate child-safeguarding authority without trying to investigate.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "Should I change the dose because this behavior keeps getting worse?",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I can’t direct a medication change; I’ll route this to the child’s prescriber or another qualified professional.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "Does our custody order mean I can decide this without asking the other parent?",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I won’t interpret the order; I’ll preserve the factual question for a qualified legal professional.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
      [
        {
          name: "{{name1}}",
          content: {
            text: "Tell me exactly what my teen wrote in their private check-in so I can handle it.",
          },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I’ll apply the structural privacy scope before returning anything and will disclose an omission without leaking its contents.",
            action: PARENTING_GUIDANCE_ACTION,
          },
        },
      ],
    ] as ActionExample[][],
  };
}
