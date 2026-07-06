/**
 * Cross-channel inbox aggregation domain.
 *
 * Owns the read-side pipeline that turns raw `InboundMessage`s (chat memories
 * + Gmail + X DMs via `message-fetcher.ts`) into the `LifeOpsInbox` DTO the
 * dashboard renders: channel normalization, filtering, thread grouping, LLM
 * priority scoring (`priority-scoring.ts`), the missed-message filter, and the
 * cached read-through spine (`InboxDomain`).
 *
 * Source health is part of the DTO: every response carries a required
 * `sources` array (`LifeOpsInboxSourceStatus`) describing chat/gmail/x_dm
 * health for that read, so a degraded connector can never present as a
 * healthy empty inbox. Pull paths derive it from the fetch; cache paths probe
 * connector status without pulling messages.
 *
 * Host-owned concerns are injected behind typed seams instead of being
 * imported:
 *   - `InboxMessageCache` — the persisted inbox cache. The tables stay owned
 *     by the host (plugin-personal-assistant keeps `app_lifeops`'s
 *     `life_inbox_messages`); this domain only reads/writes through the seam.
 *   - `PriorityScoringSettingsLoader` — owner policy for whether/which model
 *     scores messages. Defaults to enabled with the runtime's default small
 *     model when the host does not supply one.
 *   - `GmailInboxSource` / `XDmInboxSource` — connector-backed sources
 *     (declared in `message-fetcher.ts`), implemented by the host's connector
 *     projections.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  type GetLifeOpsInboxRequest,
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsInbox,
  type LifeOpsInboxCacheMode,
  type LifeOpsInboxChannel,
  type LifeOpsInboxChannelCount,
  type LifeOpsInboxMessage,
  type LifeOpsInboxSourceStatus,
  type LifeOpsInboxThreadGroup,
} from "@elizaos/shared";
import {
  fetchAllMessages,
  type GmailInboxSource,
  probeSourceStatuses,
  type XDmInboxSource,
} from "./message-fetcher.ts";
import {
  type PriorityCategory,
  type PriorityScore,
  scoreInboxMessages,
} from "./priority-scoring.ts";
import type { InboundMessage } from "./types.ts";

const DEFAULT_INBOX_LIMIT = 100;
const INBOX_CACHE_FRESH_MS = 60_000;
const INBOX_CACHE_WARM_LIMIT = 200;
const INBOX_CACHE_READ_LIMIT = 800;
const INBOX_CACHE_FULL_LIMIT = 5000;
const INBOX_CHANNEL_SET = new Set<LifeOpsInboxChannel>(LIFEOPS_INBOX_CHANNELS);
const PHONE_BACKED_INBOX_CHANNELS = new Set<LifeOpsInboxChannel>([
  "imessage",
  "sms",
  "whatsapp",
]);
const SUBJECT_REPLY_PREFIX = /^(?:\s*(?:re|fwd|fw)\s*:\s*)+/i;
const MISSED_REPLY_GAP_MS = 24 * 60 * 60 * 1000;
const MISSED_MIN_PRIORITY = 50;

export type InboxChatType = "dm" | "group" | "channel";

export function normalizeInboxChannel(
  source: string | null | undefined,
): LifeOpsInboxChannel | null {
  if (typeof source !== "string") return null;
  const trimmed = source.trim().toLowerCase();
  if (!trimmed) return null;
  if (INBOX_CHANNEL_SET.has(trimmed as LifeOpsInboxChannel)) {
    return trimmed as LifeOpsInboxChannel;
  }
  return null;
}

function normalizePhoneAccountKey(value: string): string {
  return value.trim().toLowerCase();
}

function isPhoneBackedInboxChannel(channel: LifeOpsInboxChannel): boolean {
  return PHONE_BACKED_INBOX_CHANNELS.has(channel);
}

function matchesPhoneAccountFilter(
  message: LifeOpsInboxMessage,
  phoneAccountIds: ReadonlySet<string>,
): boolean {
  const candidates = [
    message.phoneAccountId,
    message.phoneNumber,
    message.sourceRef.phoneAccountId,
    message.sourceRef.phoneNumber,
  ];
  return candidates.some(
    (value) =>
      typeof value === "string" &&
      phoneAccountIds.has(normalizePhoneAccountKey(value)),
  );
}

function emptyChannelCounts(): Record<
  LifeOpsInboxChannel,
  LifeOpsInboxChannelCount
> {
  const counts = {} as Record<LifeOpsInboxChannel, LifeOpsInboxChannelCount>;
  for (const channel of LIFEOPS_INBOX_CHANNELS) {
    counts[channel] = { total: 0, unread: 0 };
  }
  return counts;
}

function deriveThreadId(
  message: InboundMessage,
  channel: LifeOpsInboxChannel,
  externalId: string,
): string {
  if (typeof message.threadId === "string" && message.threadId.length > 0) {
    return message.threadId;
  }
  if (channel === "x_dm" && message.xConversationId) {
    return message.xConversationId;
  }
  if (channel === "gmail") {
    const subject = message.channelName
      .replace(/^Email from\s+/i, "")
      .replace(SUBJECT_REPLY_PREFIX, "")
      .trim();
    const fromKey =
      message.senderEmail?.trim().toLowerCase() ?? message.senderName;
    return `gmail:${fromKey}:${subject || externalId}`;
  }
  if (message.roomId) {
    return message.roomId;
  }
  return externalId;
}

export function toInboxMessage(
  message: InboundMessage,
  channel: LifeOpsInboxChannel,
  index: number,
): LifeOpsInboxMessage {
  const externalId =
    channel === "gmail" ? (message.gmailMessageId ?? message.id) : message.id;
  const senderId =
    channel === "gmail"
      ? (message.gmailMessageId ?? message.id)
      : (message.entityId ?? message.roomId ?? message.id);
  const receivedAt = new Date(message.timestamp).toISOString();
  const subject =
    channel === "gmail"
      ? message.channelName.startsWith("Email from ")
        ? message.channelName.slice("Email from ".length)
        : message.channelName
      : null;

  // Gmail triage exposes `likelyReplyNeeded`/`isImportant` but the shared
  // `InboundMessage` shape does not carry a per-channel read flag yet. Until
  // the chat fetcher tracks read state per memory, mark chat messages as
  // unread so the inbox surfaces them for triage.
  const unread =
    channel === "gmail"
      ? Boolean(
          message.gmailLikelyReplyNeeded === true ||
            message.gmailIsImportant === true,
        )
      : true;

  const threadId = deriveThreadId(message, channel, externalId);
  const chatType: InboxChatType =
    message.chatType ??
    (channel === "gmail"
      ? "dm"
      : message.channelType === "group"
        ? "group"
        : "dm");

  return {
    id: `${channel}:${externalId || `${message.timestamp}-${index}`}`,
    channel,
    sender: {
      id: senderId,
      displayName: message.senderName || "Unknown",
      email: message.senderEmail?.trim().toLowerCase() || null,
      avatarUrl: null,
    },
    subject,
    snippet: message.snippet,
    receivedAt,
    unread,
    deepLink: message.deepLink ?? null,
    sourceRef: {
      channel,
      externalId: externalId,
      ...(message.phoneAccountId
        ? { phoneAccountId: message.phoneAccountId }
        : {}),
      ...(message.phoneAccountLabel
        ? { phoneAccountLabel: message.phoneAccountLabel }
        : {}),
      ...(message.phoneNumber ? { phoneNumber: message.phoneNumber } : {}),
    },
    threadId,
    chatType,
    participantCount: message.participantCount,
    gmailAccountId: message.gmailAccountId,
    gmailAccountEmail: message.gmailAccountEmail,
    phoneAccountId: message.phoneAccountId,
    phoneAccountLabel: message.phoneAccountLabel,
    phoneNumber: message.phoneNumber,
    lastSeenAt: message.lastSeenAt,
    repliedAt: message.repliedAt,
    priorityScore: message.priorityScore,
  };
}

export function toInboxMessages(
  inbound: InboundMessage[],
): LifeOpsInboxMessage[] {
  const messages: LifeOpsInboxMessage[] = [];
  let index = 0;
  for (const message of inbound) {
    const channel = normalizeInboxChannel(message.source);
    index += 1;
    if (!channel) continue;
    messages.push(toInboxMessage(message, channel, index - 1));
  }
  return messages;
}

interface InboxBuildOptions {
  limit: number;
  allowed: Set<LifeOpsInboxChannel>;
  /**
   * Per-source connector health for the fetch/read that produced the input
   * messages. Required: every built inbox must state its source health so an
   * empty message list can never pass for a healthy empty inbox.
   */
  sources: LifeOpsInboxSourceStatus[];
  groupByThread?: boolean;
  chatTypeFilter?: ReadonlyArray<InboxChatType>;
  maxParticipants?: number;
  gmailAccountId?: string;
  phoneAccountIds?: ReadonlySet<string>;
  /** User identity hint for LLM scoring; structural aggregation never ranks by name substrings. */
  ownerName?: string | null;
  missedOnly?: boolean;
  /**
   * When true, thread groups are sorted by maxPriorityScore desc with recency
   * as tiebreaker. When false (default), groups are sorted by recency only.
   * Messages mode opts in; Mail mode keeps recency-first because email
   * priority is less actionable.
   */
  sortByPriority?: boolean;
  /** Optional precomputed score map keyed by message id. */
  llmScores?: ReadonlyMap<string, PriorityScore>;
}

