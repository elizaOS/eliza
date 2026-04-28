import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { hasLifeOpsAccess, INTERNAL_URL } from "./lifeops-google-helpers.js";

type EmailUnsubscribeSubaction = "scan" | "unsubscribe" | "history";

type EmailUnsubscribeActionParams = {
  mode?: EmailUnsubscribeSubaction;
  senderEmail?: string;
  listId?: string | null;
  query?: string | null;
  maxMessages?: number;
  blockAfter?: boolean;
  trashExisting?: boolean;
  confirmed?: boolean;
  limit?: number;
};

const ACTION_NAME = "EMAIL_UNSUBSCRIBE";

function mergeParams(
  message: Memory,
  options?: HandlerOptions,
): EmailUnsubscribeActionParams {
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
  return params as EmailUnsubscribeActionParams;
}

function normalizeMode(value: unknown): EmailUnsubscribeSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "scan" ||
    normalized === "unsubscribe" ||
    normalized === "history"
  ) {
    return normalized;
  }
  return null;
}

async function runEmailUnsubscribeAction(
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
      text: "Tell me whether you want to scan your inbox for subscriptions, unsubscribe from a specific sender, or view the unsubscribe history.",
      data: { error: "AMBIGUOUS_EMAIL_UNSUBSCRIBE_REQUEST" },
    };
  }

  switch (mode) {
    case "scan": {
      const result = await service.scanEmailSubscriptions(INTERNAL_URL, {
        query: params.query ?? null,
        maxMessages: params.maxMessages ?? null,
      });
      return {
        success: true,
        text: service.summarizeEmailUnsubscribeScan(result),
        data: {
          summary: result.summary,
          senders: result.senders,
          syncedAt: result.syncedAt,
          query: result.query,
        },
      };
    }
    case "unsubscribe": {
      if (!params.senderEmail) {
        return {
          success: false,
          text: "Tell me which sender to unsubscribe from (senderEmail).",
          data: { error: "MISSING_SENDER_EMAIL" },
        };
      }
      const result = await service.unsubscribeEmailSender(INTERNAL_URL, {
        senderEmail: params.senderEmail,
        listId: params.listId ?? null,
        blockAfter: params.blockAfter ?? false,
        trashExisting: params.trashExisting ?? false,
        confirmed: params.confirmed ?? false,
      });
      return {
        success:
          result.record.status === "succeeded" ||
          result.record.status === "manual_required",
        text: service.summarizeEmailUnsubscribeResult(result),
        data: { record: result.record },
      };
    }
    case "history": {
      const records = await service.listEmailUnsubscribes(params.limit ?? 50);
      const summary =
        records.length === 0
          ? "No unsubscribe actions recorded yet."
          : `Recorded ${records.length} unsubscribe action${records.length === 1 ? "" : "s"}.`;
      return {
        success: true,
        text: summary,
        data: { records },
      };
    }
  }
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Scan my Gmail for newsletters and subscriptions I can unsubscribe from.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll scan your inbox for promotional senders, aggregate them by sender, and report which ones support one-click unsubscribe.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "Unsubscribe me from newsletters@medium.com and block them.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll send the List-Unsubscribe request. If Gmail manage access is available, I can also add a blocking filter.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Show me which subscriptions I've unsubscribed from." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll list every recorded Gmail unsubscribe action with the method, status, and whether a block filter was created.",
        actions: [ACTION_NAME],
      },
    },
  ],
];

export const emailUnsubscribeAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "UNSUBSCRIBE_EMAIL",
    "GMAIL_UNSUBSCRIBE",
    "CLEAN_GMAIL_INBOX",
    "STOP_PROMOTIONAL_EMAILS",
    "LIST_EMAIL_SUBSCRIPTIONS",
    "AUTO_UNSUBSCRIBE",
    "BULK_UNSUBSCRIBE",
  ],
  description:
    "Scan the connected Gmail inbox for promotional senders using List-Unsubscribe headers, execute RFC 8058 one-click unsubscribe or mailto fallback, and optionally create a Gmail filter to auto-trash future mail. " +
    "Use for requests like 'scan my inbox for subscriptions', 'unsubscribe me from <sender>', or 'clean up my promotional emails'. " +
    "Distinct from SUBSCRIPTIONS (paid service cancellation): this stops future email from a sender, it does not cancel a paid service account.",
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
      return await runEmailUnsubscribeAction(runtime, message, state, options);
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
