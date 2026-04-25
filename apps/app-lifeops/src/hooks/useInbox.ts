import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsInbox,
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useMemo, useState } from "react";

export type InboxChannel = "all" | LifeOpsInboxChannel;

export interface UseInboxOptions {
  maxResults?: number;
  channel?: InboxChannel;
  channels?: readonly LifeOpsInboxChannel[];
  searchQuery?: string;
}

export interface UseInboxResult {
  messages: LifeOpsInboxMessage[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  channel: InboxChannel;
  setChannel: (ch: InboxChannel) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
}

const DEFAULT_MAX_RESULTS = 40;

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
  }, [channel, opts.channels, opts.maxResults, t]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const messages = useMemo<LifeOpsInboxMessage[]>(() => {
    const base = feed?.messages ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return base;
    }
    return base.filter(
      (m) =>
        (m.subject ?? "").toLowerCase().includes(q) ||
        m.sender.displayName.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q) ||
        m.channel.toLowerCase().includes(q),
    );
  }, [feed, searchQuery]);

  return {
    messages,
    loading,
    error,
    refresh: fetch,
    channel,
    setChannel,
    searchQuery,
    setSearchQuery,
  };
}