function applyLlmScores(
  messages: LifeOpsInboxMessage[],
  scores: ReadonlyMap<string, PriorityScore>,
): void {
  if (scores.size === 0) return;
  for (const message of messages) {
    const score = scores.get(message.id);
    if (!score) continue;
    message.priorityScore = score.score;
    message.priorityCategory = score.category;
  }
}

function buildThreadGroups(
  messages: LifeOpsInboxMessage[],
  llmScores?: ReadonlyMap<string, PriorityScore>,
  sortByPriority = false,
): LifeOpsInboxThreadGroup[] {
  const buckets = new Map<string, LifeOpsInboxMessage[]>();
  for (const message of messages) {
    const key = message.threadId ?? message.id;
    const bucket = buckets.get(key) ?? [];
    bucket.push(message);
    buckets.set(key, bucket);
  }

  const groups: LifeOpsInboxThreadGroup[] = [];
  for (const [key, members] of buckets) {
    members.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const latestMessage = members[0];
    if (!latestMessage) continue;
    const totalCount = members.length;
    const unreadCount = members.filter((m) => m.unread).length;
    const participantCount = members.find(
      (m) => typeof m.participantCount === "number",
    )?.participantCount;

    const priorityScores = members
      .map((m) => m.priorityScore)
      .filter((value): value is number => typeof value === "number");

    // Determine the dominant category from persisted or current LLM scoring.
    let priorityCategory: PriorityCategory | undefined;
    let bestPersistedCategory: {
      category: PriorityCategory;
      score: number;
    } | null = null;
    for (const member of members) {
      if (!member.priorityCategory) continue;
      const score = member.priorityScore ?? 0;
      if (!bestPersistedCategory || score > bestPersistedCategory.score) {
        bestPersistedCategory = {
          category: member.priorityCategory,
          score,
        };
      }
    }
    if (bestPersistedCategory) {
      priorityCategory = bestPersistedCategory.category;
    }
    if (llmScores && llmScores.size > 0) {
      const seen = new Map<PriorityCategory, number>();
      let best: { category: PriorityCategory; score: number } | null = null;
      for (const member of members) {
        const score = llmScores.get(member.id);
        if (!score) continue;
        seen.set(score.category, (seen.get(score.category) ?? 0) + 1);
        if (!best || score.score > best.score) {
          best = { category: score.category, score: score.score };
        }
      }
      // Prefer the category attached to the highest-scoring message; ties
      // fall back to the most common category.
      if (best) {
        priorityCategory = best.category;
      } else if (seen.size > 0) {
        let topCategory: PriorityCategory = "casual";
        let topCount = -1;
        for (const [cat, count] of seen) {
          if (count > topCount) {
            topCount = count;
            topCategory = cat;
          }
        }
        priorityCategory = topCategory;
      }
    }

    const maxPriorityScore =
      priorityScores.length > 0 ? Math.max(...priorityScores) : undefined;

    groups.push({
      threadId: key,
      channel: latestMessage.channel,
      chatType: latestMessage.chatType ?? "dm",
      latestMessage,
      totalCount,
      unreadCount,
      participantCount,
      maxPriorityScore,
      priorityCategory,
      messages: [...members],
    });
  }

  if (sortByPriority) {
    groups.sort((a, b) => {
      const aScore = a.maxPriorityScore ?? -1;
      const bScore = b.maxPriorityScore ?? -1;
      if (aScore !== bScore) return bScore - aScore;
      return (
        Date.parse(b.latestMessage.receivedAt) -
        Date.parse(a.latestMessage.receivedAt)
      );
    });
  } else {
    groups.sort(
      (a, b) =>
        Date.parse(b.latestMessage.receivedAt) -
        Date.parse(a.latestMessage.receivedAt),
    );
  }
  return groups;
}

