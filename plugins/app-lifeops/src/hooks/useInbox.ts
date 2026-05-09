import { client, useApp } from "@elizaos/ui";
import type {
  LifeOpsInbox,
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
  LifeOpsInboxThreadGroup,
} from "@elizaos/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

export type InboxChannel = "all" | LifeOpsInboxChannel;
export type InboxChatType = "dm" | "group" | "channel";

export interface UseInboxOptions {
  maxResults?: number;
  channel?: InboxChannel;
  channels?: readonly LifeOpsInboxChannel[];
  searchQuery?: string;
  /** When true, request `threadGroups` from the backend. */
  groupByThread?: boolean;
  /** Server-side chatType filter (DM / small group / channel). */
  chatTypeFilter?: ReadonlyArray<InboxChatType>;
  /** Server-side cap on group participants. */
  maxParticipants?: number;
  /** Filter Gmail to a specific Google grant. */
  gmailAccountId?: string;
  /** Only return threads that have gone unreplied for >24h with priority >=50. */
  missedOnly?: boolean;
  /** Sort thread groups by priority desc with recency tiebreaker. */
  sortByPriority?: boolean;
}

export interface UseInboxResult {
  messages: LifeOpsInboxMessage[];
  threadGroups: LifeOpsInboxThreadGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  channel: InboxChannel;
  setChannel: (ch: InboxChannel) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
}

const DEFAULT_MAX_RESULTS = 40;

function matchesQuery(message: LifeOpsInboxMessage, q: string): boolean {
  return (
    (message.subject ?? "").toLowerCase().includes(q) ||
    message.sender.displayName.toLowerCase().includes(q) ||
    message.snippet.toLowerCase().includes(q) ||
    message.channel.toLowerCase().includes(q)
  );
}

function threadGroupMatchesQuery(
  group: LifeOpsInboxThreadGroup,
  q: string,
): boolean {
  if (matchesQuery(group.latestMessage, q)) {
    return true;
  }
  return (group.messages ?? []).some((message) => matchesQuery(message, q));
}

export function useInbox(opts: UseInboxOptions = {}): UseInboxResult {
  const { t } = useApp();
  const [feed, setFeed] = useState<LifeOpsInbox | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<InboxChannel>(opts.channel ?? "all");
  const [searchQuery, setSearchQuery] = useState(opts.searchQuery ?? "");

  useEffect(() => {
    setChannel(opts.channel ?? "all");
  }, [opts.channel]);

  const chatTypeFilterKey = opts.chatTypeFilter
    ? opts.chatTypeFilter.join(",")
    : "";
  const chatTypeFilter = useMemo<InboxChatType[] | undefined>(
    () =>
      chatTypeFilterKey
        ? (chatTypeFilterKey.split(",") as InboxChatType[])
        : undefined,
    [chatTypeFilterKey],
  );

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const selectedChannels =
        channel === "all"
          ? opts.channels
            ? [...opts.channels]
            : undefined
          : [channel as LifeOpsInboxChannel];
      const result = await client.getLifeOpsInbox({
        limit: opts.maxResults ?? DEFAULT_MAX_RESULTS,
        channels: selectedChannels,
        groupByThread: opts.groupByThread,
        chatTypeFilter,
        maxParticipants: opts.maxParticipants,
        gmailAccountId: opts.gmailAccountId,
        missedOnly: opts.missedOnly,
        sortByPriority: opts.sortByPriority,
      });
      setFeed(result);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsInbox.loadFailed", {
              defaultValue: "Inbox failed to load.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [
    channel,
    opts.channels,
    opts.maxResults,
    opts.groupByThread,
    chatTypeFilter,
    opts.maxParticipants,
    opts.gmailAccountId,
    opts.missedOnly,
    opts.sortByPriority,
    t,
  ]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const messages = useMemo<LifeOpsInboxMessage[]>(() => {
    const base = feed?.messages ?? [];
    const q = searchQuery.trim().toLowerCase();
    return q ? base.filter((m) => matchesQuery(m, q)) : base;
  }, [feed, searchQuery]);

  const threadGroups = useMemo<LifeOpsInboxThreadGroup[]>(() => {
    const base = feed?.threadGroups ?? [];
    const q = searchQuery.trim().toLowerCase();
    return q ? base.filter((g) => threadGroupMatchesQuery(g, q)) : base;
  }, [feed, searchQuery]);

  return {
    messages,
    threadGroups,
    loading,
    error,
    refresh: fetch,
    channel,
    setChannel,
    searchQuery,
    setSearchQuery,
  };
}
