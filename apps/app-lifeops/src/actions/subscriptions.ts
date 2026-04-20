import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasLifeOpsAccess, INTERNAL_URL } from "./lifeops-google-helpers.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import type { LifeOpsSubscriptionExecutor } from "../lifeops/subscriptions-types.js";

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

function parseConfirmed(params: SubscriptionActionParams): boolean {
  return typeof params.confirmed === "boolean" ? params.confirmed : false;
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
  void state;
  void message;
  const params = mergeParams(message, options);
  const service = new LifeOpsService(runtime);
  const mode = normalizeMode(params.mode);

  if (!mode) {
    return {
      success: false,
      text:
        "Tell me whether you want a subscription audit, a cancellation, or a status check.",
      data: { error: "AMBIGUOUS_SUBSCRIPTIONS_REQUEST" },
    };
  }

  const serviceName = params.serviceName ?? null;
  const serviceSlug = params.serviceSlug ?? null;

  switch (mode) {
    case "audit": {
      const summary = await service.auditSubscriptions(INTERNAL_URL, {
        queryWindowDays: params.queryWindowDays,
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
        serviceName: serviceName ?? null,
        serviceSlug: serviceSlug ?? null,
        executor: params.executor ?? null,
        confirmed: parseConfirmed(params),
      });
      const playbookNotImplemented =
        summary.cancellation.status === "unsupported_surface" &&
        typeof summary.cancellation.error === "string" &&
        summary.cancellation.error.startsWith("PLAYBOOK_NOT_IMPLEMENTED");
      return {
        success:
          summary.cancellation.status !== "failed" &&
          summary.cancellation.status !== "unsupported_surface",
        text: service.summarizeSubscriptionCancellation(summary),
        data: {
          cancellation: summary.cancellation,
          candidate: summary.candidate,
          browserTask: browserTaskData(summary),
          ...(playbookNotImplemented
            ? {
                error: "PLAYBOOK_NOT_IMPLEMENTED",
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
      content: { text: "Audit my subscriptions and tell me what I can cancel." },
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
];

export const subscriptionsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "SUBSCRIPTION_AUDIT",
    "SUBSCRIPTION_CANCEL",
    "UNSUBSCRIBE_SERVICE",
    "MANAGE_SUBSCRIPTIONS",
    "CANCEL_NETFLIX",
    "CANCEL_HULU",
    "CANCEL_APP_STORE_SUBSCRIPTION",
    "CANCEL_GOOGLE_PLAY_SUBSCRIPTION",
  ],
  description:
    "Audit recurring subscriptions from LifeOps signals, cancel supported subscriptions through the browser, and report cancellation status with artifacts and human-handoff states. " +
    "Use this for requests like 'cancel my Netflix subscription', 'cancel Hulu in my browser', 'cancel my Google Play subscription', or 'cancel my App Store subscription on this Mac'.",
  suppressPostActionContinuation: true,
  validate: async (runtime: IAgentRuntime, message: Memory) =>
    hasLifeOpsAccess(runtime, message),
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