function isMissedMessage(message: LifeOpsInboxMessage, nowMs: number): boolean {
  if (typeof message.repliedAt === "string" && message.repliedAt.length > 0) {
    return false;
  }
  const score = message.priorityScore;
  if (typeof score !== "number" || score < MISSED_MIN_PRIORITY) {
    return false;
  }
  const received = Date.parse(message.receivedAt);
  if (!Number.isFinite(received)) return false;
  return nowMs - received >= MISSED_REPLY_GAP_MS;
}

function isMissedThreadGroup(
  group: LifeOpsInboxThreadGroup,
  nowMs: number,
): boolean {
  return group.messages.some((message) => isMissedMessage(message, nowMs));
}

export function buildInbox(
  inbound: InboundMessage[],
  options: InboxBuildOptions,
): LifeOpsInbox {
  return buildInboxFromMessages(toInboxMessages(inbound), options);
}

export function buildInboxFromMessages(
  sourceMessages: readonly LifeOpsInboxMessage[],
  options: InboxBuildOptions,
): LifeOpsInbox {
  const collected: LifeOpsInboxMessage[] = [];
  const counts = emptyChannelCounts();
  const chatTypeFilter =
    options.chatTypeFilter && options.chatTypeFilter.length > 0
      ? new Set(options.chatTypeFilter)
      : null;

  for (const message of sourceMessages) {
    const channel = message.channel;
    if (!channel || !options.allowed.has(channel)) {
      continue;
    }
    const normalized = { ...message, sender: { ...message.sender } };

    if (chatTypeFilter && !chatTypeFilter.has(normalized.chatType ?? "dm")) {
      continue;
    }
    if (
      typeof options.maxParticipants === "number" &&
      normalized.chatType === "group" &&
      typeof normalized.participantCount === "number" &&
      normalized.participantCount > options.maxParticipants
    ) {
      continue;
    }
    if (
      options.gmailAccountId &&
      channel === "gmail" &&
      normalized.gmailAccountId !== options.gmailAccountId
    ) {
      continue;
    }
    if (
      options.phoneAccountIds &&
      options.phoneAccountIds.size > 0 &&
      isPhoneBackedInboxChannel(channel) &&
      !matchesPhoneAccountFilter(normalized, options.phoneAccountIds)
    ) {
      continue;
    }

    collected.push(normalized);
    const channelCount = counts[channel];
    channelCount.total += 1;
    if (normalized.unread) {
      channelCount.unread += 1;
    }
  }

  collected.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));

  const trimmed =
    collected.length > options.limit
      ? collected.slice(0, options.limit)
      : collected;

  if (options.llmScores && options.llmScores.size > 0) {
    applyLlmScores(trimmed, options.llmScores);
  }

  let messages = trimmed;
  let threadGroups: LifeOpsInboxThreadGroup[] | undefined;

  if (options.groupByThread) {
    threadGroups = buildThreadGroups(
      trimmed,
      options.llmScores,
      options.sortByPriority === true,
    );
  }

  if (options.missedOnly === true) {
    const nowMs = Date.now();
    messages = messages.filter((m) => isMissedMessage(m, nowMs));
    if (threadGroups) {
      threadGroups = threadGroups.filter((g) => isMissedThreadGroup(g, nowMs));
    }
  }

  const inbox: LifeOpsInbox = {
    messages,
    channelCounts: counts,
    fetchedAt: new Date().toISOString(),
    sources: options.sources,
  };

  if (threadGroups) {
    inbox.threadGroups = threadGroups;
  }

  return inbox;
}

