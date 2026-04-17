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
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared/contracts/lifeops";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { hasLifeOpsAccess, messageText } from "./lifeops-google-helpers.js";

type XReadSubaction = "read_dms" | "read_feed" | "search";

type XReadActionParams = {
  subaction?: XReadSubaction;
  intent?: string;
  query?: string;
  feedType?: LifeOpsXFeedType;
  limit?: number;
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

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(100, Math.floor(value));
}

/**
 * Infer the X_READ subaction from the user's free-text intent when the caller
 * didn't pick one explicitly. We favour explicit parameters; this is the
 * fallback.
 */
function inferSubactionFromIntent(intent: string): XReadSubaction {
  const text = intent.toLowerCase();
  if (/\b(dm|dms|direct message|inbox)\b/.test(text)) return "read_dms";
  if (/\b(mention|mentions)\b/.test(text)) return "read_feed";
  if (/\b(search|find)\b/.test(text)) return "search";
  return "read_feed";
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
  similes: ["READ_X", "READ_TWITTER", "X_DMS", "X_FEED", "X_SEARCH"],
  description:
    "Read X/Twitter DMs, the home timeline or mentions feed, or run a recent search. " +
    "Use this for retrieving content from X (not posting).",

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
    const subaction =
      normalizeSubaction(params.subaction) ?? inferSubactionFromIntent(intent);
    const feedType = normalizeFeedType(params.feedType);
    const limit = normalizeLimit(params.limit);
    const query = typeof params.query === "string" ? params.query.trim() : "";

    const service = new LifeOpsService(runtime);
    const respond = async (payload: ActionResult): Promise<ActionResult> => {
      await callback?.({
        text: payload.text ?? "",
        source: "action",
        action: "X_READ",
      });
      return payload;
    };

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
        content: { text: 'Search X for "elizaOS".' },
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
