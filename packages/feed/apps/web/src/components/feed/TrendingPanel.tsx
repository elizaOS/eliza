'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { useWidgetRefresh } from '@/contexts/WidgetRefreshContext';
import { useSSEChannel } from '@/hooks/useSSE';
import {
  type TrendingItem,
  useWidgetCacheStore,
} from '@/stores/widgetCacheStore';
import { apiUrl } from '@/utils/api-url';

/**
 * Trending panel component for displaying trending topics.
 *
 * Displays a list of trending topics/hashtags with post counts and summaries.
 * Uses widget cache for performance and supports manual refresh via
 * WidgetRefreshContext. Navigates to trending detail page on click.
 *
 * Features:
 * - Trending topics list
 * - Post count display
 * - Category and summary
 * - Widget caching
 * - Manual refresh support
 * - Loading states
 *
 * @returns Trending panel element
 */
export function TrendingPanel() {
  const router = useRouter();
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { getTrending, setTrending: cacheTrending } = useWidgetCacheStore();
  const { registerRefresh, unregisterRefresh } = useWidgetRefresh();

  // Use ref to store fetchTrending function to break dependency chain
  const fetchTrendingRef = useRef<(() => void) | null>(null);

  const fetchTrending = useCallback(
    async (skipCache = false) => {
      // Check cache first (unless explicitly skipping)
      if (!skipCache) {
        const cached = getTrending();
        // Only use cache if it has data (don't cache empty arrays)
        if (cached && cached.length > 0) {
          setTrending(cached);
          setLoading(false);
          return;
        }
      }

      const response = await fetch(apiUrl('/api/feed/widgets/trending'));
      const data = (await response.json()) as {
        success: boolean;
        trending?: TrendingItem[];
      };

      if (data.success) {
        const trendingData = data.trending || [];
        setTrending(trendingData);
        cacheTrending(trendingData); // Cache the data
      }
      setLoading(false);
    },
    [getTrending, cacheTrending]
  );

  // Update ref when fetchTrending changes
  useEffect(() => {
    fetchTrendingRef.current = () => fetchTrending(true); // Skip cache on manual refresh
  }, [fetchTrending]);

  useEffect(() => {
    fetchTrending();
  }, [fetchTrending]);

  // Register refresh function
  useEffect(() => {
    const refresh = () => fetchTrending(true);
    registerRefresh('trending', refresh);
    return () => unregisterRefresh('trending');
  }, [registerRefresh, unregisterRefresh, fetchTrending]);

  // Real-time refresh on feed events
  useSSEChannel('feed', () => {
    void fetchTrending(true);
  });

  const handleTrendingClick = (item: TrendingItem) => {
    // If multiple tags, navigate to grouped view; otherwise single tag view
    if (item.tagSlugs.length > 1) {
      // Navigate to grouped trending view with multiple tag slugs
      const tagSlugsParam = item.tagSlugs.join(',');
      router.push(`/trending/group?tags=${encodeURIComponent(tagSlugsParam)}`);
    } else {
      // Single tag - use existing route
      router.push(`/trending/${item.tagSlugs[0]}`);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <h2 className="mb-3 font-bold text-foreground text-lg">Trending</h2>
      {loading ? (
        <div className="flex-1 space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : trending.length === 0 ? (
        <div className="flex-1 text-muted-foreground text-sm">
          No trending topics at the moment.
        </div>
      ) : (
        <div className="flex-1 space-y-2">
          {trending.map((item) => (
            <div
              key={item.id}
              onClick={() => handleTrendingClick(item)}
              className="-mx-2 cursor-pointer rounded-lg px-2 py-1.5 transition-colors duration-200 hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                {/* Category and tag name(s) */}
                <p className="font-semibold text-foreground text-sm leading-snug">
                  {item.category && (
                    <span className="text-muted-foreground">
                      {item.category} ·{' '}
                    </span>
                  )}
                  {item.tags.join(' · ')}
                </p>
                {/* Summary */}
                {item.summary && (
                  <p className="mt-0.5 line-clamp-1 text-muted-foreground text-xs">
                    {item.summary}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