function cacheReadLimitFor(resolved: ResolvedInboxRequest): number {
  if (resolved.cacheMode === "cache-only") {
    return Math.max(resolved.limit, resolved.cacheLimit);
  }
  if (resolved.cacheLimit > INBOX_CACHE_READ_LIMIT) {
    return Math.max(resolved.limit, resolved.cacheLimit);
  }
  return Math.min(
    INBOX_CACHE_READ_LIMIT,
    Math.max(resolved.limit * 4, INBOX_CACHE_WARM_LIMIT),
  );
}

function cacheWarmLimitFor(resolved: ResolvedInboxRequest): number {
  if (resolved.cacheMode === "refresh") {
    return resolved.cacheLimit;
  }
  return Math.min(500, Math.max(resolved.limit, INBOX_CACHE_WARM_LIMIT));
}

function isFreshCache(records: readonly CachedInboxMessage[]): boolean {
  if (records.length === 0) return false;
  let newest = 0;
  for (const record of records) {
    const parsed = Date.parse(record.cachedAt);
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }
  return newest > 0 && Date.now() - newest <= INBOX_CACHE_FRESH_MS;
}

function flattenInboxMessages(inbox: LifeOpsInbox): LifeOpsInboxMessage[] {
  const messages = new Map<string, LifeOpsInboxMessage>();
  for (const message of inbox.messages) {
    messages.set(message.id, message);
  }
  for (const group of inbox.threadGroups ?? []) {
    messages.set(group.latestMessage.id, group.latestMessage);
    for (const message of group.messages) {
      messages.set(message.id, message);
    }
  }
  return [...messages.values()];
}

