import { hasOwnerAccess } from "@elizaos/agent/security/access";
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
  logger,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./lib/recent-context.js";
import { messageText } from "./lifeops-google-helpers.js";

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
    if (
      normalized === "home_timeline" ||
      normalized === "home" ||
      normalized === "timeline"
    ) {
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
    "Return TOON only with exactly these fields:",
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
    '  "check my X DMs" -> subaction: read_dms; feedType: null; query: null; limit: null; shouldAct: true; response: null',
    '  "show me my mentions" -> subaction: read_feed; feedType: mentions; query: null; limit: null; shouldAct: true; response: null',
    '  "search X for Eliza" -> subaction: search; feedType: null; query: Eliza; limit: null; shouldAct: true; response: null',
    '  "help me with X" -> subaction: null; feedType: null; query: null; limit: null; shouldAct: false; response: Do you want me to read your X DMs, timeline, mentions, or run a search?',
    "",
    "Return TOON only.",
    "Current request:",
    currentMessage || "(empty)",
    "Resolved intent:",
    args.intent || "(none)",
    "Recent conversation:",
    recentConversation || "(none)",
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-x-planner" },
      () =>
        args.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(rawResponse);
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

type RankedItem<T> = {
  item: T;
  score: number;
  reasons: string[];
};

const ACTION_PHRASE_PATTERN =
  /\b(urgent|asap|blocked|help|deadline|today|tonight|tomorrow|confirm|review|send|reply|respond|need|can you|could you|please|important)\b/i;

function clip(text: string, maxLength = 220): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  const ageHours = Math.max(0, (Date.now() - parsed) / 3_600_000);
  if (ageHours < 1) return "just now";
  if (ageHours < 24) return `${Math.floor(ageHours)}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

function rankDm(dm: LifeOpsXDm): RankedItem<LifeOpsXDm> {
  const reasons: string[] = [];
  let score = 0;
  if (dm.isInbound) {
    score += 35;
    reasons.push("incoming");
  }
  if (dm.readAt === null) {
    score += 15;
    reasons.push("unread");
  }
  if (dm.repliedAt === null && dm.isInbound) {
    score += 15;
    reasons.push("not replied");
  }
  if (dm.text.includes("?")) {
    score += 15;
    reasons.push("question");
  }
  if (ACTION_PHRASE_PATTERN.test(dm.text)) {
    score += 25;
    reasons.push("action requested");
  }
  const when = Date.parse(dm.receivedAt);
  if (Number.isFinite(when) && Date.now() - when <= 24 * 3_600_000) {
    score += 15;
    reasons.push("recent");
  }
  const participantIds = Array.isArray(dm.metadata?.participantIds)
    ? dm.metadata.participantIds
    : [];
  if (participantIds.length > 2) {
    score += 10;
    reasons.push("group DM");
  }
  return { item: dm, score, reasons };
}

function rankFeedItem(item: LifeOpsXFeedItem): RankedItem<LifeOpsXFeedItem> {
  const reasons: string[] = [];
  let score = 0;
  if (ACTION_PHRASE_PATTERN.test(item.text)) {
    score += 25;
    reasons.push("action language");
  }
  if (item.text.includes("?")) {
    score += 15;
    reasons.push("question");
  }
  const raw = (item.metadata?.raw ?? {}) as {
    referenced_tweets?: Array<{ type?: string }>;
    public_metrics?: Record<string, number>;
  };
  const referenceTypes = (raw.referenced_tweets ?? [])
    .map((reference) => reference.type)
    .filter((type): type is string => typeof type === "string");
  if (referenceTypes.includes("replied_to")) {
    score += 25;
    reasons.push("reply");
  }
  if (referenceTypes.includes("quoted")) {
    score += 15;
    reasons.push("quote");
  }
  const metrics = raw.public_metrics ?? {};
  const engagement =
    (metrics.like_count ?? 0) +
    (metrics.reply_count ?? 0) * 3 +
    (metrics.retweet_count ?? 0) * 2 +
    (metrics.quote_count ?? 0) * 2;
  if (engagement >= 25) {
    score += 20;
    reasons.push("high engagement");
  } else if (engagement >= 5) {
    score += 10;
    reasons.push("some engagement");
  }
  const when = Date.parse(item.createdAtSource);
  if (Number.isFinite(when) && Date.now() - when <= 24 * 3_600_000) {
    score += 10;
    reasons.push("recent");
  }
  return { item, score, reasons };
}

function formatDmLine(dm: LifeOpsXDm, reasons: string[]): string {
  const who = dm.senderHandle
    ? `@${dm.senderHandle}`
    : dm.senderId || "unknown";
  const when = formatWhen(dm.receivedAt);
  const suffix = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
  return `- ${who}${when ? `, ${when}` : ""}: ${clip(dm.text)}${suffix}`;
}

function formatFeedLine(item: LifeOpsXFeedItem, reasons: string[]): string {
  const who = item.authorHandle
    ? `@${item.authorHandle}`
    : item.authorId || "unknown";
  const when = formatWhen(item.createdAtSource);
  const suffix = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
  return `- ${who}${when ? `, ${when}` : ""}: ${clip(item.text)}${suffix}`;
}

function summarizeDms(dms: LifeOpsXDm[]): string {
  if (dms.length === 0) return "No X DMs found.";
  const ranked = dms.map(rankDm).sort((a, b) => b.score - a.score);
  const actionNeeded = ranked.filter((entry) => entry.score >= 60).slice(0, 5);
  const otherRecent = ranked
    .filter((entry) => !actionNeeded.includes(entry))
    .slice(0, 5);
  const lines = [`X DM rundown (${dms.length} messages)`];
  lines.push(
    actionNeeded.length > 0
      ? [
          "Action-needed",
          ...actionNeeded.map((entry) =>
            formatDmLine(entry.item, entry.reasons),
          ),
        ].join("\n")
      : "Action-needed\n- No obvious urgent or reply-needed DMs.",
  );
  if (otherRecent.length > 0) {
    lines.push(
      [
        "Other recent",
        ...otherRecent.map((entry) => formatDmLine(entry.item, entry.reasons)),
      ].join("\n"),
    );
  }
  const nextSteps =
    actionNeeded.length > 0
      ? "Next steps\n- Draft replies for the action-needed DMs, or ask me to schedule a specific X DM reply."
      : "Next steps\n- No reply looks required from this batch.";
  lines.push(nextSteps);
  return lines.join("\n\n");
}

function summarizeFeedItems(
  items: LifeOpsXFeedItem[],
  feedType: LifeOpsXFeedType,
): string {
  if (items.length === 0) return `No items in X ${feedType}.`;
  const ranked = items.map(rankFeedItem).sort((a, b) => b.score - a.score);
  const important = ranked.filter((entry) => entry.score >= 35).slice(0, 6);
  const replies = ranked
    .filter((entry) => entry.reasons.includes("reply"))
    .slice(0, 5);
  const recent = ranked.slice(0, 6);
  const lines = [`X ${feedType} rundown (${items.length} items)`];
  lines.push(
    important.length > 0
      ? [
          "Interesting or important",
          ...important.map((entry) =>
            formatFeedLine(entry.item, entry.reasons),
          ),
        ].join("\n")
      : "Interesting or important\n- No high-signal posts stood out in this batch.",
  );
  if (feedType === "mentions" || replies.length > 0) {
    lines.push(
      replies.length > 0
        ? [
            "Replies or mentions to review",
            ...replies.map((entry) =>
              formatFeedLine(entry.item, entry.reasons),
            ),
          ].join("\n")
        : "Replies or mentions to review\n- No replies or mentions needing review were found.",
    );
  }
  lines.push(
    [
      "Recent context",
      ...recent.map((entry) => formatFeedLine(entry.item, entry.reasons)),
    ].join("\n"),
  );
  lines.push(
    important.length > 0
      ? "Next steps\n- Ask me to search deeper, read DMs, or draft a response for a specific post."
      : "Next steps\n- Nothing here appears urgent; ask for a narrower search if you want more signal.",
  );
  return lines.join("\n\n");
}

export const xAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "X",
  similes: [
    "READ_TWITTER",
    "X_DMS",
    "X_TIMELINE",
    "TWITTER_MENTIONS",
    "SEARCH_TWITTER",
    "X_FEED",
  ],
  description:
    "Read X/Twitter DMs, the home timeline or mentions feed, or run a recent search.",
  descriptionCompressed:
    "X/Twitter read: read_dms (rank action-needed first) | read_feed(home_timeline|mentions) | search(query) owner",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    const service = new LifeOpsService(runtime);
    const isUsable = (status: {
      grant?: unknown;
      feedRead?: boolean;
      dmRead?: boolean;
      grantedCapabilities: readonly string[];
    }) =>
      Boolean(
        status.grant &&
          (status.feedRead ||
            status.dmRead ||
            status.grantedCapabilities.includes("x.read")),
      );
    try {
      const defaultStatus = await service.getXConnectorStatus();
      if (isUsable(defaultStatus)) return true;
      // Fall back to the local-mode grant: when cloud is configured the
      // default mode is cloud_managed, but a local grant + env credentials
      // may still authorize the read. Checking both keeps validate true to
      // any configured X path.
      if (defaultStatus.mode !== "local") {
        try {
          const localStatus = await service.getXConnectorStatus("local");
          if (isUsable(localStatus)) return true;
        } catch {
          // ignore — falls through to false
        }
      }
      return false;
    } catch (error) {
      logger.warn(
        {
          boundary: "lifeops",
          component: "x-read",
          detail: error instanceof Error ? error.message : String(error),
        },
        "[x-read] getXConnectorStatus failed; action validation defaulting to false",
      );
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
    if (!(await hasOwnerAccess(runtime, message))) {
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
        : (llmPlan.query ?? "");

    const service = new LifeOpsService(runtime);
    const respond = async (payload: ActionResult): Promise<ActionResult> => {
      await callback?.({
        text: payload.text ?? "",
        source: "action",
        action: "X",
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
        success: false,
        text:
          llmPlan.response ??
          "Do you want me to read your X DMs, timeline, mentions, or run a search?",
        values: {
          success: false,
          error: "PLANNER_SHOULDACT_FALSE",
          noop: true,
        },
        data: { noop: true, error: "PLANNER_SHOULDACT_FALSE" },
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
            error: "X_FAILED",
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
