import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared/contracts/lifeops";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { hasLifeOpsAccess, messageText } from "./lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";

type XReadSubaction = "read_dms" | "read_feed" | "search";

type XReadActionParams = {
  subaction?: XReadSubaction;
  intent?: string;
  query?: string;
  feedType?: LifeOpsXFeedType;
  limit?: number;
};

type XReadLlmPlan = {
  subaction: XReadSubaction | null;
  query?: string;
  feedType?: LifeOpsXFeedType;
  limit?: number;
  shouldAct?: boolean | null;
  response?: string;
};

function normalizeSubaction(value: unknown): XReadSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "read_dms" || normalized === "dms") return "read_dms";
  if (normalized === "read_feed" || normalized === "feed") return "read_feed";
  if (normalized === "search") return "search";
  return null;
}

function normalizeFeedType(value: unknown): LifeOpsXFeedType {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "home_timeline" || normalized === "home" || normalized === "timeline") {
      return "home_timeline";
    }
    if (normalized === "mentions") return "mentions";
    if (normalized === "search") return "search";
  }
  return "home_timeline";
}

function normalizeOptionalFeedType(
  value: unknown,
): LifeOpsXFeedType | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return normalizeFeedType(value);
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(100, Math.floor(value));
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
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

async function resolveXReadPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
}): Promise<XReadLlmPlan> {
  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 8,
    })
  ).join("\n");
  const currentMessage = messageText(args.message).trim();
  const prompt = [
    "Plan the X read action for this request.",
    "The user may speak in any language.",
    "Use the current request plus recent conversation context.",
    "Return a JSON object with exactly these fields:",
    "  subaction: one of read_dms, read_feed, search, or null",
    "  feedType: one of home_timeline or mentions when subaction is read_feed, otherwise null",
    "  query: short search query when subaction is search, otherwise empty or null",
    "  limit: optional integer 1-100 when the user explicitly requests an amount",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false or clarification is needed",
    "",
    "Use read_dms for direct messages or inbox reads.",
    "Use read_feed for the timeline or mentions feed.",
    "Use search only when the user is explicitly asking to find posts by keyword, phrase, author, or topic.",
    "Set feedType=mentions when the user asks for mentions; otherwise use home_timeline for feed reads.",
    "Set shouldAct=false when the user is vague or only asks for general X help.",
    "",
    "Examples:",
    '  "check my X DMs" -> {"subaction":"read_dms","feedType":null,"query":null,"limit":null,"shouldAct":true,"response":null}',
    '  "show me my mentions" -> {"subaction":"read_feed","feedType":"mentions","query":null,"limit":null,"shouldAct":true,"response":null}',
    '  "search X for Milady" -> {"subaction":"search","feedType":null,"query":"Milady","limit":null,"shouldAct":true,"response":null}',
    '  "help me with X" -> {"subaction":null,"feedType":null,"query":null,"limit":null,"shouldAct":false,"response":"Do you want me to read your X DMs, timeline, mentions, or run a search?"}',
    "",
    "Return ONLY valid JSON.",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      return {
        subaction: null,
        shouldAct: null,
      };
    }

    return {
      subaction: normalizeSubaction(parsed.subaction),
      query:
        typeof parsed.query === "string" && parsed.query.trim().length > 0
          ? parsed.query.trim()
          : undefined,
      feedType: normalizeOptionalFeedType(parsed.feedType),
      limit: normalizeLimit(parsed.limit),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:x-read",
        error: error instanceof Error ? error.message : String(error),
      },
      "X read planning model call failed",
    );
    return {
      subaction: null,
      shouldAct: null,
    };
  }
}

function summarizeDms(dms: LifeOpsXDm[]): string {
  if (dms.length === 0) return "No X DMs found.";
  const preview = dms
    .slice(0, 10)
    .map((dm) => {
      const who = dm.senderHandle ? `@${dm.senderHandle}` : dm.senderId || "unknown";
      return `- ${who}: ${dm.text}`;
    })
    .join("\n");
  return `X DMs (${dms.length}):\n${preview}`;
}

function summarizeFeedItems(items: LifeOpsXFeedItem[], feedType: LifeOpsXFeedType): string {
  if (items.length === 0) return `No items in X ${feedType}.`;
  const preview = items
    .slice(0, 10)
    .map((item) => {
      const who = item.authorHandle ? `@${item.authorHandle}` : item.authorId || "unknown";
      return `- ${who}: ${item.text}`;
    })
    .join("\n");
  return `X ${feedType} (${items.length}):\n${preview}`;
}