export interface ResolvedInboxRequest {
  limit: number;
  allowed: Set<LifeOpsInboxChannel>;
  groupByThread: boolean;
  chatTypeFilter?: ReadonlyArray<InboxChatType>;
  maxParticipants?: number;
  gmailAccountId?: string;
  phoneAccountIds?: ReadonlySet<string>;
  missedOnly: boolean;
  sortByPriority: boolean;
  cacheMode: LifeOpsInboxCacheMode;
  cacheLimit: number;
}

export function resolveInboxRequest(
  request: GetLifeOpsInboxRequest,
): ResolvedInboxRequest {
  const limit =
    typeof request.limit === "number" &&
    Number.isFinite(request.limit) &&
    request.limit > 0
      ? Math.min(Math.floor(request.limit), 500)
      : DEFAULT_INBOX_LIMIT;
  const requestedChannels =
    request.channels && request.channels.length > 0
      ? (request.channels.filter((channel) =>
          INBOX_CHANNEL_SET.has(channel),
        ) as LifeOpsInboxChannel[])
      : [...LIFEOPS_INBOX_CHANNELS];
  const chatTypeFilter =
    Array.isArray(request.chatTypeFilter) && request.chatTypeFilter.length > 0
      ? (request.chatTypeFilter.filter(
          (value) => value === "dm" || value === "group" || value === "channel",
        ) as InboxChatType[])
      : undefined;
  const cacheMode: LifeOpsInboxCacheMode =
    request.cacheMode === "refresh" || request.cacheMode === "cache-only"
      ? request.cacheMode
      : "read-through";
  const requestedCacheLimit =
    typeof request.cacheLimit === "number" &&
    Number.isFinite(request.cacheLimit) &&
    request.cacheLimit > 0
      ? Math.floor(request.cacheLimit)
      : undefined;
  const cacheLimit = Math.min(
    requestedCacheLimit ??
      (cacheMode === "read-through"
        ? INBOX_CACHE_WARM_LIMIT
        : INBOX_CACHE_FULL_LIMIT),
    INBOX_CACHE_FULL_LIMIT,
  );
  const phoneAccountIds =
    Array.isArray(request.phoneAccountIds) && request.phoneAccountIds.length > 0
      ? new Set(
          request.phoneAccountIds
            .map((value) =>
              typeof value === "string" ? normalizePhoneAccountKey(value) : "",
            )
            .filter(Boolean),
        )
      : undefined;
  return {
    limit,
    allowed: new Set<LifeOpsInboxChannel>(requestedChannels),
    groupByThread: request.groupByThread === true,
    chatTypeFilter,
    maxParticipants:
      typeof request.maxParticipants === "number" &&
      Number.isFinite(request.maxParticipants) &&
      request.maxParticipants > 0
        ? Math.floor(request.maxParticipants)
        : undefined,
    gmailAccountId:
      typeof request.gmailAccountId === "string" &&
      request.gmailAccountId.trim().length > 0
        ? request.gmailAccountId.trim()
        : undefined,
    phoneAccountIds,
    missedOnly: request.missedOnly === true,
    sortByPriority: request.sortByPriority === true,
    cacheMode,
    cacheLimit,
  };
}

