import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { INTERNAL_URL } from "../lifeops/access.js";
import { messageText } from "../lifeops/google/format-helpers.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { PLAYBOOK_NOT_IMPLEMENTED_ERROR } from "../lifeops/subscriptions-playbooks.js";
import type { LifeOpsSubscriptionExecutor } from "../lifeops/subscriptions-types.js";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import { formatPromptSection } from "./lib/prompt-format.js";
import { recentConversationTexts } from "./lib/recent-context.js";

type SubscriptionSubaction = "audit" | "cancel" | "status";

type SubscriptionActionParams = {
  subaction?: SubscriptionSubaction;
  serviceName?: string;
  serviceSlug?: string;
  candidateId?: string;
  cancellationId?: string;
  executor?: LifeOpsSubscriptionExecutor;
  queryWindowDays?: number;
  confirmed?: boolean;
};

type SubscriptionActionPlan = {
  subaction?: SubscriptionSubaction | null;
  serviceName?: string;
  serviceSlug?: string;
  executor?: LifeOpsSubscriptionExecutor;
  queryWindowDays?: number;
  confirmed?: boolean | null;
  shouldAct?: boolean | null;
  response?: string;
};

const ACTION_NAME = "OWNER_FINANCES";

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

function normalizeSubaction(value: unknown): SubscriptionSubaction | null {
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
    "Plan OWNER_FINANCES subscription handling for this request.",
    "Use the current request, recent conversation, and any already-extracted parameters.",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: one of audit, cancel, status, or null",
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
    "- Return only JSON.",
    "",
    'Example: {"subaction":"cancel","serviceName":"Netflix","serviceSlug":"netflix","executor":"agent_browser","queryWindowDays":null,"confirmed":true,"shouldAct":true,"response":null}',
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
      subaction: normalizeSubaction(parsed.subaction),
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

async function runSubscriptionsActionInner(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options?: HandlerOptions,
): Promise<ActionResult> {
  const params = mergeParams(message, options);
  const service = new LifeOpsService(runtime);
  // Trust the planner-supplied subaction; skip the in-handler LLM only when
  // it's absent. Running the LLM unconditionally just throws away correct
  // hints.
  const trustedSubaction = normalizeSubaction(params.subaction);
  const planner = trustedSubaction
    ? {
        subaction: trustedSubaction,
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
  const subaction = trustedSubaction ?? planner.subaction ?? null;

  if (planner.shouldAct === false && planner.response) {
    return {
      success: true,
      text: planner.response,
      data: { actionName: ACTION_NAME, acted: false },
    };
  }
  if (!subaction) {
    return {
      success: false,
      text:
        planner.response ??
        "Tell me whether you want a subscription audit, a cancellation, or a status check.",
      values: {
        success: false,
        error: "AMBIGUOUS_SUBSCRIPTION_REQUEST",
        requiresConfirmation: true,
      },
      data: {
        actionName: ACTION_NAME,
        error: "AMBIGUOUS_SUBSCRIPTION_REQUEST",
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

  switch (subaction) {
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

/**
 * Handler function backing OWNER_FINANCES subscription_* subactions. The
 * umbrella in `./money.ts` is the only caller; no Action object is registered
 * for this handler.
 */
export async function runSubscriptionsHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  try {
    return await runSubscriptionsActionInner(runtime, message, state, options);
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
}
