// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { IAgentRuntime } from "@elizaos/core";
import type {
  GetLifeOpsInboxRequest,
  LifeOpsInboxChannel,
  LifeOpsInbox,
  LifeOpsInboxChannelCount,
  LifeOpsInboxMessage,
  LifeOpsInboxThreadGroup,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_INBOX_CHANNELS } from "@elizaos/shared/contracts/lifeops";
import {
  fetchAllMessages,
  type GmailInboxSource,
  type XDmInboxSource,
} from "../inbox/message-fetcher.js";
import type { InboundMessage } from "../inbox/types.js";
import { loadLifeOpsAppState } from "./app-state.js";
import {
  type PriorityCategory,
  type PriorityScore,
  scoreInboxMessages,
} from "./priority-scoring.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

const DEFAULT_INBOX_LIMIT = 100;
const INBOX_CHANNEL_SET = new Set<LifeOpsInboxChannel>(LIFEOPS_INBOX_CHANNELS);
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

function emptyChannelCounts(): Record<
  LifeOpsInboxChannel,
  LifeOpsInboxChannelCount
> {
  const counts = {} as Record<
    LifeOpsInboxChannel,
    LifeOpsInboxChannelCount
  >;
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
    const subject = (message.channelName ?? "")
      .replace(/^Email from\s+/i, "")
      .replace(SUBJECT_REPLY_PREFIX, "")
      .trim();
    const fromKey = message.senderEmail?.trim().toLowerCase() ?? message.senderName;
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
      ? message.channelName?.startsWith("Email from ")
        ? message.channelName.slice("Email from ".length)
        : (message.channelName ?? null)
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

  const threadId = deriveThreadId(message, channel, externalId ?? message.id);
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
      id: senderId ?? `${channel}-${index}`,
      displayName: message.senderName || "Unknown",
      email: message.senderEmail?.trim().toLowerCase() || null,
      avatarUrl: null,
    },
    subject,
    snippet: message.snippet ?? "",
    receivedAt,
    unread,
    deepLink: message.deepLink ?? null,
    sourceRef: {
      channel,
      externalId: externalId ?? message.id,
    },
    threadId,
    chatType,
    participantCount: message.participantCount,
    gmailAccountId: message.gmailAccountId,
    gmailAccountEmail: message.gmailAccountEmail,
  };
}

interface InboxBuildOptions {
  limit: number;
  allowed: Set<LifeOpsInboxChannel>;
  groupByThread?: boolean;
  chatTypeFilter?: ReadonlyArray<InboxChatType>;
  maxParticipants?: number;
  gmailAccountId?: string;
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

/**
 * Compute a v1 small-group importance score for a thread group. Used as the
 * fallback path when LLM priority scoring is disabled or fails. Returns a
 * number in [0, 100].
 */
function scoreSmallGroupThread(
  members: LifeOpsInboxMessage[],
  ownerNameLower: string | null,
  isMostRecentGroupActivity: boolean,
): number {
  let score = 0;
  let mentionsOwner = false;
  let hasQuestion = false;
  let hasDateLike = false;
  for (const member of members) {
    const text = `${member.subject ?? ""} ${member.snippet ?? ""}`;
    if (!mentionsOwner) {
      if (
        ownerNameLower &&
        ownerNameLower.length > 0 &&
        text.toLowerCase().includes(ownerNameLower)
      ) {
        mentionsOwner = true;
      } else if (/@me\b/i.test(text)) {
        mentionsOwner = true;
      }
    }
    if (!hasQuestion && text.includes("?")) {
      hasQuestion = true;
    }
    if (!hasDateLike) {
      // Catches "3pm", "3:30", "tomorrow", "Mon"-"Sun", "Jan-Dec".
      if (
        /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)\b/i.test(text) ||
        /\b(?:tomorrow|tonight|today|tmr|tmrw)\b/i.test(text) ||
        /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i.test(text) ||
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(
          text,
        )
      ) {
        hasDateLike = true;
      }
    }
  }
  if (mentionsOwner) score += 30;
  if (hasQuestion) score += 20;
  if (hasDateLike) score += 15;
  if (isMostRecentGroupActivity) score += 10;
  return Math.min(score, 100);
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
  ownerName: string | null,
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

  // Identify the group thread with the most-recent activity to award the
  // "most-recent group activity" heuristic point in the fallback path.
  let mostRecentGroupKey: string | null = null;
  let mostRecentGroupTs = -Infinity;
  for (const [key, members] of buckets) {
    const latest = members[0];
    if (!latest || latest.chatType !== "group") continue;
    const ts = Date.parse(latest.receivedAt);
    if (Number.isFinite(ts) && ts > mostRecentGroupTs) {
      mostRecentGroupTs = ts;
      mostRecentGroupKey = key;
    }
  }

  const ownerNameLower =
    typeof ownerName === "string" && ownerName.trim().length > 0
      ? ownerName.trim().toLowerCase()
      : null;