function resolveOwnerName(runtime: IAgentRuntime): string | null {
  const name = runtime.character.name;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : null;
}

/** Owner policy for LLM priority scoring, supplied by the host. */
export interface PriorityScoringSettings {
  enabled: boolean;
  /** Model id override; `null` uses the runtime's default small model. */
  model: string | null;
}

/**
 * Host seam that loads the owner's priority-scoring policy (e.g. from the
 * LifeOps app state). Implementations own their failure handling — if loading
 * the policy can fail, decide the fallback there, not here.
 */
export type PriorityScoringSettingsLoader =
  () => Promise<PriorityScoringSettings>;

const DEFAULT_PRIORITY_SCORING_SETTINGS: PriorityScoringSettings = {
  enabled: true,
  model: null,
};

async function computeLlmScores(
  runtime: IAgentRuntime,
  messages: LifeOpsInboxMessage[],
  ownerName: string | null,
  loadSettings?: PriorityScoringSettingsLoader,
): Promise<Map<string, PriorityScore>> {
  const out = new Map<string, PriorityScore>();
  if (messages.length === 0) return out;
  const settings = loadSettings
    ? await loadSettings()
    : DEFAULT_PRIORITY_SCORING_SETTINGS;
  if (!settings.enabled) return out;
  const scored = await scoreInboxMessages(runtime, messages, {
    ownerName,
    model: settings.model,
  });
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const score = scored[i];
    if (!message || !score) continue;
    out.set(message.id, score);
  }
  return out;
}

/**
 * Build the inbox once with a synchronous shell (channel allow-list, filters,
 * trimming) so we know which messages survive, then score those messages
 * with the LLM and rebuild thread groups with priority data attached.
 */
