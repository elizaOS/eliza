/**
 * `INBOX` umbrella action — cross-channel inbox.
 *
 * The agent's `MESSAGE` umbrella triages per-channel inboxes; INBOX fans out to
 * every connected platform (Gmail, Slack, Discord, Telegram, Signal, iMessage,
 * WhatsApp) and produces a single merged feed for "show me my inbox" style
 * intents.
 *
 * Subactions:
 *   - `list`       — list recent messages across selected platforms
 *   - `search`     — search across selected platforms by `query`
 *   - `summarize`  — return a per-platform count + a single rolled-up summary
 *   - `triage`     — run the AI triage classifier over fresh cross-channel
 *                    messages (`InboxService.triage` → `classifyMessages`, the
 *                    `inbox_triage` optimized-prompt consumer), persist one
 *                    entry per new message, then return the pending queue
 *   - `reply`      — draft or send a connector-backed reply
 *   - `snooze`     — hide a triage entry until a future timestamp
 *   - `archive`    — archive through the connector adapter and resolve
 *   - `approve`    — send the stored draft/suggested response
 *
 * Behavior: fan out to each platform's adapter via the injectable fetcher hook,
 * dedupe by `id` and thread topic, merge into a single result list ordered by
 * recency.
 *
 * Owner-only. Ported verbatim from the LifeOps INBOX action; the per-platform
 * default fetchers read through the shared MESSAGE triage service, and tests
 * inject deterministic fetchers via {@link setInboxFetchers}.
 */

import { hasOwnerAccess } from "@elizaos/agent/security/access";
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
  ProviderDataRecord,
} from "@elizaos/core";
import { getDefaultTriageService, logger } from "@elizaos/core";
import { InboxRepository } from "../inbox/repository.ts";
import { InboxService } from "../inbox/service.ts";
import type {
  InboundMessage,
  TriageClassification,
  TriageEntry,
} from "../inbox/types.ts";
import {
  appendInboxDraftChoiceMarker,
  appendInboxTriageChoiceMarkers,
} from "./choice-markers.js";

const ACTION_NAME = "INBOX";

const SUBACTIONS = [
  "list",
  "search",
  "summarize",
  "triage",
  "reply",
  "snooze",
  "archive",
  "approve",
] as const;

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

const TRIAGE_CLASSIFICATIONS = new Set<TriageClassification>([
  "ignore",
  "info",
  "notify",
  "needs_reply",
  "urgent",
]);

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

export interface InboxActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  platforms?: readonly string[];
  since?: string;
  limit?: number;
  query?: string;
  id?: string;
  entryId?: string;
  messageId?: string;
  body?: string;
  text?: string;
  draft?: string;
  until?: string;
  snoozedUntil?: string;
  confirmed?: boolean;
  classification?: string;
  includeSnoozed?: boolean;
}

export interface InboxSummaryEntry {
  readonly platform: InboxPlatform;
  readonly count: number;
  readonly latestAt: string | null;
}

/** A platform whose fetch failed during the fan-out, with the real error. */
export interface InboxDegradedPlatform {
  readonly platform: InboxPlatform;
  readonly error: string;
}

export interface InboxResult {
  readonly subaction: Subaction;
  readonly platforms: readonly InboxPlatform[];
  readonly items: readonly InboxItem[];
  readonly summary?: readonly InboxSummaryEntry[];
  readonly query?: string;
  readonly since?: string;
  readonly totalBeforeDedupe: number;
  /**
   * Platforms that could not be checked. Required: empty means every
   * requested platform answered; non-empty means the result may be
   * incomplete and must not be presented as a clean empty inbox.
   */
  readonly degraded: readonly InboxDegradedPlatform[];
}

