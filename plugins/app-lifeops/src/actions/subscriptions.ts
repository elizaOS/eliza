import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { PLAYBOOK_NOT_IMPLEMENTED_ERROR } from "../lifeops/subscriptions-playbooks.js";
import type { LifeOpsSubscriptionExecutor } from "../lifeops/subscriptions-types.js";
import { formatPromptSection } from "./lib/prompt-format.js";
import { recentConversationTexts } from "./lib/recent-context.js";
import { INTERNAL_URL, messageText } from "./lifeops-google-helpers.js";

type SubscriptionSubaction = "audit" | "cancel" | "status";

type SubscriptionActionParams = {
  mode?: SubscriptionSubaction;
  serviceName?: string;
  serviceSlug?: string;
  candidateId?: string;
  cancellationId?: string;
  executor?: LifeOpsSubscriptionExecutor;
  queryWindowDays?: number;
  confirmed?: boolean;
};

type SubscriptionActionPlan = {
  mode?: SubscriptionSubaction | null;
  serviceName?: string;
  serviceSlug?: string;
  executor?: LifeOpsSubscriptionExecutor;
  queryWindowDays?: number;
  confirmed?: boolean | null;
  shouldAct?: boolean | null;
  response?: string;
};

const ACTION_NAME = "SUBSCRIPTIONS";

function mergeParams(
  message: Memory,
  options?: HandlerOptions,
): SubscriptionActionParams {
  const params = {
    ...(((options as Record<string, unknown> | undefined)?.parameters ??
      {}) as Record<string, unknown>),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(
      message.content as Record<string, unknown>,
    )) {
      if (params[key] === undefined) {
        params[key] = value;
      }
    }
  }
  return params as SubscriptionActionParams;
}

function normalizeMode(value: unknown): SubscriptionSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "audit" ||
    normalized === "cancel" ||
    normalized === "status"
  ) {
    return normalized;
  }
  return null;
}

function normalizeExecutor(
  value: unknown,
): LifeOpsSubscriptionExecutor | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "user_browser" ||
    normalized === "agent_browser" ||
    normalized === "desktop_native"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizePlannerNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const whole = Math.floor(value);
  return whole > 0 ? whole : undefined;
}

function normalizePlannerBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveSubscriptionsPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  params: SubscriptionActionParams;
}): Promise<SubscriptionActionPlan> {
  const recentConversation = (
    await recentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 8,
    })
  ).join("\n");
  const currentMessage = messageText(args.message).trim();
  const prompt = [
    "Plan the SUBSCRIPTIONS action for this request.",
    "Use the current request, recent conversation, and any already-extracted parameters.",
    "Return TOON only with exactly these fields:",
    "  mode: one of audit, cancel, status, or null",
    "  serviceName: subscription service display name or null",
    "  serviceSlug: normalized service slug or null",
    "  executor: one of user_browser, agent_browser, desktop_native, or null",
    "  queryWindowDays: integer number of days for audits, or null",
    "  confirmed: boolean or null",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false or clarification is needed",
    "",
    "Rules:",
    "- Use cancel for subscription cancellation requests, including requests that mention login, MFA, or sign-in walls.",
    "- Use status for follow-ups asking what happened with a cancellation or whether it completed.",
    "- Use audit for subscription reviews, audits, and lists of recurring services.",
    "- When the user is confirming an already discussed cancellation, set confirmed=true and carry forward the same service from context.",
    "- Use user_browser when the request explicitly says to use the user's browser. Otherwise prefer agent_browser.",
    "- Return only TOON.",
    "",
    "Examples:",
    '  "Cancel Fixture Access Wall; if the site needs login, pause and tell me what credential is missing."',
    "  -> mode: cancel; serviceName: Fixture Access Wall; serviceSlug: fixture-access-wall; executor: agent_browser; queryWindowDays: null; confirmed: false; shouldAct: true; response: null",
    '  "yes go ahead" after a pending cancellation for Netflix',
    "  -> mode: cancel; serviceName: Netflix; serviceSlug: netflix; executor: agent_browser; queryWindowDays: null; confirmed: true; shouldAct: true; response: null",
    '  "audit my subscriptions from the last 90 days"',
    "  -> mode: audit; serviceName: null; serviceSlug: null; executor: null; queryWindowDays: 90; confirmed: null; shouldAct: true; response: null",
    '  "what happened with that subscription cancellation?"',
    "  -> mode: status; serviceName: null; serviceSlug: null; executor: null; queryWindowDays: null; confirmed: null; shouldAct: true; response: null",
    "",
    formatPromptSection("Current request", currentMessage),
    formatPromptSection("Existing parameters", args.params),
    formatPromptSection("Recent conversation", recentConversation),
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-subscriptions" },
      () =>
        args.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(rawResponse);
    if (!parsed) {
      return {};
    }
    return {
      mode: normalizeMode(parsed.mode),
      serviceName: normalizePlannerResponse(parsed.serviceName),
      serviceSlug: normalizePlannerResponse(parsed.serviceSlug),
      executor: normalizeExecutor(parsed.executor),
      queryWindowDays: normalizePlannerNumber(parsed.queryWindowDays),
      confirmed: normalizePlannerBoolean(parsed.confirmed),
      shouldAct: normalizePlannerBoolean(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:subscriptions",
        error: error instanceof Error ? error.message : String(error),
      },
      "Subscriptions planning model call failed",
    );
    return {};
  }
}