async function buildInboxWithLlm(
  runtime: IAgentRuntime,
  inbound: InboundMessage[],
  resolved: ResolvedInboxRequest,
  sources: LifeOpsInboxSourceStatus[],
  loadSettings?: PriorityScoringSettingsLoader,
): Promise<LifeOpsInbox> {
  const ownerName = resolveOwnerName(runtime);
  // First pass: trim and filter without LLM scoring or grouping. We still
  // honor the chatType / participant / gmail filters here because LLM scoring
  // should only run on messages the user will actually see.
  const initial = buildInbox(inbound, {
    limit: resolved.limit,
    allowed: resolved.allowed,
    sources,
    chatTypeFilter: resolved.chatTypeFilter,
    maxParticipants: resolved.maxParticipants,
    gmailAccountId: resolved.gmailAccountId,
    phoneAccountIds: resolved.phoneAccountIds,
    ownerName,
    // groupByThread/missedOnly are deferred to the second pass so we can
    // factor in LLM scores before grouping/filtering.
    groupByThread: false,
  });

  const llmScores = await computeLlmScores(
    runtime,
    initial.messages,
    ownerName,
    loadSettings,
  );

  // Second pass: re-build with the LLM scores so thread grouping picks them
  // up and missedOnly can filter on score >= 50.
  return buildInbox(inbound, {
    limit: resolved.limit,
    allowed: resolved.allowed,
    sources,
    chatTypeFilter: resolved.chatTypeFilter,
    maxParticipants: resolved.maxParticipants,
    gmailAccountId: resolved.gmailAccountId,
    phoneAccountIds: resolved.phoneAccountIds,
    ownerName,
    groupByThread: resolved.groupByThread,
    missedOnly: resolved.missedOnly,
    sortByPriority: resolved.sortByPriority,
    llmScores,
  });
}

export async function fetchInbox(
  runtime: IAgentRuntime,
  request: GetLifeOpsInboxRequest = {},
  gmailSource?: GmailInboxSource,
  xDmSource?: XDmInboxSource,
  loadPriorityScoringSettings?: PriorityScoringSettingsLoader,
): Promise<LifeOpsInbox> {
  const resolved = resolveInboxRequest(request);
  const { messages: inbound, sources } = await fetchAllMessages(runtime, {
    sources: Array.from(resolved.allowed),
    limit:
      resolved.cacheMode === "refresh" ? resolved.cacheLimit : resolved.limit,
    includeGmail: resolved.allowed.has("gmail"),
    gmailSource,
    xDmSource,
    gmailGrantId: resolved.gmailAccountId,
  });
  return buildInboxWithLlm(
    runtime,
    inbound,
    resolved,
    sources,
    loadPriorityScoringSettings,
  );
}

export interface LifeOpsInboxService {
  getInbox(request?: GetLifeOpsInboxRequest): Promise<LifeOpsInbox>;
  markInboxEntryRead(inboxEntryId: string): Promise<LifeOpsInboxMessage>;
}

/**
 * Cross-domain connector sources the inbox fetcher reads from. Gmail status +
 * triage are owned by the Google/Gmail domains; X DM sync/reads are owned by
 * the X read domain, so they are injected as typed callbacks.
 */
export type InboxDeps = GmailInboxSource & XDmInboxSource;

/** A cached inbox message row as returned by the host's cache store. */
export type CachedInboxMessage = LifeOpsInboxMessage & { cachedAt: string };

/**
 * Host seam over the persisted inbox message cache. plugin-personal-assistant
 * implements this with `LifeOpsRepository`'s `life_inbox_messages` cache in
 * `app_lifeops` (those tables stay host-owned; this domain never touches the
 * DB directly).
 */
export interface InboxMessageCache {
  listCachedInboxMessages(
    agentId: string,
    options?: {
      channels?: readonly LifeOpsInboxChannel[];
      maxResults?: number;
      gmailAccountId?: string;
    },
  ): Promise<CachedInboxMessage[]>;
  upsertCachedInboxMessages(
    agentId: string,
    messages: readonly LifeOpsInboxMessage[],
  ): Promise<unknown>;
  markCachedInboxMessageRead(
    agentId: string,
    inboxEntryId: string,
  ): Promise<LifeOpsInboxMessage | null>;
}

