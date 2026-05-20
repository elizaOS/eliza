import type { FeedPost } from "@feed/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSSEChannel } from "@/hooks/useSSE";
import { apiUrl } from "@/utils/api-url";

const PAGE_SIZE = 20;

interface UseFeedPostsOptions {
  enabled?: boolean;
}

interface UseFeedPostsResult {
  posts: FeedPost[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  cursor: string | null;
  fetchPosts: (cursor: string | null, append?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  addOptimisticPost: (post: FeedPost) => void;
}

/**
 * Hook for fetching and managing the latest posts feed
 *
 * Features:
 * - Cursor-based pagination (better for real-time feeds)
 * - SSE real-time updates
 * - Optimistic post support
 * - Race condition prevention
 */
export function useFeedPosts(
  options: UseFeedPostsOptions = {},
): UseFeedPostsResult {
  const { enabled = true } = options;

  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [localPosts, setLocalPosts] = useState<FeedPost[]>([]);
  // Start with loading=true when enabled to show skeleton immediately
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);

  // Prevent race conditions and duplicate fetches
  const loadingMoreRef = useRef(false);
  const initialFetchDone = useRef(false);
  const isMounted = useRef(true);

  // Track mount state to prevent state updates on unmounted component
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  const fetchPosts = useCallback(
    async (
      requestCursor: string | null,
      append = false,
      skipLoadingState = false,
      forceNoStore = false,
    ) => {
      if (append && loadingMoreRef.current) return;

      if (append) {
        setLoadingMore(true);
        loadingMoreRef.current = true;
      } else if (!skipLoadingState) {
        setLoading(true);
      }

      // Helper to reset loading state (only if still mounted)
      const stopLoading = () => {
        if (!isMounted.current) return;
        if (append) {
          setLoadingMore(false);
          loadingMoreRef.current = false;
        } else if (!skipLoadingState) {
          setLoading(false);
        }
      };

      const url = requestCursor
        ? apiUrl(
            `/api/posts?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(requestCursor)}`,
          )
        : apiUrl(`/api/posts?limit=${PAGE_SIZE}`);

      let response: Response;
      try {
        response = await fetch(url, {
          cache: forceNoStore ? "no-store" : undefined,
        });
      } catch {
        stopLoading();
        return;
      }

      if (!response.ok) {
        if (append && isMounted.current) setHasMore(false);
        stopLoading();
        return;
      }

      const data = await response.json();

      // Check if still mounted before updating state
      if (!isMounted.current) return;

      const newPosts = data.posts as FeedPost[];
      const nextCursor = data.cursor as string | null;
      const hasMoreFromAPI = data.hasMore as boolean;

      setPosts((prev) => {
        const combined = append ? [...prev, ...newPosts] : newPosts;
        const unique = new Map<string, FeedPost>();
        combined.forEach((post) => unique.set(post.id, post));
        return Array.from(unique.values()).sort((a, b) => {
          const aTime = new Date(a.timestamp ?? 0).getTime();
          const bTime = new Date(b.timestamp ?? 0).getTime();
          return bTime - aTime;
        });
      });

      setCursor(nextCursor);

      // Clean up local posts that are now in API response
      if (!append) {
        setLocalPosts((prev) => {
          const newPostIds = new Set(newPosts.map((p) => p.id));
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          return prev.filter((localPost) => {
            if (newPostIds.has(localPost.id)) return false;
            const postTime = new Date(localPost.timestamp).getTime();
            return postTime >= fiveMinutesAgo;
          });
        });
      }

      setHasMore(hasMoreFromAPI && newPosts.length > 0);
      stopLoading();
    },
    [],
  );

  const refresh = useCallback(async () => {
    await fetchPosts(null, false, true, true);
  }, [fetchPosts]);

  const addOptimisticPost = useCallback((post: FeedPost) => {
    setLocalPosts((prev) => [post, ...prev]);
  }, []);

  // Initial fetch - only run once when enabled
  useEffect(() => {
    if (!enabled) {
      // Reset state when disabled
      initialFetchDone.current = false;
      setLoading(false);
      return;
    }

    if (initialFetchDone.current) return;
    initialFetchDone.current = true;

    // Fetch posts - loading is already true from initial state
    void fetchPosts(null, false);
  }, [enabled, fetchPosts]);

  // SSE real-time updates
  useSSEChannel("feed", () => {
    if (enabled) {
      void fetchPosts(null, false, true, true);
    }
  });

  // Combine local and API posts
  const combinedPosts = (() => {
    const postMap = new Map<string, FeedPost>();
    localPosts.forEach((post) => postMap.set(post.id, post));
    posts.forEach((post) => {
      if (!postMap.has(post.id)) postMap.set(post.id, post);
    });
    return Array.from(postMap.values()).sort((a, b) => {
      const aTime = new Date(a.timestamp ?? 0).getTime();
      const bTime = new Date(b.timestamp ?? 0).getTime();
      return bTime - aTime;
    });
  })();

  return {
    posts: combinedPosts,
    loading,
    loadingMore,
    hasMore,
    cursor,
    fetchPosts,
    refresh,
    addOptimisticPost,
  };
}
