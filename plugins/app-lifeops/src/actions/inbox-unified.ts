/**
 * `INBOX_UNIFIED` umbrella action — cross-platform unified inbox.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Inbox And Messaging. The existing
 * `MESSAGE` umbrella triages per-channel inboxes; INBOX_UNIFIED fans out to
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
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";

const ACTION_NAME = "INBOX_UNIFIED";

const SUBACTIONS = ["list", "search", "summarize"] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "INBOX_UNIFIED",
  "UNIFIED_INBOX",
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

export type InboxUnifiedPlatform = (typeof PLATFORMS)[number];

export interface InboxUnifiedItem {
  readonly id: string;
  readonly platform: InboxUnifiedPlatform;
  readonly channel: string;
  readonly senderName: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly threadTopic?: string;
  readonly deepLink?: string;
  readonly unread?: boolean;
}

interface InboxUnifiedActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  platforms?: readonly string[];
  since?: string;
  limit?: number;
  query?: string;
}

export interface InboxUnifiedSummaryEntry {
  readonly platform: InboxUnifiedPlatform;
  readonly count: number;
  readonly latestAt: string | null;
}

export interface InboxUnifiedResult {
  readonly subaction: Subaction;
  readonly platforms: readonly InboxUnifiedPlatform[];
  readonly items: readonly InboxUnifiedItem[];
  readonly summary?: readonly InboxUnifiedSummaryEntry[];
  readonly query?: string;
  readonly since?: string;
  readonly totalBeforeDedupe: number;
}

/**
 * Per-platform fetcher hook. Wave-2 wires each platform's adapter (Gmail
 * adapter, Slack adapter, etc.) under the matching key. Wave-1 leaves them
 * all empty so the unit tests can inject scenario data.
 *
 * TODO Wave-2: wire to `getDefaultTriageService().adapters` once cross-
 * platform connectors expose a recent-messages read primitive.
 */
export type InboxUnifiedFetcher = (args: {
  runtime: IAgentRuntime;
  since?: string;
  limit: number;
  query?: string;
}) => Promise<readonly InboxUnifiedItem[]>;

export type InboxUnifiedFetchers = Record<
  InboxUnifiedPlatform,
  InboxUnifiedFetcher
>;

const noopFetcher: InboxUnifiedFetcher = async () => [];

const defaultFetchers: InboxUnifiedFetchers = {
  gmail: noopFetcher,
  slack: noopFetcher,
  discord: noopFetcher,
  telegram: noopFetcher,
  signal: noopFetcher,
  imessage: noopFetcher,
  whatsapp: noopFetcher,
};

let activeFetchers: InboxUnifiedFetchers = { ...defaultFetchers };

export function setInboxUnifiedFetchers(
  next: Partial<InboxUnifiedFetchers>,
): void {
  activeFetchers = { ...activeFetchers, ...next };
}

export function __resetInboxUnifiedFetchersForTests(): void {
  activeFetchers = { ...defaultFetchers };
}

function getParams(
  options: HandlerOptions | undefined,
): InboxUnifiedActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as InboxUnifiedActionParameters;
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

function resolveSubaction(
  params: InboxUnifiedActionParameters,
): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function normalizePlatform(value: unknown): InboxUnifiedPlatform | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (PLATFORMS as readonly string[]).includes(lower)
    ? (lower as InboxUnifiedPlatform)
    : null;
}

function resolvePlatforms(
  input: readonly string[] | undefined,
): readonly InboxUnifiedPlatform[] {
  if (!input || input.length === 0) {
    return [...PLATFORMS];
  }
  const seen = new Set<InboxUnifiedPlatform>();
  for (const raw of input) {
    const normalized = normalizePlatform(raw);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function dedupeKey(item: InboxUnifiedItem): string {
  if (item.threadTopic && item.threadTopic.length > 0) {
    return `topic:${item.threadTopic.toLowerCase()}::${item.platform}::${item.channel}`;
  }
  return `id:${item.platform}::${item.id}`;
}

function dedupeAndOrder(
  items: readonly InboxUnifiedItem[],
): readonly InboxUnifiedItem[] {
  const seen = new Map<string, InboxUnifiedItem>();
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
  items: readonly InboxUnifiedItem[],
  platforms: readonly InboxUnifiedPlatform[],
): readonly InboxUnifiedSummaryEntry[] {
  return platforms.map<InboxUnifiedSummaryEntry>((platform) => {
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
    { name: "{{name1}}", content: { text: "Show me my unified inbox." } },
    {
      name: "{{agentName}}",
      content: {
        text: "Pulled your unified inbox.",
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

export const inboxUnifiedAction: Action & {
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
    "Cross-platform unified inbox: fan out to Gmail, Slack, Discord, Telegram, Signal, iMessage, and WhatsApp and merge into a single recency-ordered feed. Subactions: list, search, summarize.",
  descriptionCompressed:
    "unified inbox: list|search|summarize across gmail|slack|discord|telegram|signal|imessage|whatsapp; dedupe by id+thread topic",
  routingHint:
    'cross-channel inbox intent ("show my inbox", "all messages", "search every channel", "summarize my inboxes") -> INBOX_UNIFIED; per-channel intents stay on MESSAGE',
  contexts: ["inbox", "messaging", "cross-channel"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: "Canonical inbox operation: list | search | summarize.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "platforms",
      description:
        "Optional array of platforms to limit fan-out: gmail | slack | discord | telegram | signal | imessage | whatsapp. Default: all.",
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "since",
      description: "ISO-8601 lower bound on receivedAt.",
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Per-platform limit; default 50.",
      schema: { type: "number" as const },
    },
    {
      name: "query",
      description: "Required for search; free-form search string.",
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
      const text = "The unified inbox is restricted to the owner.";
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
    const items: readonly InboxUnifiedItem[] =
      subaction === "summarize" ? [] : merged;
    const summary: readonly InboxUnifiedSummaryEntry[] | undefined =
      subaction === "summarize" ? buildSummary(merged, platforms) : undefined;

    logger.info(
      `[INBOX_UNIFIED] ${subaction} platforms=${platforms.join(",")} pre=${flat.length} post=${merged.length}`,
    );

    let text: string;
    switch (subaction) {
      case "list":
        text =
          merged.length === 0
            ? "Your unified inbox is empty for this window."
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
