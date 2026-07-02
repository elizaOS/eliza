/**
 * `BIRDCLAW` umbrella action — the agent's hands on the owner's local-first
 * Twitter/X archive (birdclaw.sh).
 *
 * Ops:
 *   - `search` — full-text search the archived tweets (optionally scoped to
 *     mentions/authored, liked-only, bookmarked-only)
 *   - `inbox`  — ranked mention/DM triage ("who needs a reply?")
 *   - `sync`   — refresh a live collection into the local store
 *   - `digest` — AI digest of what happened (requires birdclaw's OpenAI key)
 *   - `status` — install/dataset/transport state
 *
 * Owner-only: the archive is the owner's private Twitter memory (tweets,
 * mentions, DMs). Validation requires the service to be registered AND the
 * CLI to actually be installed, so the planner never offers a dead action.
 */

import type {
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { BirdclawService } from "../birdclaw/service.ts";
import {
  BIRDCLAW_DIGEST_PERIODS,
  BIRDCLAW_INBOX_KINDS,
  BIRDCLAW_RESOURCES,
  BIRDCLAW_SYNC_COLLECTIONS,
  type BirdclawInboxItem,
  type BirdclawStatusInfo,
  type BirdclawTweet,
  isBirdclawDigestPeriod,
  isBirdclawInboxKind,
  isBirdclawResource,
  isBirdclawSyncCollection,
} from "../types.ts";

const ACTION_NAME = "BIRDCLAW";

const SUBACTIONS = ["search", "inbox", "sync", "digest", "status"] as const;
type Subaction = (typeof SUBACTIONS)[number];

export interface BirdclawActionParameters {
  action?: string;
  op?: string;
  query?: string;
  resource?: string;
  liked?: boolean;
  bookmarked?: boolean;
  limit?: number;
  kind?: string;
  collection?: string;
  period?: string;
}

function getService(runtime: IAgentRuntime): BirdclawService | null {
  return (
    (runtime.getService(
      BirdclawService.serviceType,
    ) as BirdclawService | null) ?? null
  );
}

function getParams(options: unknown): BirdclawActionParameters {
  if (typeof options !== "object" || options === null) return {};
  const record = options as Record<string, unknown>;
  const inner = record.parameters;
  if (typeof inner === "object" && inner !== null) {
    return inner as BirdclawActionParameters;
  }
  return record as BirdclawActionParameters;
}

function resolveSubaction(params: BirdclawActionParameters): Subaction | null {
  const raw = (params.action ?? params.op ?? "")
    .toString()
    .trim()
    .toLowerCase();
  if ((SUBACTIONS as readonly string[]).includes(raw)) return raw as Subaction;
  // A bare query with no explicit op is a search intent.
  if (!raw && typeof params.query === "string" && params.query.trim()) {
    return "search";
  }
  return null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

export function formatTweetLines(
  tweets: readonly BirdclawTweet[],
  cap = 10,
): string {
  return tweets
    .slice(0, cap)
    .map((tweet) => {
      const author = tweet.authorHandle ? `@${tweet.authorHandle}` : "unknown";
      const likes = tweet.likeCount !== null ? ` (♥${tweet.likeCount})` : "";
      const marks = [
        tweet.liked ? "liked" : null,
        tweet.bookmarked ? "bookmarked" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const suffix = marks ? ` [${marks}]` : "";
      return `• ${author} — ${tweet.text}${likes}${suffix} · ${formatTime(tweet.createdAt)}`;
    })
    .join("\n");
}

export function formatInboxLines(
  items: readonly BirdclawInboxItem[],
  cap = 10,
): string {
  return items
    .slice(0, cap)
    .map((item) => {
      const who = item.participantHandle
        ? `@${item.participantHandle}`
        : item.kind;
      const reply = item.needsReply ? " — needs a reply" : "";
      return `• ${who}: ${item.text}${reply} · ${formatTime(item.createdAt)}`;
    })
    .join("\n");
}

export function formatStatusLine(status: BirdclawStatusInfo): string {
  if (!status.installed) {
    return status.message ?? "birdclaw is not installed.";
  }
  const counts = status.counts
    ? ` Archive: ${status.counts.home} timeline, ${status.counts.mentions} mentions, ${status.counts.dms} DMs (${status.counts.needsReply} need a reply).`
    : "";
  const transport = status.transport
    ? ` Live sync: ${status.transport.statusText}`
    : "";
  return `birdclaw ${status.version ?? ""} is installed.${counts}${transport}`.trim();
}

async function runSubaction(
  service: BirdclawService,
  subaction: Subaction,
  params: BirdclawActionParameters,
): Promise<ActionResult> {
  switch (subaction) {
    case "search": {
      const resource =
        params.resource && isBirdclawResource(params.resource)
          ? params.resource
          : "home";
      const tweets = await service.searchTweets({
        query: params.query,
        resource,
        liked: params.liked === true,
        bookmarked: params.bookmarked === true,
        limit: params.limit,
      });
      if (tweets.length === 0) {
        const scope = params.query ? ` for "${params.query}"` : "";
        return {
          success: true,
          text: `No archived tweets found${scope} in the ${resource} resource.`,
          data: { subaction, tweets: [] },
        };
      }
      const lines = formatTweetLines(tweets);
      return {
        success: true,
        text: `Found ${tweets.length} archived tweet${tweets.length === 1 ? "" : "s"}:\n${lines}`,
        data: { subaction, tweets },
      };
    }
    case "inbox": {
      const kind =
        params.kind && isBirdclawInboxKind(params.kind) ? params.kind : "mixed";
      const items = await service.inbox({ kind, limit: params.limit });
      if (items.length === 0) {
        return {
          success: true,
          text: "The birdclaw inbox is clear — nothing needs attention.",
          data: { subaction, items: [] },
        };
      }
      const needing = items.filter((item) => item.needsReply).length;
      const headline =
        needing > 0
          ? `${items.length} inbox item${items.length === 1 ? "" : "s"}, ${needing} still need${needing === 1 ? "s" : ""} a reply:`
          : `${items.length} inbox item${items.length === 1 ? "" : "s"}:`;
      return {
        success: true,
        text: `${headline}\n${formatInboxLines(items)}`,
        data: { subaction, items },
      };
    }
    case "sync": {
      const collection = params.collection ?? "";
      if (!isBirdclawSyncCollection(collection)) {
        return {
          success: false,
          text: `I can sync one of: ${BIRDCLAW_SYNC_COLLECTIONS.join(", ")}.`,
          data: { subaction, error: "INVALID_COLLECTION" },
        };
      }
      const result = await service.sync(collection);
      return {
        success: true,
        text: `Synced ${collection}: ${result.summary}`,
        data: { subaction, result },
      };
    }
    case "digest": {
      const period =
        params.period && isBirdclawDigestPeriod(params.period)
          ? params.period
          : "today";
      const digest = await service.digest(period);
      return {
        success: true,
        text: digest.text,
        data: { subaction, period },
      };
    }
    case "status": {
      const status = await service.status();
      return {
        success: true,
        text: formatStatusLine(status),
        data: { subaction, status },
      };
    }
  }
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Search my twitter archive for that thread about local-first sync engines.",
        source: "chat",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Searching your birdclaw archive.",
        actions: [ACTION_NAME],
        thought:
          "Archive lookup maps to BIRDCLAW action=search with query set.",
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "Which twitter mentions still need a reply from me?",
        source: "chat",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Checking the birdclaw inbox for unreplied mentions.",
        actions: [ACTION_NAME],
        thought:
          "Unreplied mentions map to BIRDCLAW action=inbox kind=mentions.",
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "Pull my latest twitter bookmarks into the local archive.",
        source: "chat",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Refreshing bookmarks from Twitter into birdclaw.",
        actions: [ACTION_NAME],
        thought:
          "Live refresh maps to BIRDCLAW action=sync collection=bookmarks.",
      },
    },
  ],
];