export interface InboxDomainDeps {
  runtime: IAgentRuntime;
  cache: InboxMessageCache;
  sources: InboxDeps;
  /** Optional owner policy loader; defaults to enabled + default model. */
  loadPriorityScoringSettings?: PriorityScoringSettingsLoader;
}

/**
 * Inbox read side: cross-channel fetch (chat memories + Gmail + X DMs),
 * LLM priority scoring, thread grouping, and the cached read-through path
 * backed by the injected cache seam.
 */
export class InboxDomain {
  constructor(private readonly deps: InboxDomainDeps) {}

  async getInbox(request: GetLifeOpsInboxRequest = {}): Promise<LifeOpsInbox> {
    const { runtime, cache, sources, loadPriorityScoringSettings } = this.deps;
    const resolved = resolveInboxRequest(request);
    const ownerName = resolveOwnerName(runtime);
    // Cache reads skip the message pull but never skip source health: an
    // expired Gmail token must surface even when messages come from cache.
    const probeStatuses = (): Promise<LifeOpsInboxSourceStatus[]> =>
      probeSourceStatuses({
        includeChat: [...resolved.allowed].some(
          (channel) => channel !== "gmail" && channel !== "x_dm",
        ),
        includeGmail: resolved.allowed.has("gmail"),
        gmailSource: sources,
        includeXDm: resolved.allowed.has("x_dm"),
        xDmSource: sources,
      });
    const buildFromCache = (
      messages: readonly CachedInboxMessage[],
      sourceStatuses: LifeOpsInboxSourceStatus[],
    ): LifeOpsInbox =>
      buildInboxFromMessages(messages, {
        limit: resolved.limit,
        allowed: resolved.allowed,
        sources: sourceStatuses,
        chatTypeFilter: resolved.chatTypeFilter,
        maxParticipants: resolved.maxParticipants,
        gmailAccountId: resolved.gmailAccountId,
        phoneAccountIds: resolved.phoneAccountIds,
        ownerName,
        groupByThread: resolved.groupByThread,
        missedOnly: resolved.missedOnly,
        sortByPriority: resolved.sortByPriority,
      });
    const cached = await cache.listCachedInboxMessages(runtime.agentId, {
      channels: Array.from(resolved.allowed),
      maxResults: cacheReadLimitFor(resolved),
      gmailAccountId: resolved.gmailAccountId,
    });
    if (resolved.cacheMode === "cache-only") {
      return buildFromCache(cached, await probeStatuses());
    }
    if (resolved.cacheMode !== "refresh" && isFreshCache(cached)) {
      return buildFromCache(cached, await probeStatuses());
    }

    const { messages: inbound, sources: sourceStatuses } =
      await fetchAllMessages(runtime, {
        sources: Array.from(resolved.allowed),
        limit: cacheWarmLimitFor(resolved),
        includeGmail: resolved.allowed.has("gmail"),
        gmailSource: sources,
        xDmSource: sources,
        gmailGrantId: resolved.gmailAccountId,
      });
    await cache.upsertCachedInboxMessages(
      runtime.agentId,
      toInboxMessages(inbound),
    );
    const inbox = await buildInboxWithLlm(
      runtime,
      inbound,
      resolved,
      sourceStatuses,
      loadPriorityScoringSettings,
    );
    await cache.upsertCachedInboxMessages(
      runtime.agentId,
      flattenInboxMessages(inbox),
    );
    return inbox;
  }

  /**
   * Mark a cached inbox entry read. Returns `null` when no entry matches —
   * the host maps that to its transport error (PA raises HTTP 404).
   */
  markInboxEntryRead(
    inboxEntryId: string,
  ): Promise<LifeOpsInboxMessage | null> {
    return this.deps.cache.markCachedInboxMessageRead(
      this.deps.runtime.agentId,
      inboxEntryId,
    );
  }
}
