/**
 * useUnifiedInbox — fetches and filters the LifeOps unified inbox.
 *
 * Wraps client.getLifeOpsGmailTriage() for the owner Google account and
 * surfaces normalised messages. When Stream C lands and adds
 * client.getLifeOpsUnifiedInbox(), the fetcher below should be swapped in.
 *
 * TODO: replace fetcher with client.getLifeOpsUnifiedInbox() when Stream C
 * contract lands.
 */

import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useMemo, useState } from "react";

export type InboxChannel = "all" | "gmail";

export interface UseUnifiedInboxOptions {
  maxResults?: number;
  channel?: InboxChannel;
  searchQuery?: string;
}

export interface UseUnifiedInboxResult {
  messages: LifeOpsGmailMessageSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Active channel filter */
  channel: InboxChannel;
  setChannel: (ch: InboxChannel) => void;
  /** Live search query string */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
}

const DEFAULT_MAX_RESULTS = 40;

export function useUnifiedInbox(
  opts: UseUnifiedInboxOptions = {},
): UseUnifiedInboxResult {
  const { t } = useApp();
  const [feed, setFeed] = useState<LifeOpsGmailTriageFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<InboxChannel>(opts.channel ?? "all");
  const [searchQuery, setSearchQuery] = useState(opts.searchQuery ?? "");

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // TODO: replace with client.getLifeOpsUnifiedInbox() when Stream C lands.
      const result = await client.getLifeOpsGmailTriage({
        side: "owner",
        maxResults: opts.maxResults ?? DEFAULT_MAX_RESULTS,
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
  }, [opts.maxResults, t]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const messages = useMemo<LifeOpsGmailMessageSummary[]>(() => {
    const base = feed?.messages ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return base;
    }
    return base.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q),
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