function browserTaskData(
  result: Awaited<ReturnType<LifeOpsService["cancelSubscription"]>>,
): Record<string, unknown> {
  const artifacts = Array.isArray(result.cancellation.metadata.artifacts)
    ? result.cancellation.metadata.artifacts
    : [];
  return {
    status: result.cancellation.status,
    completed: result.cancellation.status === "completed",
    needsHuman: [
      "awaiting_confirmation",
      "needs_login",
      "needs_mfa",
      "needs_user_choice",
      "retention_offer",
      "phone_only",
      "chat_only",
      "blocked",
    ].includes(result.cancellation.status),
    artifactCount: result.cancellation.artifactCount,
    artifacts,
  };
}

async function runSubscriptionsAction(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options?: HandlerOptions,
): Promise<ActionResult> {
  const params = mergeParams(message, options);
  const service = new LifeOpsService(runtime);
  // Trust planner-supplied mode. The action planner has already chosen the
  // subaction, and the shared LLM param extractor (in handlers that route
  // here through an umbrella) has already filled in any missing mode field.
  // Only fall back to the in-handler LLM planner when the mode is genuinely
  // missing — running it unconditionally just throws away correct hints
  // (this was the root cause of subscriptions-cancel-* never completing).
  const trustedMode = normalizeMode(params.mode);
  const planner = trustedMode
    ? {
        mode: trustedMode,
        shouldAct: true as const,
        response: null,
        serviceName: null,
        serviceSlug: null,
        executor: null,
        confirmed: null,
        queryWindowDays: undefined as number | undefined,
      }
    : await resolveSubscriptionsPlanWithLlm({
        runtime,
        message,
        state,
        params,
      });
  const mode = trustedMode ?? planner.mode ?? null;

  if (planner.shouldAct === false && planner.response) {
    return {
      success: true,
      text: planner.response,
      data: { actionName: ACTION_NAME, acted: false },
    };
  }
  if (!mode) {
    return {
      success: false,
      text:
        planner.response ??
        "Tell me whether you want a subscription audit, a cancellation, or a status check.",
      values: {
        success: false,
        error: "AMBIGUOUS_SUBSCRIPTIONS_REQUEST",
        requiresConfirmation: true,
      },
      data: {
        actionName: ACTION_NAME,
        error: "AMBIGUOUS_SUBSCRIPTIONS_REQUEST",
        requiresConfirmation: true,
      },
    };
  }

  const serviceName = params.serviceName ?? planner.serviceName ?? null;
  const serviceSlug = params.serviceSlug ?? planner.serviceSlug ?? null;
  const executor = params.executor ?? planner.executor ?? null;
  const confirmed =
    typeof params.confirmed === "boolean"
      ? params.confirmed
      : planner.confirmed === true;

  switch (mode) {
    case "audit": {
      const summary = await service.auditSubscriptions(INTERNAL_URL, {
        queryWindowDays: params.queryWindowDays ?? planner.queryWindowDays,
        serviceQuery: serviceName ?? serviceSlug,
      });
      return {
        success: true,
        text: service.summarizeSubscriptionAudit(summary),
        data: {
          audit: summary.audit,
          candidates: summary.candidates,
          report: {
            totalCandidates: summary.audit.totalCandidates,
            activeCandidates: summary.audit.activeCandidates,
            canceledCandidates: summary.audit.canceledCandidates,
            uncertainCandidates: summary.audit.uncertainCandidates,
          },
        },
      };
    }
    case "cancel": {
      const summary = await service.cancelSubscription({
        candidateId: params.candidateId ?? null,
        serviceName,
        serviceSlug,
        executor,
        confirmed,
      });
      const playbookNotImplemented =
        summary.cancellation.status === "unsupported_surface" &&
        typeof summary.cancellation.error === "string" &&
        summary.cancellation.error.startsWith(PLAYBOOK_NOT_IMPLEMENTED_ERROR);
      // Cancellation flows that legitimately stop at a "needs human" handoff
      // (awaiting confirmation, MFA, retention offer, sign-in, no automated
      // playbook yet, etc.) are NOT execution failures: the action correctly
      // reached its terminal pending-confirmation state. Surface that to the
      // runtime + benchmark scorer via `requiresConfirmation`.
      const needsHumanHandoff =
        browserTaskData(summary).needsHuman === true || playbookNotImplemented;
      return {
        success:
          summary.cancellation.status !== "failed" &&
          summary.cancellation.status !== "unsupported_surface",
        text: service.summarizeSubscriptionCancellation(summary),
        ...(needsHumanHandoff
          ? { values: { requiresConfirmation: true } }
          : {}),
        data: {
          cancellation: summary.cancellation,
          candidate: summary.candidate,
          browserTask: browserTaskData(summary),
          ...(needsHumanHandoff ? { requiresConfirmation: true } : {}),
          ...(playbookNotImplemented
            ? {
                error: PLAYBOOK_NOT_IMPLEMENTED_ERROR,
                serviceSlug: summary.cancellation.serviceSlug,
                managementUrl: summary.cancellation.managementUrl,
              }
            : {}),
        },
      };
    }
    case "status": {
      const summary = await service.getSubscriptionCancellationStatus({
        cancellationId: params.cancellationId ?? null,
        serviceName,
        serviceSlug,
      });
      if (!summary) {
        const latestAudit = await service.getLatestSubscriptionAudit();
        if (latestAudit) {
          return {
            success: true,
            text: service.summarizeSubscriptionAudit(latestAudit),
            data: {
              audit: latestAudit.audit,
              candidates: latestAudit.candidates,
            },
          };
        }
        return {
          success: true,
          text: "No subscription audit or cancellation state is available yet.",
          data: { audit: null, cancellation: null },
        };
      }
      return {
        success: true,
        text: service.summarizeSubscriptionCancellation(summary),
        data: {
          cancellation: summary.cancellation,
          candidate: summary.candidate,
          browserTask: browserTaskData(summary),
        },
      };
    }
  }
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Audit my subscriptions and tell me what I can cancel.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll audit recent subscription signals and summarize what looks active, already canceled, or worth reviewing.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Cancel my Google Play subscription." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll open the subscription flow, stop before the irreversible step if confirmation is needed, and then report the outcome.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Cancel my Netflix subscription." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll open the subscription flow for Netflix, pause for confirmation if needed, and then report the result.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Cancel Hulu in my browser." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll route this through the subscription cancellation flow instead of generic website blocking and tell you what happened.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Cancel my App Store subscription on this Mac." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll use the subscription cancellation flow for the App Store and report whether it needs any manual confirmation.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "Cancel my subscription even if the site makes me sign in first.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll run the subscription cancellation flow, stop if the site requires sign-in or other human handoff, and report the exact status.",
        actions: [ACTION_NAME],
      },
    },
  ],
];

