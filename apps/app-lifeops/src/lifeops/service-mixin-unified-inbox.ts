// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { IAgentRuntime } from "@elizaos/core";
import type {
  GetLifeOpsUnifiedInboxRequest,
  LifeOpsInboxChannel,
  LifeOpsUnifiedInbox,
  LifeOpsUnifiedInboxChannelCount,
  LifeOpsUnifiedMessage,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_INBOX_CHANNELS } from "@elizaos/shared/contracts/lifeops";
import { fetchAllMessages } from "../inbox/message-fetcher.js";
import type { InboundMessage } from "../inbox/types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

const DEFAULT_UNIFIED_INBOX_LIMIT = 100;
const INBOX_CHANNEL_SET = new Set<LifeOpsInboxChannel>(LIFEOPS_INBOX_CHANNELS);

export function normalizeUnifiedInboxChannel(
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
  LifeOpsUnifiedInboxChannelCount
> {
  const counts = {} as Record<
    LifeOpsInboxChannel,
    LifeOpsUnifiedInboxChannelCount
  >;
  for (const channel of LIFEOPS_INBOX_CHANNELS) {
    counts[channel] = { total: 0, unread: 0 };
  }
  return counts;
}

export function toUnifiedInboxMessage(
  message: InboundMessage,
  channel: LifeOpsInboxChannel,
  index: number,
): LifeOpsUnifiedMessage {
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
  // unread so the unified inbox surfaces them for triage.
  const unread =
    channel === "gmail"
      ? Boolean(
          message.gmailLikelyReplyNeeded === true ||
            message.gmailIsImportant === true,
        )
      : true;

  return {
    id: `${channel}:${externalId || `${message.timestamp}-${index}`}`,
    channel,
    sender: {
      id: senderId ?? `${channel}-${index}`,
      displayName: message.senderName || "Unknown",
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
  };
}

export function buildUnifiedInbox(
  inbound: InboundMessage[],
  options: {
    limit: number;
    allowed: Set<LifeOpsInboxChannel>;
  },
): LifeOpsUnifiedInbox {
  const unified: LifeOpsUnifiedMessage[] = [];
  const counts = emptyChannelCounts();

  let index = 0;
  for (const message of inbound) {
    const channel = normalizeUnifiedInboxChannel(message.source);
    index += 1;
    if (!channel || !options.allowed.has(channel)) {
      continue;
    }
    const normalized = toUnifiedInboxMessage(message, channel, index - 1);
    unified.push(normalized);
    const channelCount = counts[channel];
    channelCount.total += 1;
    if (normalized.unread) {
      channelCount.unread += 1;
    }
  }

  unified.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));

  const trimmed =
    unified.length > options.limit ? unified.slice(0, options.limit) : unified;

  return {
    messages: trimmed,
    channelCounts: counts,
    fetchedAt: new Date().toISOString(),
  };
}

export function resolveUnifiedInboxRequest(
  request: GetLifeOpsUnifiedInboxRequest,
): { limit: number; allowed: Set<LifeOpsInboxChannel> } {
  const limit =
    typeof request.limit === "number" &&
    Number.isFinite(request.limit) &&
    request.limit > 0
      ? Math.min(Math.floor(request.limit), 500)
      : DEFAULT_UNIFIED_INBOX_LIMIT;
  const requestedChannels =
    request.channels && request.channels.length > 0
      ? (request.channels.filter((channel) =>
          INBOX_CHANNEL_SET.has(channel),
        ) as LifeOpsInboxChannel[])
      : [...LIFEOPS_INBOX_CHANNELS];
  return { limit, allowed: new Set<LifeOpsInboxChannel>(requestedChannels) };
}

export async function fetchUnifiedInbox(
  runtime: IAgentRuntime,
  request: GetLifeOpsUnifiedInboxRequest = {},
): Promise<LifeOpsUnifiedInbox> {
  const { limit, allowed } = resolveUnifiedInboxRequest(request);
  const inbound = await fetchAllMessages(runtime, {
    sources: Array.from(allowed),
    limit,
    includeGmail: allowed.has("gmail"),
  });
  return buildUnifiedInbox(inbound, { limit, allowed });
}

/** @internal */
export function withUnifiedInbox<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsUnifiedInboxServiceMixin extends Base {
    async getUnifiedInbox(
      request: GetLifeOpsUnifiedInboxRequest = {},
    ): Promise<LifeOpsUnifiedInbox> {
      return fetchUnifiedInbox(this.runtime, request);
    }
  }

  return LifeOpsUnifiedInboxServiceMixin;
}