  const groups: LifeOpsInboxThreadGroup[] = [];
  for (const [key, members] of buckets) {
    members.sort(
      (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
    );
    const latestMessage = members[0];
    if (!latestMessage) continue;
    const totalCount = members.length;
    const unreadCount = members.filter((m) => m.unread).length;
    const participantCount = members.find(
      (m) => typeof m.participantCount === "number",
    )?.participantCount;

    let priorityScores = members
      .map((m) => m.priorityScore)
      .filter((value): value is number => typeof value === "number");

    // Determine the dominant category from the LLM scoring when available.
    let priorityCategory: PriorityCategory | undefined;
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

    // Fallback: only run the v1 heuristic for small groups when the LLM
    // produced nothing for the latest message.
    const latestHasLlmScore = llmScores?.has(latestMessage.id) === true;
    if (
      !latestHasLlmScore &&
      latestMessage.chatType === "group" &&
      typeof participantCount === "number" &&
      participantCount <= 15
    ) {
      const heuristicScore = scoreSmallGroupThread(
        members,
        ownerNameLower,
        key === mostRecentGroupKey,
      );
      if (heuristicScore > 0) {
        latestMessage.priorityScore = Math.max(
          latestMessage.priorityScore ?? 0,
          heuristicScore,
        );
        priorityScores = [...priorityScores, heuristicScore];
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

export function buildInbox(
  inbound: InboundMessage[],
  options: InboxBuildOptions,
): LifeOpsInbox {
  const collected: LifeOpsInboxMessage[] = [];
  const counts = emptyChannelCounts();
  const chatTypeFilter =
    options.chatTypeFilter && options.chatTypeFilter.length > 0
      ? new Set(options.chatTypeFilter)
      : null;

  let index = 0;
  for (const message of inbound) {
    const channel = normalizeInboxChannel(message.source);
    index += 1;
    if (!channel || !options.allowed.has(channel)) {
      continue;
    }
    const normalized = toInboxMessage(message, channel, index - 1);

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
      options.ownerName ?? null,
      options.llmScores,
      options.sortByPriority === true,
    );
  }

  if (options.missedOnly === true) {
    const nowMs = Date.now();
    messages = messages.filter((m) => isMissedMessage(m, nowMs));
    if (threadGroups) {
      threadGroups = threadGroups.filter((g) =>
        isMissedMessage(g.latestMessage, nowMs),
      );
    }
  }

  const inbox: LifeOpsInbox = {
    messages,
    channelCounts: counts,
    fetchedAt: new Date().toISOString(),
  };

  if (threadGroups) {
    inbox.threadGroups = threadGroups;
  }

  return inbox;
}

export interface ResolvedInboxRequest {
  limit: number;
  allowed: Set<LifeOpsInboxChannel>;
  groupByThread: boolean;
  chatTypeFilter?: ReadonlyArray<InboxChatType>;
  maxParticipants?: number;
  gmailAccountId?: string;
  missedOnly: boolean;
  sortByPriority: boolean;
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
      ? (request.chatTypeFilter.filter((value) =>
          value === "dm" || value === "group" || value === "channel",
        ) as InboxChatType[])
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
    missedOnly: request.missedOnly === true,
    sortByPriority: request.sortByPriority === true,
  };
}

function resolveOwnerName(runtime: IAgentRuntime): string | null {
  const name = runtime.character?.name;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : null;
}

async function loadPriorityScoringSettings(
  runtime: IAgentRuntime,
): Promise<{ enabled: boolean; model: string | null }> {
  try {
    const state = await loadLifeOpsAppState(runtime);
    return {
      enabled: state.priorityScoring.enabled === true,
      model: state.priorityScoring.model ?? null,
    };
  } catch {
    // The route handler validates the cached blob and surfaces errors there;
    // here we just silently default to "enabled, no model override" so
    // unrelated state corruption never blocks the inbox.
    return { enabled: true, model: null };
  }
}

async function computeLlmScores(
  runtime: IAgentRuntime,
  messages: LifeOpsInboxMessage[],
  ownerName: string | null,
): Promise<Map<string, PriorityScore>> {
  const out = new Map<string, PriorityScore>();
  if (messages.length === 0) return out;
  const settings = await loadPriorityScoringSettings(runtime);
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
): Promise<LifeOpsInbox> {
  const ownerName = resolveOwnerName(runtime);
  // First pass: trim and filter without LLM scoring or grouping. We still
  // honor the chatType / participant / gmail filters here because LLM scoring
  // should only run on messages the user will actually see.
  const initial = buildInbox(inbound, {
    limit: resolved.limit,
    allowed: resolved.allowed,
    chatTypeFilter: resolved.chatTypeFilter,
    maxParticipants: resolved.maxParticipants,
    gmailAccountId: resolved.gmailAccountId,
    ownerName,
    // groupByThread/missedOnly are deferred to the second pass so we can
    // factor in LLM scores before grouping/filtering.
    groupByThread: false,
  });

  const llmScores = await computeLlmScores(
    runtime,
    initial.messages,
    ownerName,
  );

  // Second pass: re-build with the LLM scores so thread grouping picks them
  // up and missedOnly can filter on score >= 50.
  return buildInbox(inbound, {
    limit: resolved.limit,
    allowed: resolved.allowed,
    chatTypeFilter: resolved.chatTypeFilter,
    maxParticipants: resolved.maxParticipants,
    gmailAccountId: resolved.gmailAccountId,
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
): Promise<LifeOpsInbox> {
  const resolved = resolveInboxRequest(request);
  const inbound = await fetchAllMessages(runtime, {
    sources: Array.from(resolved.allowed),
    limit: resolved.limit,
    includeGmail: resolved.allowed.has("gmail"),
    gmailSource,
    xDmSource,
    gmailGrantId: resolved.gmailAccountId,
  });
  return buildInboxWithLlm(runtime, inbound, resolved);
}

/** @internal */
export function withInbox<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsInboxServiceMixin extends Base {
    async getInbox(
      request: GetLifeOpsInboxRequest = {},
    ): Promise<LifeOpsInbox> {
      const resolved = resolveInboxRequest(request);
      const inbound = await fetchAllMessages(this.runtime, {
        sources: Array.from(resolved.allowed),
        limit: resolved.limit,
        includeGmail: resolved.allowed.has("gmail"),
        gmailSource: this,
        xDmSource: this,
        gmailGrantId: resolved.gmailAccountId,
      });
      return buildInboxWithLlm(this.runtime, inbound, resolved);
    }
  }

  return LifeOpsInboxServiceMixin;
}
