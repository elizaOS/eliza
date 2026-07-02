/**
 * BirdclawView — the single GUI/XR/TUI data wrapper for the Birdclaw archive
 * browser.
 *
 * It owns the live data (the `/api/birdclaw/*` fetches, the tab selection,
 * the sync flow, and the loading/setup/error/empty/ready state machine) and
 * renders the one presentational {@link BirdclawSpatialView} — the same
 * component every surface draws.
 *
 * Data source (the plugin's own routes; the service owns the CLI):
 *   GET  {base}/api/birdclaw/status
 *   GET  {base}/api/birdclaw/tweets?resource=&liked=&bookmarked=&limit=
 *   GET  {base}/api/birdclaw/inbox?kind=&limit=
 *   POST {base}/api/birdclaw/sync {collection}
 *
 * The default fetchers build URLs from `client.getBaseUrl()`; tests inject the
 * fetcher seam so they stay offline. There is no background poll: the archive
 * only changes when a sync or import runs, so the view refreshes after its own
 * syncs and on tab changes instead of burning a poll loop.
 */

// The narrow host-external subpath (DynamicViewLoader serves it at runtime
// exactly like the barrel) — importing the full `@elizaos/ui` barrel here
// would drag every chat widget into the jsdom test graph for one singleton.
import { client } from "@elizaos/ui/api";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BirdclawInboxItem,
  BirdclawStatusInfo,
  BirdclawSyncCollection,
  BirdclawTweet,
} from "../../types.ts";
import {
  BIRDCLAW_TABS,
  type BirdclawRow,
  type BirdclawSnapshot,
  BirdclawSpatialView,
  type BirdclawTabId,
} from "./BirdclawSpatialView.tsx";

// ---------------------------------------------------------------------------
// Fetcher seam — default to real GETs; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface BirdclawFetchers {
  fetchStatus: () => Promise<BirdclawStatusInfo>;
  fetchTweets: (params: {
    resource: "home" | "mentions" | "authored";
    liked?: boolean;
    bookmarked?: boolean;
    limit?: number;
  }) => Promise<BirdclawTweet[]>;
  fetchInbox: (params: {
    kind: "mixed" | "mentions" | "dms";
  }) => Promise<BirdclawInboxItem[]>;
  triggerSync: (collection: BirdclawSyncCollection) => Promise<void>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${client.getBaseUrl()}${path}`, init);
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  if (payload === null) throw new Error("Empty response");
  return payload as T;
}

const defaultFetchers: BirdclawFetchers = {
  fetchStatus: async () =>
    (await requestJson<{ status: BirdclawStatusInfo }>("/api/birdclaw/status"))
      .status,
  fetchTweets: async (params) => {
    const search = new URLSearchParams({ resource: params.resource });
    if (params.liked) search.set("liked", "1");
    if (params.bookmarked) search.set("bookmarked", "1");
    if (params.limit) search.set("limit", String(params.limit));
    const payload = await requestJson<{ tweets: BirdclawTweet[] }>(
      `/api/birdclaw/tweets?${search.toString()}`,
    );
    return payload.tweets;
  },
  fetchInbox: async (params) => {
    const payload = await requestJson<{ items: BirdclawInboxItem[] }>(
      `/api/birdclaw/inbox?kind=${params.kind}`,
    );
    return payload.items;
  },
  triggerSync: async (collection) => {
    await requestJson<{ result: unknown }>("/api/birdclaw/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection }),
    });
  },
};

/** Single chat-handoff seam: deeper follow-ups live in the floating chat. */
function sendChatPrompt(prompt: string): void {
  (client as { sendChatMessage?: (text: string) => void }).sendChatMessage?.(
    prompt,
  );
}

// ---------------------------------------------------------------------------
// Tab → query mapping.
// ---------------------------------------------------------------------------

const TAB_SYNC_COLLECTION: Partial<
  Record<BirdclawTabId, BirdclawSyncCollection>
> = {
  home: "timeline",
  mentions: "mentions",
  authored: "authored",
  likes: "likes",
  bookmarks: "bookmarks",
};

function tweetToRow(tweet: BirdclawTweet): BirdclawRow {
  const marks = [
    tweet.likeCount !== null ? `♥${tweet.likeCount}` : null,
    tweet.liked ? "liked" : null,
    tweet.bookmarked ? "bookmarked" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: tweet.id,
    title: tweet.authorHandle
      ? `@${tweet.authorHandle}`
      : (tweet.authorName ?? "unknown"),
    body: tweet.text,
    meta: marks,
    time: tweet.createdAt,
    accent: tweet.kind === "mention" && tweet.isReplied === false,
  };
}

function inboxItemToRow(item: BirdclawInboxItem): BirdclawRow {
  return {
    id: item.id,
    title: item.participantHandle ? `@${item.participantHandle}` : item.title,
    body: item.text,
    meta: [
      item.kind,
      item.needsReply ? "needs reply" : null,
      item.score !== null ? `score ${item.score}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    time: item.createdAt,
    accent: item.needsReply,
  };
}