export const subscriptionsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "CANCEL_SUBSCRIPTION",
    "AUDIT_SUBSCRIPTIONS",
    "CANCEL_NETFLIX",
    "CANCEL_HULU",
    "MANAGE_SUBSCRIPTIONS",
  ],
  description:
    "Audit recurring subscriptions from LifeOps signals, cancel supported subscriptions through the browser, and report cancellation status with artifacts and human-handoff states.",
  descriptionCompressed:
    "paid sub audit+cancel via browser: audit | cancel(serviceSlug confirmed) | status(cancellationId); not email-list-unsubscribe",

  parameters: [
    {
      name: "mode",
      description: "audit | cancel | status when supplied.",
      required: false,
      schema: { type: "string" as const, enum: ["audit", "cancel", "status"] },
    },
    {
      name: "serviceName",
      description: "Display name of the subscription service.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "serviceSlug",
      description: "Normalized slug for routing.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "candidateId",
      description: "Internal audit candidate identifier.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "cancellationId",
      description: "Ongoing cancellation id for status lookups.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "executor",
      description:
        "Browser executor: user_browser | agent_browser | desktop_native.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queryWindowDays",
      description: "Days of history for audit queries.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "confirmed",
      description: "User confirmed cancellation prerequisites.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  suppressPostActionContinuation: true,
  validate: async (runtime: IAgentRuntime, message: Memory) =>
    hasOwnerAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    try {
      return await runSubscriptionsAction(runtime, message, state, options);
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        return {
          success: false,
          text: error.message,
          data: { status: error.status },
        };
      }
      throw error;
    }
  },
  examples,
};