export const birdclawAction = {
  name: ACTION_NAME,
  similes: ["TWITTER_ARCHIVE", "TWEET_SEARCH", "TWITTER_MEMORY", "X_ARCHIVE"],
  tags: [
    "domain:social",
    "capability:read",
    "capability:search",
    "surface:internal",
  ],
  description:
    "Birdclaw local Twitter/X archive: search archived tweets (timeline, mentions, authored, liked, bookmarked), triage the mention/DM inbox, refresh live collections, build digests, report status. Subactions: search, inbox, sync, digest, status.",
  descriptionCompressed:
    "BIRDCLAW search|inbox|sync|digest|status over the local Twitter/X archive",
  routingHint:
    'local Twitter/X archive ("search my tweets", "who mentioned me", "sync my bookmarks", "what happened on twitter") -> BIRDCLAW; live posting/following -> the X connector',
  contexts: ["social", "archive", "twitter"],
  roleGate: { minRole: "OWNER" as const },
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = getService(runtime);
    if (!service) return false;
    return service.isAvailable();
  },
  parameters: [
    {
      name: "action",
      description: "Birdclaw op: search | inbox | sync | digest | status.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "query",
      description: "Full-text query for search. Omit to list recent tweets.",
      schema: { type: "string" as const },
    },
    {
      name: "resource",
      description:
        "Tweet resource for search: home | mentions | authored. Default home.",
      schema: { type: "string" as const, enum: [...BIRDCLAW_RESOURCES] },
    },
    {
      name: "liked",
      description: "Search only liked tweets.",
      schema: { type: "boolean" as const },
    },
    {
      name: "bookmarked",
      description: "Search only bookmarked tweets.",
      schema: { type: "boolean" as const },
    },
    {
      name: "limit",
      description: "Max rows to return. Default 20, cap 100.",
      schema: { type: "number" as const },
    },
    {
      name: "kind",
      description: "Inbox kind: mixed | mentions | dms. Default mixed.",
      schema: { type: "string" as const, enum: [...BIRDCLAW_INBOX_KINDS] },
    },
    {
      name: "collection",
      description:
        "Required for sync: timeline | mentions | authored | likes | bookmarks.",
      schema: { type: "string" as const, enum: [...BIRDCLAW_SYNC_COLLECTIONS] },
    },
    {
      name: "period",
      description:
        "Digest period: today | 24h | yesterday | week. Default today.",
      schema: { type: "string" as const, enum: [...BIRDCLAW_DIGEST_PERIODS] },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: unknown,
    options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      const text = "The birdclaw service is not available on this agent.";
      await callback?.({ text });
      return { success: false, text, data: { error: "SERVICE_UNAVAILABLE" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      const text = `I can ${SUBACTIONS.join(", ")} against the birdclaw archive — which one?`;
      await callback?.({ text });
      return { success: false, text, data: { error: "UNKNOWN_SUBACTION" } };
    }

    try {
      const result = await runSubaction(service, subaction, params);
      if (result.text) await callback?.({ text: result.text });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[plugin-birdclaw] ${subaction} failed: ${message}`);
      const text = `birdclaw ${subaction} failed: ${message}`;
      await callback?.({ text });
      return { success: false, text, data: { error: "CLI_FAILURE", message } };
    }
  },
};
