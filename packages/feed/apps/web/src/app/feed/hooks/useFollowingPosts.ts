import type { FeedPost } from '@feed/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { apiUrl } from '@/utils/api-url';

const PAGE_SIZE = 20;

interface UseFollowingPostsOptions {
  enabled?: boolean;
}

interface UseFollowingPostsResult {
  posts: FeedPost[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching posts from followed users/actors
 *
 * Requires authentication - returns empty if not logged in
 */
export function useFollowingPosts(
  options: UseFollowingPostsOptions = {}
): UseFollowingPostsResult {
  const { enabled = true } = options;

  const { authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();

  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(false);
  const fetchInProgress = useRef(false);

  const fetchFollowingPosts = useCallback(async () => {
    const userId = user?.id;
    if (!enabled || !authenticated || !userId) {
      setPosts([]);
      return;
    }

    // Prevent duplicate fetches
    if (fetchInProgress.current) return;
    fetchInProgress.current = true;
    setLoading(true);

    try {
      const token = await getAccessToken();

      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(
        apiUrl(
          `/api/posts?following=true&userId=${userId}&limit=${PAGE_SIZE}&offset=0`
        ),
        { headers }
      );

      if (response.ok) {
        const data = await response.json();
        setPosts(data.posts as FeedPost[]);
      }
    } catch {
      // Network error - no action needed
    } finally {
      setLoading(false);
      fetchInProgress.current = false;
    }
  }, [enabled, authenticated, user?.id, getAccessToken]);

  const refresh = useCallback(async () => {
    await fetchFollowingPosts();
  }, [fetchFollowingPosts]);

  // Fetch on mount when enabled and authenticated
  useEffect(() => {
    if (enabled && authenticated && user?.id) {
      fetchFollowingPosts();
    }
  }, [enabled, authenticated, user?.id, fetchFollowingPosts]);

  return {
    posts,
    loading,
    refresh,
  };
}