export interface InboxQueueOperationResult {
  readonly success: boolean;
  readonly text: string;
  readonly data: ProviderDataRecord;
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

const PLATFORM_TO_MESSAGE_SOURCE: Partial<
  Record<InboxPlatform, MessageSource>
> = {
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
      // Re-throw with the platform attached; fetchInboxItems settles the
      // fan-out and reports the failure as a degraded platform instead of
      // letting a broken connector masquerade as an empty feed.
      logger.warn(
        `[INBOX] ${platform} fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
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

/**
 * Fan out to the per-platform fetchers and return the deduped, recency-ordered
 * merge plus the platforms whose fetch failed. Shared by the `list` /
 * `search` / `summarize` reads and the `triage` classification path. One
 * broken platform never hides the others' messages, and never hides itself:
 * every failure lands in `degraded` with its real error.
 */
async function fetchInboxItems(args: {
  runtime: IAgentRuntime;
  platforms: readonly InboxPlatform[];
  since?: string;
  limit: number;
  query?: string;
}): Promise<{
  merged: readonly InboxItem[];
  totalBeforeDedupe: number;
  degraded: readonly InboxDegradedPlatform[];
}> {
  const settled = await Promise.allSettled(
    args.platforms.map(async (platform) => {
      const fetcher = activeFetchers[platform];
      return fetcher({
        runtime: args.runtime,
        ...(args.since ? { since: args.since } : {}),
        limit: args.limit,
        ...(args.query ? { query: args.query } : {}),
      });
    }),
  );
  const flat: InboxItem[] = [];
  const degraded: InboxDegradedPlatform[] = [];
  settled.forEach((result, index) => {
    const platform = args.platforms[index];
    if (!platform) return;
    if (result.status === "fulfilled") {
      flat.push(...result.value);
      return;
    }
    degraded.push({
      platform,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  });
  return {
    merged: dedupeAndOrder(flat),
    totalBeforeDedupe: flat.length,
    degraded,
  };
}

/** One-line warning suffix naming every platform that could not be checked. */
function degradedSuffix(degraded: readonly InboxDegradedPlatform[]): string {
  if (degraded.length === 0) return "";
  const parts = degraded.map((entry) => `${entry.platform} (${entry.error})`);
  return ` Warning: could not check ${parts.join(", ")} — results may be incomplete.`;
}

/**
 * Project a fetched inbox item onto the classifier's {@link InboundMessage}
 * contract, enriching from the canonical {@link MessageRef} in the core triage
 * store when one exists (full body text, group/DM shape, thread + room ids).
 */
function toInboundMessage(item: InboxItem): InboundMessage {
  const ref = getDefaultTriageService().getStore().getMessage(item.id);
  const timestamp = ref?.receivedAtMs ?? Date.parse(item.receivedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `inbox item ${item.id} has an invalid receivedAt timestamp`,
    );
  }
  return {
    id: item.id,
    source: item.platform,
    senderName: item.senderName,
    channelName: item.threadTopic ?? item.channel,
    channelType: ref && ref.to.length > 1 ? "group" : "dm",
    text: ref?.body ?? item.snippet,
    snippet: item.snippet,
    timestamp,
    ...(ref?.channelId ? { roomId: ref.channelId } : {}),
    ...(ref?.threadId ? { threadId: ref.threadId } : {}),
    ...(item.deepLink ? { deepLink: item.deepLink } : {}),
  };
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

const MESSAGE_SOURCES = new Set<MessageSource>([
  "gmail",
  "discord",
  "telegram",
  "twitter",
  "imessage",
  "signal",
  "whatsapp",
  "browser_bridge",
]);

function normalizeMessageSource(value: string): MessageSource | null {
  const normalized = value.trim().toLowerCase();
  const source =
    normalized === "x" || normalized === "x_dm" || normalized === "twitter_dm"
      ? "twitter"
      : normalized;
  return MESSAGE_SOURCES.has(source as MessageSource)
    ? (source as MessageSource)
    : null;
}

function parseEntryId(params: InboxActionParameters): string | null {
  const raw = params.entryId ?? params.id ?? params.messageId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function parseReplyBody(params: InboxActionParameters): string | null {
  const raw = params.body ?? params.text ?? params.draft;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function parseConfirmation(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "y", "confirmed"].includes(normalized);
  }
  return false;
}

/** Default snooze window when a tap sends no explicit timestamp: ~1 day out. */
const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the snooze-until timestamp for a snooze op.
 *
 * Three outcomes, kept distinct on purpose:
 *   - a valid explicit timestamp  -> that ISO instant
 *   - NO timestamp at all          -> the default window (one-tap Snooze chip:
 *                                     its value is a bare `inbox snooze <id>`,
 *                                     so a tap carries no time to parse #14735)
 *   - an INVALID timestamp         -> `null`, so the caller rejects bad input
 *                                     instead of silently snoozing to default
 */
function resolveSnoozeUntil(params: InboxActionParameters): string | null {
  const raw = params.snoozedUntil ?? params.until;
  if (raw === undefined) {
    return new Date(Date.now() + DEFAULT_SNOOZE_MS).toISOString();
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function parseClassification(value: unknown): TriageClassification | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return TRIAGE_CLASSIFICATIONS.has(normalized as TriageClassification)
    ? (normalized as TriageClassification)
    : null;
}

function requireEntryId(params: InboxActionParameters): string {
  const entryId = parseEntryId(params);
  if (!entryId) {
    throw new Error("entry id is required");
  }
  return entryId;
}

async function loadEntry(
  repo: InboxRepository,
  id: string,
): Promise<TriageEntry> {
  const entry = await repo.getById(id);
  if (!entry) {
    throw new Error(`inbox entry ${id} was not found`);
  }
  return entry;
}

function ensureMessageSource(entry: TriageEntry): MessageSource {
  const source = normalizeMessageSource(entry.source);
  if (!source) {
    throw new Error(
      `inbox entry ${entry.id} source "${entry.source}" is not supported by MESSAGE dispatch`,
    );
  }
  return source;
}

function ensureSourceMessageId(entry: TriageEntry): string {
  if (entry.sourceMessageId) return entry.sourceMessageId;
  throw new Error(
    `inbox entry ${entry.id} has no source message id for connector dispatch`,
  );
}

function seedMessageRefForEntry(
  runtime: IAgentRuntime,
  entry: TriageEntry,
): void {
  const source = ensureMessageSource(entry);
  const messageId = ensureSourceMessageId(entry);
  const threadId = entry.sourceRoomId ?? entry.sourceMessageId;
  const service = getDefaultTriageService();
  if (service.getStore().getMessage(messageId)) return;
  service.getStore().saveMessage({
    id: messageId,
    source,
    externalId: messageId,
    from: {
      identifier: entry.sourceEntityId ?? entry.senderName ?? messageId,
      ...(entry.senderName ? { displayName: entry.senderName } : {}),
    },
    to: [{ identifier: runtime.agentId }],
    snippet: entry.snippet,
    body: entry.threadContext?.join("\n") ?? entry.snippet,
    receivedAtMs: Date.parse(entry.createdAt) || Date.now(),
    hasAttachments: false,
    isRead: false,
    metadata: {
      inboxEntryId: entry.id,
      deepLink: entry.deepLink,
      triageReasoning: entry.triageReasoning,
    },
    ...(threadId ? { threadId } : {}),
    ...(entry.source === "gmail" ? { subject: entry.channelName } : {}),
    ...(entry.sourceRoomId
      ? { worldId: entry.sourceRoomId, channelId: entry.sourceRoomId }
      : {}),
  });
}

async function replyToEntry(args: {
  runtime: IAgentRuntime;
  repo: InboxRepository;
  entry: TriageEntry;
  body: string;
  confirmed: boolean;
}): Promise<InboxQueueOperationResult> {
  seedMessageRefForEntry(args.runtime, args.entry);
  const service = getDefaultTriageService();
  const draft = await service.draftReply(
    args.runtime,
    ensureSourceMessageId(args.entry),
    args.body,
  );
  await args.repo.updateDraftResponse(args.entry.id, args.body);

  if (!args.confirmed) {
    return {
      success: true,
      text: appendInboxDraftChoiceMarker(
        `Drafted reply for ${args.entry.senderName ?? args.entry.channelName}. Confirm before sending.`,
        args.entry.id,
      ),
      data: {
        subaction: "reply",
        requiresConfirmation: true,
        entryId: args.entry.id,
        draftId: draft.draftId,
        preview: draft.preview,
        source: draft.source,
      },
    };
  }

  const sent = await service.sendDraft(args.runtime, draft.draftId);
  await args.repo.markResolved(args.entry.id, {
    draftResponse: args.body,
    autoReplied: true,
  });
  return {
    success: true,
    text: `Sent reply on ${sent.source}.`,
    data: {
      subaction: "reply",
      entryId: args.entry.id,
      draftId: sent.draftId,
      source: sent.source,
      externalId: sent.sentExternalId ?? null,
    },
  };
}

async function archiveEntry(
  runtime: IAgentRuntime,
  repo: InboxRepository,
  entry: TriageEntry,
): Promise<InboxQueueOperationResult> {
  seedMessageRefForEntry(runtime, entry);
  const service = getDefaultTriageService();
  const source = ensureMessageSource(entry);
  const messageId = ensureSourceMessageId(entry);
  const result = await service.manage(
    runtime,
    messageId,
    { kind: "archive" },
    { source },
  );
  if (!result.ok) {
    return {
      success: false,
      text: `Could not archive inbox entry ${entry.id}: ${result.reason ?? "adapter rejected archive"}.`,
      data: {
        subaction: "archive",
        entryId: entry.id,
        error: "ARCHIVE_FAILED",
        reason: result.reason ?? null,
      },
    };
  }
  await repo.markResolved(entry.id);
  return {
    success: true,
    text: `Archived ${entry.channelName}.`,
    data: { subaction: "archive", entryId: entry.id, source },
  };
}

export async function executeInboxQueueOperation(args: {
  runtime: IAgentRuntime;
  subaction: Extract<
    Subaction,
    "triage" | "reply" | "snooze" | "archive" | "approve"
  >;
  params: InboxActionParameters;
}): Promise<InboxQueueOperationResult> {
  const repo = new InboxRepository(args.runtime);
  switch (args.subaction) {
    case "triage": {
      const limit =
        typeof args.params.limit === "number" && args.params.limit > 0
          ? Math.floor(args.params.limit)
          : 50;
      const classification = parseClassification(args.params.classification);
      let classifiedCount = 0;
      // 1. Pull fresh cross-channel messages through the same fan-out `list`
      //    uses, then classify only the ones without a persisted entry yet.
      //    `classification` narrows the queue returned below; it must not skip
      //    the LLM classifier for a fresh triage request.
      const since =
        typeof args.params.since === "string" &&
        args.params.since.trim().length > 0
          ? args.params.since.trim()
          : undefined;
      const { merged, degraded } = await fetchInboxItems({
        runtime: args.runtime,
        platforms: resolvePlatforms(args.params.platforms),
        ...(since ? { since } : {}),
        limit,
      });
      const alreadyTriaged = await repo.getBySourceMessageIds(
        merged.map((item) => item.id),
      );
      const freshMessages = merged
        .filter((item) => !alreadyTriaged.has(item.id))
        .map((item) => toInboundMessage(item));
      if (freshMessages.length > 0) {
        const service = new InboxService(args.runtime);
        const { triaged } = await service.triage(freshMessages);
        classifiedCount = triaged.length;
      }
      // 2. Return the pending queue, which now includes the rows the
      //    classifier just persisted, optionally narrowed by classification.
      const entries = classification
        ? await repo.getByClassification(classification, {
            limit,
            includeSnoozed: args.params.includeSnoozed === true,
          })
        : await repo.getUnresolved({
            limit,
            includeSnoozed: args.params.includeSnoozed === true,
          });
      const baseText =
        classifiedCount > 0
          ? `Triaged ${classifiedCount} new message${classifiedCount === 1 ? "" : "s"}; ${entries.length} pending inbox item${entries.length === 1 ? "" : "s"}.`
          : entries.length === 0
            ? "No inbox triage items are pending."
            : `Loaded ${entries.length} pending inbox triage items.`;
      return {
        success: true,
        text: appendInboxTriageChoiceMarkers(
          `${baseText}${degradedSuffix(degraded)}`,
          entries,
        ),
        data: {
          subaction: "triage",
          classified: classifiedCount,
          entries,
          degraded,
        },
      };
    }
    case "snooze": {
      const id = requireEntryId(args.params);
      const until = resolveSnoozeUntil(args.params);
      if (!until) {
        throw new Error("valid snooze timestamp is required");
      }
      await loadEntry(repo, id);
      await repo.snoozeUntil(id, until);
      return {
        success: true,
        text: `Snoozed inbox entry ${id} until ${until}.`,
        data: { subaction: "snooze", entryId: id, snoozedUntil: until },
      };
    }
    case "archive": {
      const entry = await loadEntry(repo, requireEntryId(args.params));
      return archiveEntry(args.runtime, repo, entry);
    }
    case "reply": {
      const entry = await loadEntry(repo, requireEntryId(args.params));
      const body = parseReplyBody(args.params);
      if (!body) {
        throw new Error("reply body is required");
      }
      return replyToEntry({
        runtime: args.runtime,
        repo,
        entry,
        body,
        confirmed: parseConfirmation(args.params.confirmed),
      });
    }
    case "approve": {
      const entry = await loadEntry(repo, requireEntryId(args.params));
      const body =
        parseReplyBody(args.params) ??
        entry.draftResponse ??
        entry.suggestedResponse;
      if (!body) {
        throw new Error("approved entry has no draft or suggested response");
      }
      return replyToEntry({
        runtime: args.runtime,
        repo,
        entry,
        body,
        confirmed: true,
      });
    }
  }
}

/**
 * Owner-access guard for INBOX. Mirrors the LifeOps `hasLifeOpsAccess`
 * predicate exactly: reject when the runtime agent id or the message entity id
 * is missing/empty, then defer to the shared owner-access check.
 */
async function hasInboxAccess(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  if (
    !runtime ||
    typeof runtime.agentId !== "string" ||
    !message ||
    typeof message.entityId !== "string" ||
    message.entityId.length === 0
  ) {
    return false;
  }
  return hasOwnerAccess(runtime, message);
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
  [
    {
      name: "{{name1}}",
      content: { text: "Triage my inbox — what needs my attention?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Triaged your inbox and flagged what needs a reply.",
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
    "Inbox: Gmail, Slack, Discord, Telegram, Signal, iMessage, WhatsApp. Merge recency feed and operate the persisted triage queue. Subactions: list, search, summarize, triage (AI-classify new messages into urgent / needs_reply / notify / info / ignore, then return the prioritized queue), reply, snooze, archive, approve.",
  descriptionCompressed:
    "INBOX list|search|summarize|triage(classify urgent/needs_reply/noise)|reply|snooze|archive|approve gmail|slack|discord|telegram|signal|imessage|whatsapp",
  routingHint:
    'cross-channel inbox ("show inbox", "all messages", "search every channel", "summarize inboxes") -> INBOX; "triage my inbox" / "what needs my attention" -> INBOX triage; per-channel -> MESSAGE',
  contexts: ["inbox", "messaging", "cross-channel"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasInboxAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description:
        "Inbox op: list | search | summarize | triage (classify new messages with the AI triage classifier, then return the pending queue) | reply | snooze | archive | approve.",
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
    {
      name: "entryId",
      description:
        "Persisted triage entry id for reply, snooze, archive, or approve.",
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Reply body for reply/approve.",
      schema: { type: "string" as const },
    },
    {
      name: "until",
      description: "Snooze-until timestamp for snooze. ISO-8601.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Explicit owner confirmation for sending reply/approve.",
      schema: { type: "boolean" as const },
    },
    {
      name: "classification",
      description:
        "Optional triage queue filter for returned persisted items: ignore | info | notify | needs_reply | urgent. Fresh messages are still classified first.",
      schema: {
        type: "string" as const,
        enum: ["ignore", "info", "notify", "needs_reply", "urgent"],
      },
    },
    {
      name: "includeSnoozed",
      description:
        "When true, include snoozed triage queue entries in triage reads.",
      schema: { type: "boolean" as const },
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
    if (!(await hasInboxAccess(runtime, message))) {
      const text = "The inbox is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me which operation: list, search, summarize, triage, reply, snooze, archive, or approve.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    if (
      subaction === "triage" ||
      subaction === "reply" ||
      subaction === "snooze" ||
      subaction === "archive" ||
      subaction === "approve"
    ) {
      try {
        const result = await executeInboxQueueOperation({
          runtime,
          subaction,
          params,
        });
        await callback?.({
          text: result.text,
          source: "action",
          action: ACTION_NAME,
        });
        return {
          success: result.success,
          text: result.text,
          data: result.data,
        };
      } catch (error) {
        const text =
          error instanceof Error ? error.message : "Inbox operation failed.";
        await callback?.({ text, source: "action", action: ACTION_NAME });
        return {
          success: false,
          text,
          data: { subaction, error: "INBOX_OPERATION_FAILED" },
        };
      }
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

    const { merged, totalBeforeDedupe, degraded } = await fetchInboxItems({
      runtime,
      platforms,
      ...(since ? { since } : {}),
      limit,
      ...(query ? { query } : {}),
    });
    const items: readonly InboxItem[] = subaction === "summarize" ? [] : merged;
    const summary: readonly InboxSummaryEntry[] | undefined =
      subaction === "summarize" ? buildSummary(merged, platforms) : undefined;

    logger.info(
      `[INBOX] ${subaction} platforms=${platforms.join(",")} pre=${totalBeforeDedupe} post=${merged.length} degraded=${degraded.map((entry) => entry.platform).join(",") || "none"}`,
    );

    // An empty result with degraded platforms is NOT a clean empty inbox —
    // say which platforms could not be checked so neither the planner nor the
    // user mistakes a broken connector for "no mail".
    let text: string;
    switch (subaction) {
      case "list":
        text =
          merged.length === 0
            ? degraded.length === 0
              ? "Your inbox is empty for this window."
              : "No messages from reachable platforms for this window."
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
    text = `${text}${degradedSuffix(degraded)}`;

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
        totalBeforeDedupe,
        degraded,
      },
    };
  },
};

export default inboxAction;
