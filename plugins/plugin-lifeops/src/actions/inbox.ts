/**
 * `INBOX` umbrella action — cross-channel inbox.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Inbox And Messaging. The existing
 * `MESSAGE` umbrella triages per-channel inboxes; INBOX fans out to
 * every connected platform (Gmail, Slack, Discord, Telegram, Signal, iMessage,
 * WhatsApp) and produces a single merged feed for "show me my inbox" style
 * intents.
 *
 * Subactions:
 *   - `list`       — list recent messages across selected platforms
 *   - `search`     — search across selected platforms by `query`
 *   - `summarize`  — return a per-platform count + a single rolled-up summary
 *
 * Behavior: fan out to each platform's adapter via the injectable loader,
 * dedupe by `id` and thread topic, merge into a single result list ordered by
 * recency.
 *
 * Owner-only.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  MessageRef,
  MessageSource,
} from "@elizaos/core";
import { getDefaultTriageService, logger } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";

const ACTION_NAME = "INBOX";

const SUBACTIONS = ["list", "search", "summarize"] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "INBOX",
  "CROSS_CHANNEL_INBOX",
  "ALL_MESSAGES",
  "INBOX_TRIAGE_PRIORITY",
];

const PLATFORMS = [
  "gmail",
  "slack",
  "discord",
  "telegram",
  "signal",
  "imessage",
  "whatsapp",
] as const;

export type InboxPlatform = (typeof PLATFORMS)[number];

export interface InboxItem {
  readonly id: string;
  readonly platform: InboxPlatform;
  readonly channel: string;
  readonly senderName: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly threadTopic?: string;
  readonly deepLink?: string;
  readonly unread?: boolean;
}

interface InboxActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  platforms?: readonly string[];
  since?: string;
  limit?: number;
  query?: string;
}

export interface InboxSummaryEntry {
  readonly platform: InboxPlatform;
  readonly count: number;
  readonly latestAt: string | null;
}

export interface InboxResult {
  readonly subaction: Subaction;
  readonly platforms: readonly InboxPlatform[];
  readonly items: readonly InboxItem[];
  readonly summary?: readonly InboxSummaryEntry[];
  readonly query?: string;
  readonly since?: string;
  readonly totalBeforeDedupe: number;
}

/**
 * Per-platform fetcher hook. Defaults read through the shared MESSAGE triage
 * service; tests can still inject deterministic scenario data.
 */
export type InboxFetcher = (args: {
  runtime: IAgentRuntime;
  since?: string;
  limit: number;
  query?: string;
}) => Promise<readonly InboxItem[]>;

export type InboxFetchers = Record<InboxPlatform, InboxFetcher>;

const noopFetcher: InboxFetcher = async () => [];

const PLATFORM_TO_MESSAGE_SOURCE: Partial<Record<InboxPlatform, MessageSource>> =
  {
    gmail: "gmail",
    discord: "discord",
    telegram: "telegram",
    signal: "signal",
    imessage: "imessage",
    whatsapp: "whatsapp",
  };

function mapMessageRefToInboxItem(ref: MessageRef): InboxItem | null {
  const platform = normalizePlatform(ref.source);
  if (!platform) return null;
  return {
    id: ref.id,
    platform,
    channel: ref.channelId ?? ref.worldId ?? "default",
    senderName: ref.from.displayName ?? ref.from.identifier,
    snippet: ref.snippet,
    receivedAt: new Date(ref.receivedAtMs).toISOString(),
    ...(ref.subject ? { threadTopic: ref.subject } : {}),
    ...(typeof ref.metadata?.htmlLink === "string"
      ? { deepLink: ref.metadata.htmlLink }
      : {}),
    unread: !ref.isRead,
  };
}

