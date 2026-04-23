import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsInboxChannel,
  LifeOpsUnifiedInbox,
  LifeOpsUnifiedMessage,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useMemo, useState } from "react";

export type InboxChannel = "all" | LifeOpsInboxChannel;

export interface UseUnifiedInboxOptions {
  maxResults?: number;
  channel?: InboxChannel;
  channels?: readonly LifeOpsInboxChannel[];
  searchQuery?: string;
}

export interface UseUnifiedInboxResult {
  messages: LifeOpsUnifiedMessage[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  channel: InboxChannel;
  setChannel: (ch: InboxChannel) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
}

const DEFAULT_MAX_RESULTS = 40;

export function useUnifiedInbox(
  opts: UseUnifiedInboxOptions = {},
): UseUnifiedInboxResult {
  const { t } = useApp();
  const [feed, setFeed] = useState<LifeOpsUnifiedInbox | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<InboxChannel>(opts.channel ?? "all");
  const [searchQuery, setSearchQuery] = useState(opts.searchQuery ?? "");

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
      const result = await client.getLifeOpsUnifiedInbox({
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

  const messages = useMemo<LifeOpsUnifiedMessage[]>(() => {
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