export const xReadAction: Action = {
  name: "X_READ",
  similes: [
    "READ_X",
    "READ_TWITTER",
    "CHECK_TWITTER_DMS",
    "TWITTER_TIMELINE",
    "X_TIMELINE",
    "TWITTER_MENTIONS",
    "SEARCH_TWITTER",
    "X_DMS",
    "X_FEED",
    "X_SEARCH",
  ],
  description:
    "Read X/Twitter DMs, the home timeline or mentions feed, or run a recent search. " +
    "Use this for requests like 'check my Twitter DMs', 'what's on my X timeline?', 'show me my mentions', or 'search Twitter for posts about elizaOS'. " +
    "Use this for retrieving content from X, not posting. Do not reply that X/Twitter access is unavailable when this action is registered and visible.",

  validate: async (runtime, message) => {
    if (!(await hasLifeOpsAccess(runtime, message))) return false;
    const service = new LifeOpsService(runtime);
    try {
      const status = await service.getXConnectorStatus();
      return Boolean(status.connected);
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }

    const params = (options?.parameters ?? {}) as XReadActionParams;
    const intent = (params.intent ?? messageText(message) ?? "").trim();
    const explicitSubaction = normalizeSubaction(params.subaction);
    const llmPlan = await resolveXReadPlanWithLlm({
      runtime,
      message,
      state,
      intent,
    });
    const subaction = explicitSubaction ?? llmPlan.subaction;
    const feedType = normalizeFeedType(params.feedType ?? llmPlan.feedType);
    const limit = normalizeLimit(params.limit ?? llmPlan.limit);
    const query =
      typeof params.query === "string" && params.query.trim().length > 0
        ? params.query.trim()
        : llmPlan.query ?? "";

    const service = new LifeOpsService(runtime);
    const respond = async (payload: ActionResult): Promise<ActionResult> => {
      await callback?.({
        text: payload.text ?? "",
        source: "action",
        action: "X_READ",
      });
      return payload;
    };

    if (
      llmPlan.shouldAct === false &&
      !explicitSubaction &&
      !params.query &&
      !params.feedType &&
      params.limit === undefined
    ) {
      return respond({
        success: true,
        text:
          llmPlan.response ??
          "Do you want me to read your X DMs, timeline, mentions, or run a search?",
        data: { noop: true },
      });
    }

    if (!subaction) {
      return respond({
        success: false,
        text:
          llmPlan.response ??
          "Do you want me to read your X DMs, timeline, mentions, or run a search?",
        data: { error: "MISSING_SUBACTION" },
      });
    }

    try {
      if (subaction === "read_dms") {
        const syncResult = await service.syncXDms({ limit });
        const dms = await service.getXDms({ limit });
        return respond({
          success: true,
          text: summarizeDms(dms),
          data: {
            subaction,
            synced: syncResult.synced,
            items: dms,
          },
        });
      }

      if (subaction === "search") {
        if (query.length === 0) {
          return respond({
            success: false,
            text: "Please provide a search query.",
            data: { subaction, error: "MISSING_QUERY" },
          });
        }
        const results = await service.searchXPosts(query, { limit });
        return respond({
          success: true,
          text: summarizeFeedItems(results, "search"),
          data: {
            subaction,
            query,
            items: results,
          },
        });
      }

      const effectiveFeedType: LifeOpsXFeedType =
        feedType === "search" ? "home_timeline" : feedType;
      const syncResult = await service.syncXFeed(effectiveFeedType, { limit });
      const items = await service.getXFeedItems(effectiveFeedType, { limit });
      return respond({
        success: true,
        text: summarizeFeedItems(items, effectiveFeedType),
        data: {
          subaction,
          feedType: effectiveFeedType,
          synced: syncResult.synced,
          items,
        },
      });
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        return respond({
          success: false,
          text: error.message,
          data: {
            subaction,
            error: "X_READ_FAILED",
            status: error.status,
          },
        });
      }
      throw error;
    }
  },

  parameters: [
    {
      name: "subaction",
      description:
        "X read operation. read_dms for direct messages, read_feed for timeline/mentions, search for recent tweet search.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["read_dms", "read_feed", "search"],
      },
    },
    {
      name: "intent",
      description:
        'Free-text description of the request, e.g. "check my X DMs", "show my mentions", "search X for elizaOS".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description: "Search query string for the search subaction.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "feedType",
      description:
        "Feed to read for read_feed. One of home_timeline (default), mentions, or search.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["home_timeline", "mentions", "search"],
      },
    },
    {
      name: "limit",
      description: "Max items to return (1-100).",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Check my X DMs." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "X DMs (2):\n- @alice: hey!\n- @bob: see you tomorrow",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What's on my X timeline?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "X home_timeline (5):\n- @carol: great post!",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What are my recent X mentions?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "X mentions (3):\n- @carol: great post!",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Search Twitter for posts about elizaOS." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "X search (5):\n- @dev: elizaOS is shipping fast",
        },
      },
    ],
  ] as ActionExample[][],
};
