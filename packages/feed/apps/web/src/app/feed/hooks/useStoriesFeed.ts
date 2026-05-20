import type { NarrativeStory } from '@feed/shared';
import { logger } from '@feed/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useSSEChannel } from '@/hooks/useSSE';

interface UseStoriesFeedOptions {
  enabled?: boolean;
}

export interface StoriesTopic {
  topicKey: string;
  topicLabel: string;
  summary: string;
}

export interface UseStoriesFeedResult {
  topic: StoriesTopic | null;
  stories: NarrativeStory[];
  ready: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loadMore: () => void;
}

const PAGE_SIZE = 20;
const ENDPOINT = '/api/feed/stories';
const SSE_DEBOUNCE_MS = 2_000;
const LOG_CTX = 'useStoriesFeed';

interface StoriesFeedPageResponse {
  success?: boolean;
  topic?: StoriesTopic | null;
  stories?: NarrativeStory[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

export function useStoriesFeed(
  options: UseStoriesFeedOptions = {}
): UseStoriesFeedResult {
  const { enabled = true } = options;
  const { authenticated, getAccessToken } = useAuth();

  const [topic, setTopic] = useState<StoriesTopic | null>(null);
  const [stories, setStories] = useState<NarrativeStory[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storiesRef = useRef<NarrativeStory[]>([]);
  const isMountedRef = useRef(false);
  const hasFetched = useRef(false);
  const sseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(false);
  // Opaque cursor from the server encoding {score, storyKey} position.
  // null means "start from the beginning" (first page).
  const cursorRef = useRef<string | null>(null);

  const syncHasMore = useCallback((value: boolean) => {
    hasMoreRef.current = value;
    setHasMore(value);
  }, []);

  const buildHeaders = useCallback(async (): Promise<HeadersInit> => {
    if (!authenticated) return {};
    const token = await getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [authenticated, getAccessToken]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      signal: AbortSignal
    ): Promise<StoriesFeedPageResponse | null> => {
      const headers = await buildHeaders();
      const url = cursor
        ? `${ENDPOINT}?cursor=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`
        : `${ENDPOINT}?limit=${PAGE_SIZE}`;
      const response = await fetch(url, { signal, headers });
      if (signal.aborted) return null;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json() as Promise<StoriesFeedPageResponse>;
    },
    [buildHeaders]
  );

  const loadInitial = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      try {
        cursorRef.current = null;
        const data = await fetchPage(null, signal);
        if (!data || signal.aborted) return;
        const items = data.stories ?? [];
        storiesRef.current = items;
        cursorRef.current = data.nextCursor ?? null;
        setStories(items);
        setTopic(data.topic ?? null);
        syncHasMore(data.hasMore ?? false);
        setError(null);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const msg = 'Failed to load Stories feed';
        logger.error(msg, { error: err }, LOG_CTX);
        if (storiesRef.current.length === 0) setError(msg);
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setReady(true);
        }
      }
    },
    [fetchPage, syncHasMore]
  );

  const refresh = useCallback(async () => {
    abortControllerRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    loadingMoreRef.current = false;
    cursorRef.current = null;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    await loadInitial(controller.signal);
  }, [loadInitial]);

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    // Read cursor from ref (not state) so the value is always current even
    // when `loadMore` is called before the previous setState has committed.
    const cursor = cursorRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);

    void fetchPage(cursor, controller.signal)
      .then((data) => {
        if (!data || controller.signal.aborted) return;
        const next = data.stories ?? [];
        cursorRef.current = data.nextCursor ?? null;
        const merged = [...storiesRef.current, ...next];
        storiesRef.current = merged;
        setStories(merged);
        syncHasMore(data.hasMore ?? false);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        logger.error('Failed to load more Stories', { error: err }, LOG_CTX);
      })
      .finally(() => {
        loadingMoreRef.current = false;
        if (!controller.signal.aborted && isMountedRef.current) {
          setLoadingMore(false);
        }
      });
  }, [fetchPage, syncHasMore]);

  useSSEChannel(
    enabled ? 'feed' : null,
    useCallback(() => {
      if (!isMountedRef.current) return;
      if (sseDebounceRef.current) clearTimeout(sseDebounceRef.current);
      sseDebounceRef.current = setTimeout(() => {
        if (isMountedRef.current) void refresh();
      }, SSE_DEBOUNCE_MS);
    }, [refresh])
  );

  useEffect(() => {
    if (!enabled) {
      hasFetched.current = false;
      setReady(false);
      setLoading(false);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
      loadingMoreRef.current = false;
      cursorRef.current = null;
      if (sseDebounceRef.current) {
        clearTimeout(sseDebounceRef.current);
        sseDebounceRef.current = null;
      }
      return;
    }

    isMountedRef.current = true;
    if (hasFetched.current) return;
    hasFetched.current = true;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    void loadInitial(controller.signal);

    return () => {
      hasFetched.current = false;
      isMountedRef.current = false;
      controller.abort();
      loadMoreAbortRef.current?.abort();
      if (sseDebounceRef.current) {
        clearTimeout(sseDebounceRef.current);
        sseDebounceRef.current = null;
      }
    };
  }, [enabled, loadInitial]);

  return {
    topic,
    stories,
    ready,
    loading,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
  };
}
