// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { IAgentRuntime } from "@elizaos/core";
import type {
  GetLifeOpsInboxRequest,
  LifeOpsInboxChannel,
  LifeOpsInbox,
  LifeOpsInboxChannelCount,
  LifeOpsInboxMessage,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_INBOX_CHANNELS } from "@elizaos/shared/contracts/lifeops";
import {
  fetchAllMessages,
  type GmailInboxSource,
  type XDmInboxSource,
} from "../inbox/message-fetcher.js";
import type { InboundMessage } from "../inbox/types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

const DEFAULT_INBOX_LIMIT = 100;
const INBOX_CHANNEL_SET = new Set<LifeOpsInboxChannel>(LIFEOPS_INBOX_CHANNELS);

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

export function buildInbox(
  inbound: InboundMessage[],
  options: {
    limit: number;
    allowed: Set<LifeOpsInboxChannel>;
  },
): LifeOpsInbox {
  const collected: LifeOpsInboxMessage[] = [];
  const counts = emptyChannelCounts();

  let index = 0;
  for (const message of inbound) {
    const channel = normalizeInboxChannel(message.source);
    index += 1;
    if (!channel || !options.allowed.has(channel)) {
      continue;
    }
    const normalized = toInboxMessage(message, channel, index - 1);
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

  return {
    messages: trimmed,
    channelCounts: counts,
    fetchedAt: new Date().toISOString(),
  };
}

export function resolveInboxRequest(
  request: GetLifeOpsInboxRequest,
): { limit: number; allowed: Set<LifeOpsInboxChannel> } {
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
  return { limit, allowed: new Set<LifeOpsInboxChannel>(requestedChannels) };
}

export async function fetchInbox(
  runtime: IAgentRuntime,
  request: GetLifeOpsInboxRequest = {},
  gmailSource?: GmailInboxSource,
  xDmSource?: XDmInboxSource,
): Promise<LifeOpsInbox> {
  const { limit, allowed } = resolveInboxRequest(request);
  const inbound = await fetchAllMessages(runtime, {
    sources: Array.from(allowed),
    limit,
    includeGmail: allowed.has("gmail"),
    gmailSource,
    xDmSource,
  });
  return buildInbox(inbound, { limit, allowed });
}

/** @internal */
export function withInbox<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsInboxServiceMixin extends Base {
    async getInbox(
      request: GetLifeOpsInboxRequest = {},
    ): Promise<LifeOpsInbox> {
      const { limit, allowed } = resolveInboxRequest(request);
      const inbound = await fetchAllMessages(this.runtime, {
        sources: Array.from(allowed),
        limit,
        includeGmail: allowed.has("gmail"),
        gmailSource: this,
        xDmSource: this,
      });
      return buildInbox(inbound, { limit, allowed });
    }
  }

  return LifeOpsInboxServiceMixin;
}
