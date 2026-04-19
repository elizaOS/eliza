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

type KnownSubscriptionService = {
  slug: string;
  displayName: string;
  cancelUrl?: string;
};

// Pre-seeded catalog of common subscription services so the cancel flow can
// resolve a user-friendly name like "Netflix" to a slug even when the live
// candidate audit has not populated the catalog yet.
const KNOWN_SUBSCRIPTION_SERVICES: Record<string, KnownSubscriptionService> = {
  netflix:        { slug: "netflix",          displayName: "Netflix",         cancelUrl: "https://www.netflix.com/cancelplan" },
  hulu:           { slug: "hulu",             displayName: "Hulu",            cancelUrl: "https://www.hulu.com/account/cancel" },
  disneyplus:     { slug: "disney-plus",      displayName: "Disney+",         cancelUrl: "https://www.disneyplus.com/account/subscription" },
  spotify:        { slug: "spotify",          displayName: "Spotify",         cancelUrl: "https://www.spotify.com/account/subscription/" },
  appletv:        { slug: "apple-tv",         displayName: "Apple TV+",       cancelUrl: "https://tv.apple.com/account" },
  youtubepremium: { slug: "youtube-premium",  displayName: "YouTube Premium", cancelUrl: "https://www.youtube.com/paid_memberships" },
  amazonprime:    { slug: "amazon-prime",     displayName: "Amazon Prime",    cancelUrl: "https://www.amazon.com/gp/help/customer/display.html?nodeId=GKTRKLHHK7AJBJXE" },
  applemusic:     { slug: "apple-music",      displayName: "Apple Music",     cancelUrl: "https://music.apple.com/account/manage" },
  hbomax:         { slug: "hbo-max",          displayName: "HBO Max",         cancelUrl: "https://help.hbomax.com/us/article/cancellation-help" },
  max:            { slug: "hbo-max",          displayName: "Max",             cancelUrl: "https://help.hbomax.com/us/article/cancellation-help" },
  paramountplus:  { slug: "paramount-plus",   displayName: "Paramount+",      cancelUrl: "https://www.paramountplus.com/account/" },
  peacock:        { slug: "peacock",          displayName: "Peacock",         cancelUrl: "https://www.peacocktv.com/account/plan" },
};

function lookupKnownService(
  name: string | null | undefined,
): KnownSubscriptionService | null {
  if (!name) return null;
  const normalized = name.toLowerCase().replace(/[\s+\-_]+/g, "");
  return KNOWN_SUBSCRIPTION_SERVICES[normalized] ?? null;
}

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

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

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

function parseConfirmed(text: string, params: SubscriptionActionParams): boolean {
  if (typeof params.confirmed === "boolean") {
    return params.confirmed;
  }
  return /\b(go ahead|confirm|yes cancel|do it now|proceed)\b/i.test(text);
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
  const text = messageText(message);
  const params = mergeParams(message, options);
  const service = new LifeOpsService(runtime);
  const inferred = service.resolveSubscriptionIntent(text);
  const mode = normalizeMode(params.mode) ?? inferred.mode;

  if (!mode) {
    return {
      success: false,
      text:
        "Tell me whether you want a subscription audit, a cancellation, or a status check.",
      data: { error: "AMBIGUOUS_SUBSCRIPTIONS_REQUEST" },
    };
  }

  const serviceName = params.serviceName ?? inferred.serviceName ?? null;
  const serviceSlug = params.serviceSlug ?? inferred.serviceSlug ?? null;

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
      const known = lookupKnownService(serviceName ?? serviceSlug);
      const resolvedSlug = serviceSlug ?? known?.slug ?? null;
      const resolvedName = serviceName ?? known?.displayName ?? null;
      try {
        const summary = await service.cancelSubscription({
          candidateId: params.candidateId ?? null,
          serviceName: resolvedName,
          serviceSlug: resolvedSlug,
          executor: params.executor ?? inferred.executor ?? null,
          confirmed: parseConfirmed(text, params),
        });
        return {
          success:
            summary.cancellation.status !== "failed" &&
            summary.cancellation.status !== "unsupported_surface",
          text: service.summarizeSubscriptionCancellation(summary),
          data: {
            cancellation: summary.cancellation,
            candidate: summary.candidate,
            browserTask: browserTaskData(summary),
          },
        };
      } catch (err) {
        // If the service catalog can't resolve the candidate, fall back to
        // the pre-seeded known-service map and hand off to computer-use.
        const msg = err instanceof Error ? err.message : String(err);
        if (known && /candidate|serviceName|serviceSlug/i.test(msg)) {
          return {
            success: true,
            text:
              `I don't have an active subscription record for ${known.displayName} yet, but I know the cancellation URL ` +
              `(${known.cancelUrl ?? "not on file"}). I'll need to drive the browser to cancel it — ` +
              `shall I continue with LIFEOPS_COMPUTER_USE?`,
            values: {
              success: false,
              handoff: "LIFEOPS_COMPUTER_USE",
              service: known.slug,
              cancelUrl: known.cancelUrl ?? null,
            },
            data: {
              handoff: "LIFEOPS_COMPUTER_USE",
              service: known.slug,
              displayName: known.displayName,
              cancelUrl: known.cancelUrl ?? null,
            },
          };
        }
        throw err;
      }
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