function needsReplyNudge(rows: readonly BirdclawRow[]): string | null {
  const needing = rows.reduce((n, row) => (row.accent ? n + 1 : n), 0);
  if (needing === 0) return null;
  return `${needing} item${needing === 1 ? " still needs" : "s still need"} a reply.`;
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

interface ReadyData {
  rows: BirdclawRow[];
  status: BirdclawStatusInfo;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "setup"; hint: string | null }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ReadyData };

export interface BirdclawViewProps {
  /** Test/host injection seam. Defaults to the real `/api/birdclaw/*` calls. */
  fetchers?: BirdclawFetchers;
}

async function loadTab(
  fetchers: BirdclawFetchers,
  tab: BirdclawTabId,
): Promise<BirdclawRow[]> {
  if (tab === "inbox") {
    const items = await fetchers.fetchInbox({ kind: "mixed" });
    return items.map(inboxItemToRow);
  }
  if (tab === "likes" || tab === "bookmarks") {
    const tweets = await fetchers.fetchTweets({
      resource: "home",
      liked: tab === "likes",
      bookmarked: tab === "bookmarks",
    });
    return tweets.map(tweetToRow);
  }
  const tweets = await fetchers.fetchTweets({ resource: tab });
  return tweets.map(tweetToRow);
}

export function BirdclawView(props: BirdclawViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeTab, setActiveTab] = useState<BirdclawTabId>("home");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  // `background` refreshes the already-rendered list in place (post-sync);
  // user-driven loads (mount, tab switch, retry) show the loading state.
  const load = useCallback((tab: BirdclawTabId, background = false) => {
    let cancelled = false;
    if (!background) setState({ kind: "loading" });
    (async () => {
      const status = await fetchersRef.current.fetchStatus();
      if (!status.installed) {
        return {
          kind: "setup" as const,
          hint: status.message,
        };
      }
      const rows = await loadTab(fetchersRef.current, tab);
      return { kind: "ready" as const, data: { rows, status } };
    })()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load the birdclaw archive.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSyncError(null);
    return load(activeTab);
  }, [load, activeTab]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("tab:")) {
        const tab = action.slice("tab:".length);
        if (BIRDCLAW_TABS.some((candidate) => candidate.id === tab)) {
          setActiveTab(tab as BirdclawTabId);
        }
        return;
      }
      if (action.startsWith("open:")) {
        const id = action.slice("open:".length);
        const row =
          state.kind === "ready"
            ? state.data.rows.find((candidate) => candidate.id === id)
            : undefined;
        if (row) {
          sendChatPrompt(
            `In my birdclaw Twitter archive, find the context around ${row.title}'s post: "${row.body.slice(0, 140)}" and summarize the conversation.`,
          );
        }
        return;
      }
      if (action === "retry") {
        load(activeTab);
        return;
      }
      if (action === "sync") {
        const collection = TAB_SYNC_COLLECTION[activeTab];
        if (!collection || syncing) return;
        setSyncing(true);
        setSyncError(null);
        fetchersRef.current
          .triggerSync(collection)
          .then(() => load(activeTab, true))
          .catch((error: unknown) => {
            setSyncError(
              error instanceof Error ? error.message : "Sync failed.",
            );
          })
          .finally(() => setSyncing(false));
      }
    },
    [state, activeTab, load, syncing],
  );

  const snapshot: BirdclawSnapshot = useMemo(() => {
    const tabs = BIRDCLAW_TABS.map((tab) => ({
      id: tab.id,
      label: tab.label,
      active: tab.id === activeTab,
    }));
    if (state.kind === "loading") {
      return {
        status: "loading",
        tabs,
        rows: [],
        transportText: null,
        syncing: false,
        canSync: false,
        nudge: null,
        error: null,
        setupHint: null,
      };
    }
    if (state.kind === "setup") {
      return {
        status: "setup",
        tabs,
        rows: [],
        transportText: null,
        syncing: false,
        canSync: false,
        nudge: null,
        error: null,
        setupHint: state.hint,
      };
    }
    if (state.kind === "error") {
      return {
        status: "error",
        tabs,
        rows: [],
        transportText: null,
        syncing: false,
        canSync: false,
        nudge: null,
        error: state.message,
        setupHint: null,
      };
    }
    const transport = state.data.status.transport;
    const transportText = syncError ?? transport?.statusText ?? null;
    return {
      status: state.data.rows.length === 0 ? "empty" : "ready",
      tabs,
      rows: state.data.rows,
      transportText,
      syncing,
      canSync: Boolean(
        transport?.installed && TAB_SYNC_COLLECTION[activeTab] !== undefined,
      ),
      nudge: needsReplyNudge(state.data.rows),
      error: null,
      setupHint: null,
    };
  }, [state, activeTab, syncing, syncError]);

  return <BirdclawSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default BirdclawView;