function parseSinceMs(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const parsed = Date.parse(since);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createDefaultPlatformFetcher(platform: InboxPlatform): InboxFetcher {
  const source = PLATFORM_TO_MESSAGE_SOURCE[platform];
  if (!source) return noopFetcher;
  return async ({ runtime, since, limit, query }) => {
    if (typeof runtime.getService !== "function") return [];
    try {
      const service = getDefaultTriageService();
      const refs = query
        ? await service.search(runtime, {
            sources: [source],
            content: query,
            sinceMs: parseSinceMs(since),
            limit,
          })
        : await service.triage(runtime, {
            sources: [source],
            sinceMs: parseSinceMs(since),
            limit,
          });
      return refs.flatMap((ref) => {
        const item = mapMessageRefToInboxItem(ref);
        return item ? [item] : [];
      });
    } catch (error) {
      logger.warn(
        `[INBOX] ${platform} fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  };
}

const defaultFetchers: InboxFetchers = {
  gmail: createDefaultPlatformFetcher("gmail"),
  slack: noopFetcher,
  discord: createDefaultPlatformFetcher("discord"),
  telegram: createDefaultPlatformFetcher("telegram"),
  signal: createDefaultPlatformFetcher("signal"),
  imessage: createDefaultPlatformFetcher("imessage"),
  whatsapp: createDefaultPlatformFetcher("whatsapp"),
};

let activeFetchers: InboxFetchers = { ...defaultFetchers };

export function setInboxFetchers(next: Partial<InboxFetchers>): void {
  activeFetchers = { ...activeFetchers, ...next };
}

export function __resetInboxFetchersForTests(): void {
  activeFetchers = { ...defaultFetchers };
}

function getParams(options: HandlerOptions | undefined): InboxActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as InboxActionParameters;
  }
  return {};
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function resolveSubaction(params: InboxActionParameters): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function normalizePlatform(value: unknown): InboxPlatform | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (PLATFORMS as readonly string[]).includes(lower)
    ? (lower as InboxPlatform)
    : null;
}

function resolvePlatforms(
  input: readonly string[] | undefined,
): readonly InboxPlatform[] {
  if (!input || input.length === 0) {
    return [...PLATFORMS];
  }
  const seen = new Set<InboxPlatform>();
  for (const raw of input) {
    const normalized = normalizePlatform(raw);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function dedupeKey(item: InboxItem): string {
  if (item.threadTopic && item.threadTopic.length > 0) {
    return `topic:${item.threadTopic.toLowerCase()}::${item.platform}::${item.channel}`;
  }
  return `id:${item.platform}::${item.id}`;
}

function dedupeAndOrder(items: readonly InboxItem[]): readonly InboxItem[] {
  const seen = new Map<string, InboxItem>();
  for (const item of items) {
    const key = dedupeKey(item);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }
    const a = Date.parse(item.receivedAt);
    const b = Date.parse(existing.receivedAt);
    if (Number.isNaN(a)) continue;
    if (Number.isNaN(b) || a > b) {
      seen.set(key, item);
    }
  }
  return [...seen.values()].sort((a, b) => {
    const aTime = Date.parse(a.receivedAt);
    const bTime = Date.parse(b.receivedAt);
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  });
}

function buildSummary(
  items: readonly InboxItem[],
  platforms: readonly InboxPlatform[],
): readonly InboxSummaryEntry[] {
  return platforms.map<InboxSummaryEntry>((platform) => {
    const platformItems = items.filter((item) => item.platform === platform);
    let latestAt: string | null = null;
    for (const item of platformItems) {
      if (!latestAt || Date.parse(item.receivedAt) > Date.parse(latestAt)) {
        latestAt = item.receivedAt;
      }
    }
    return {
      platform,
      count: platformItems.length,
      latestAt,
    };
  });
}

const examples: ActionExample[][] = [
  [
    { name: "{{name1}}", content: { text: "Show me my inbox." } },
    {
      name: "{{agentName}}",
      content: {
        text: "Pulled your inbox.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Search every channel for messages about the launch." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Searched every connected inbox.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const inboxAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:inbox",
    "capability:read",
    "capability:search",
    "capability:summarize",
    "surface:internal",
  ],
  description:
    "Inbox: Gmail, Slack, Discord, Telegram, Signal, iMessage, WhatsApp. Merge recency feed. Subactions: list, search, summarize.",
  descriptionCompressed:
    "INBOX list|search|summarize gmail|slack|discord|telegram|signal|imessage|whatsapp",
  routingHint:
    'cross-channel inbox ("show inbox", "all messages", "search every channel", "summarize inboxes") -> INBOX; per-channel -> MESSAGE',
  contexts: ["inbox", "messaging", "cross-channel"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: "Inbox op: list | search | summarize.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "platforms",
      description:
        "Optional platform filter: gmail | slack | discord | telegram | signal | imessage | whatsapp. Default all.",
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "since",
      description: "receivedAt lower bound. ISO-8601.",
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Limit per platform. Default 50.",
      schema: { type: "number" as const },
    },
    {
      name: "query",
      description: "Required for search. Free-form query.",
      schema: { type: "string" as const },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "The inbox is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me which operation: list, search, or summarize.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const platforms = resolvePlatforms(params.platforms);
    if (platforms.length === 0) {
      return {
        success: false,
        text: "No supported platforms were specified.",
        data: { subaction, error: "NO_PLATFORMS" },
      };
    }

    const limit =
      typeof params.limit === "number" && params.limit > 0
        ? Math.floor(params.limit)
        : 50;

    let query: string | undefined;
    if (subaction === "search") {
      const trimmed =
        typeof params.query === "string" ? params.query.trim() : "";
      if (trimmed.length === 0) {
        return {
          success: false,
          text: "I need a non-empty query to search.",
          data: { subaction, error: "MISSING_QUERY" },
        };
      }
      query = trimmed;
    }

    const since =
      typeof params.since === "string" && params.since.trim().length > 0
        ? params.since.trim()
        : undefined;

    const fetched = await Promise.all(
      platforms.map(async (platform) => {
        const fetcher = activeFetchers[platform];
        const items = await fetcher({
          runtime,
          ...(since ? { since } : {}),
          limit,
          ...(query ? { query } : {}),
        });
        return items;
      }),
    );
    const flat = fetched.flat();
    const merged = dedupeAndOrder(flat);
    const items: readonly InboxItem[] = subaction === "summarize" ? [] : merged;
    const summary: readonly InboxSummaryEntry[] | undefined =
      subaction === "summarize" ? buildSummary(merged, platforms) : undefined;

    logger.info(
      `[INBOX] ${subaction} platforms=${platforms.join(",")} pre=${flat.length} post=${merged.length}`,
    );

    let text: string;
    switch (subaction) {
      case "list":
        text =
          merged.length === 0
            ? "Your inbox is empty for this window."
            : `Pulled ${merged.length} messages across ${platforms.length} platforms.`;
        break;
      case "search":
        text =
          merged.length === 0
            ? `No matches for "${query}".`
            : `Found ${merged.length} matches for "${query}".`;
        break;
      case "summarize":
        text = `Summarized ${platforms.length} platforms (${merged.length} unique messages).`;
        break;
    }

    await callback?.({
      text,
      source: "action",
      action: ACTION_NAME,
    });

    return {
      success: true,
      text,
      data: {
        subaction,
        platforms,
        items,
        ...(summary ? { summary } : {}),
        ...(query ? { query } : {}),
        ...(since ? { since } : {}),
        totalBeforeDedupe: flat.length,
      },
    };
  },
};
