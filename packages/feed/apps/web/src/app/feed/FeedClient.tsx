'use client';

import type { FeedPost } from '@babylon/shared';
import { logger } from '@babylon/shared';
import { AlertCircle, Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineComposer } from '@/components/feed/InlineComposer';
import {
  TopGainerCard,
  TopLoserCard,
} from '@/components/notifications/FeedSignalCards';
import { FeedToggle } from '@/components/shared/FeedToggle';
import { PageContainer } from '@/components/shared/PageContainer';
import { PullToRefreshIndicator } from '@/components/shared/PullToRefreshIndicator';
import { FeedSkeleton } from '@/components/shared/Skeleton';
import { useWidgetRefresh } from '@/contexts/WidgetRefreshContext';
import { useAuth } from '@/hooks/useAuth';
import { useErrorToasts } from '@/hooks/useErrorToasts';
import { useFeedSignalCards } from '@/hooks/useFeedSignalCards';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { useFeedStore } from '@/stores/feedStore';
import { useGameStore } from '@/stores/gameStore';
import { apiUrl } from '@/utils/api-url';
import {
  DailyTopicBanner,
  EmptyFeed,
  ForYouFeedList,
  MixedFeedList,
  PostList,
} from './components';
import {
  useFeedPosts,
  useFollowingPosts,
  useForYouFeed,
  useNewMarkets,
  useStoriesFeed,
} from './hooks';

// Performance: Lazy load heavy components
const WidgetSidebar = dynamic(
  () =>
    import('@/components/shared/WidgetSidebar').then((m) => ({
      default: m.WidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  }
);

const TradesFeed = dynamic(
  () =>
    import('@/components/trades/TradesFeed').then((m) => ({
      default: m.TradesFeed,
    })),
  { ssr: false }
);

type FeedTab = 'latest' | 'stories' | 'forYou' | 'following' | 'trades';

function ForYouFeedError({ onRetry }: { onRetry: () => Promise<void> }) {
  const [isRetrying, setIsRetrying] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      // Guard against state update on unmounted component: if onRetry
      // succeeds the error clears and this component unmounts before finally.
      if (isMountedRef.current) setIsRetrying(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <AlertCircle className="mb-4 h-12 w-12 text-destructive opacity-60" />
      <h3 className="mb-2 font-semibold text-lg">Failed to load For You</h3>
      <p className="mb-6 max-w-sm text-muted-foreground text-sm">
        Something went wrong fetching the For You feed. Check your connection
        and try again.
      </p>
      <button
        type="button"
        onClick={() => void handleRetry()}
        disabled={isRetrying}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {isRetrying && <Loader2 className="h-4 w-4 animate-spin" />}
        {isRetrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/**
 * FeedClient - Main feed page orchestrator
 *
 * This component orchestrates the feed experience by:
 * - Managing tab state (latest, following, trades)
 * - Coordinating data fetching hooks
 * - Handling pull-to-refresh
 * - Rendering inline post composer
 *
 * Heavy components are lazy loaded:
 * - WidgetSidebar (desktop only)
 * - TradesFeed (trades tab only)
 */
export function FeedClient() {
  const router = useRouter();
  const { authenticated } = useAuth();
  const { refreshAll: refreshWidgets } = useWidgetRefresh();
  const { registerOptimisticPostCallback, unregisterOptimisticPostCallback } =
    useFeedStore();

  // Tab state
  const [tab, setTab] = useState<FeedTab>('forYou');

  // Actor names for display
  const [actorNames, setActorNames] = useState<Map<string, string>>(new Map());

  // Scroll container ref for TradesFeed
  const scrollContainerRefObject = useRef<HTMLDivElement | null>(null);

  // Enable error toasts
  useErrorToasts();

  // Data fetching hooks
  const {
    posts: latestPosts,
    loading: latestLoading,
    loadingMore,
    hasMore,
    cursor,
    fetchPosts,
    refresh: refreshLatest,
    addOptimisticPost,
  } = useFeedPosts({ enabled: tab === 'latest' });

  const { posts: followingPosts, loading: followingLoading } =
    useFollowingPosts({ enabled: tab === 'following' });

  const {
    topic: storiesTopic,
    stories: storiesStories,
    ready: storiesReady,
    loading: storiesLoading,
    loadingMore: storiesLoadingMore,
    hasMore: storiesHasMore,
    error: storiesError,
    refresh: refreshStories,
    loadMore: loadMoreStories,
  } = useStoriesFeed({ enabled: tab === 'stories' });

  const {
    stories: forYouStories,
    ready: forYouReady,
    loading: forYouLoading,
    loadingMore: forYouLoadingMore,
    hasMore: forYouHasMore,
    error: forYouError,
    refresh: refreshForYou,
    loadMore: loadMoreForYou,
  } = useForYouFeed({ enabled: tab === 'forYou' });

  // Feed signal cards (gainer / loser) — latest tab only
  const { gainerCard, loserCard } = useFeedSignalCards();

  // New market cards shown at the top of Latest and Hot tabs
  // New market cards only appear on the Latest tab, chronologically merged.
  // Stories and Following tabs show no market cards.
  const { markets: newMarkets } = useNewMarkets(tab === 'latest');

  // Game timeline posts (viewer mode fallback)
  const { allGames, startTime, currentTimeMs } = useGameStore();
  const currentDate = startTime ? new Date(startTime + currentTimeMs) : null;

  const timelinePosts = useMemo(() => {
    if (!startTime || !currentDate || allGames.length === 0) return [];

    const items: Array<{
      id: string;
      content: string;
      author: string;
      authorId: string;
      authorName: string;
      timestamp: string;
      timestampMs: number;
    }> = [];

    allGames.forEach((g) => {
      g.timeline?.forEach((day) => {
        day.feedPosts?.forEach((post) => {
          const ts = new Date(post.timestamp).getTime();
          items.push({
            id: `game-${g.id}-${post.timestamp}`,
            content: post.content,
            author: post.author,
            authorId: post.author,
            authorName: post.authorName,
            timestamp: post.timestamp,
            timestampMs: ts,
          });
        });
      });
    });

    const currentAbs = startTime + currentTimeMs;
    return items
      .filter((p) => p.timestampMs <= currentAbs)
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .map(({ timestampMs: _, ...rest }) => rest as FeedPost);
  }, [allGames, startTime, currentTimeMs, currentDate]);

  // Select posts based on current tab (Stories uses its own story renderer)
  const currentPosts = useMemo(() => {
    if (tab === 'following') return followingPosts;
    if (latestPosts.length > 0) return latestPosts;
    if (startTime && allGames.length > 0) return timelinePosts;
    return latestPosts;
  }, [tab, latestPosts, followingPosts, timelinePosts, startTime, allGames]);

  const isLoading =
    (tab === 'latest' && latestLoading) ||
    // Show skeleton while Stories/For You tab hasn't completed its first fetch,
    // preventing the empty-state flash between tab switch and the async effect.
    (tab === 'stories' && (storiesLoading || !storiesReady)) ||
    (tab === 'forYou' && (forYouLoading || !forYouReady)) ||
    (tab === 'following' && followingLoading);

  // Load actor names — fire-and-forget, falls back to authorId on failure
  useEffect(() => {
    const loadActorNames = async () => {
      try {
        const response = await fetch(apiUrl('/api/actors'));
        if (!response.ok) {
          logger.warn(
            'Failed to load actor names',
            { status: response.status },
            'FeedClient'
          );
          return;
        }
        const data = (await response.json()) as {
          actors?: Array<{ id: string; name: string }>;
        };
        const nameMap = new Map<string, string>();
        data.actors?.forEach((actor) => {
          nameMap.set(actor.id, actor.name);
        });
        setActorNames(nameMap);
      } catch (err) {
        logger.warn('Error loading actor names', { error: err }, 'FeedClient');
      }
    };
    void loadActorNames();
  }, []);

  // Register optimistic post callback
  useEffect(() => {
    const handleOptimisticPost = (post: FeedPost) => {
      addOptimisticPost(post);
    };

    registerOptimisticPostCallback(handleOptimisticPost);
    return () => {
      unregisterOptimisticPostCallback();
    };
  }, [
    registerOptimisticPostCallback,
    unregisterOptimisticPostCallback,
    addOptimisticPost,
  ]);

  // Pull-to-refresh
  const handleRefresh = useCallback(async () => {
    if (tab === 'latest') {
      await refreshLatest();
      refreshWidgets();
    } else if (tab === 'forYou') {
      await refreshForYou();
    } else if (tab === 'stories') {
      await refreshStories();
    }
  }, [tab, refreshLatest, refreshWidgets, refreshForYou, refreshStories]);

  const {
    pullDistance,
    isRefreshing,
    containerRef: scrollContainerCallbackRef,
  } = usePullToRefresh({
    onRefresh: handleRefresh,
    enabled:
      tab === 'latest' ||
      tab === 'trades' ||
      tab === 'forYou' ||
      tab === 'stories',
  });

  const scrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerCallbackRef(node);
      if (scrollContainerRefObject.current !== node) {
        scrollContainerRefObject.current = node;
      }
    },
    [scrollContainerCallbackRef]
  );

  // Load more handler
  const handleLoadMore = useCallback(() => {
    if (tab === 'latest' && cursor) {
      void fetchPosts(cursor, true);
    }
  }, [tab, cursor, fetchPosts]);

  // Handle post creation
  const handlePostCreated = useCallback(
    (newPost: {
      id: string;
      content: string;
      authorId: string;
      authorName: string;
      authorUsername?: string | null;
      authorProfileImageUrl?: string | null;
      timestamp: string;
    }) => {
      const optimisticPost: FeedPost = {
        id: newPost.id,
        content: newPost.content,
        author: newPost.authorId,
        authorId: newPost.authorId,
        authorName: newPost.authorName,
        authorUsername: newPost.authorUsername || undefined,
        authorProfileImageUrl: newPost.authorProfileImageUrl || undefined,
        timestamp: newPost.timestamp,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        isLiked: false,
        isShared: false,
      };

      addOptimisticPost(optimisticPost);

      if (window.location.pathname !== '/feed') {
        router.push('/feed');
      }
    },
    [addOptimisticPost, router]
  );

  // Render content based on tab and state
  const renderContent = () => {
    if (tab === 'trades') {
      return <TradesFeed containerRef={scrollContainerRefObject} />;
    }

    if (isLoading) {
      return (
        <div className="w-full">
          <FeedSkeleton count={5} />
        </div>
      );
    }

    if (tab === 'stories') {
      if (storiesError) return <EmptyFeed variant="stories" />;
      return (
        <>
          {storiesTopic && <DailyTopicBanner topic={storiesTopic} />}
          {storiesStories.length === 0 ? (
            <EmptyFeed variant="stories" />
          ) : (
            <ForYouFeedList
              stories={storiesStories}
              surface="stories"
              hasMore={storiesHasMore}
              loadingMore={storiesLoadingMore}
              loadMore={loadMoreStories}
            />
          )}
        </>
      );
    }

    if (tab === 'forYou') {
      if (forYouError) return <ForYouFeedError onRetry={refreshForYou} />;
      if (forYouStories.length === 0) return <EmptyFeed variant="forYou" />;
      return (
        <ForYouFeedList
          stories={forYouStories}
          surface="for_you"
          hasMore={forYouHasMore}
          loadingMore={forYouLoadingMore}
          loadMore={loadMoreForYou}
          refresh={refreshForYou}
        />
      );
    }

    if (currentPosts.length === 0) {
      if (tab === 'latest') return <EmptyFeed variant="latest" />;
      if (tab === 'following')
        return <EmptyFeed variant="following" isLoading={followingLoading} />;
      return <EmptyFeed variant="default" />;
    }

    // Latest tab: merge new market cards chronologically into the post stream
    if (tab === 'latest') {
      return (
        <MixedFeedList
          posts={currentPosts}
          newMarkets={newMarkets}
          actorNames={actorNames}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
        />
      );
    }

    return (
      // Following is a single-page fetch with no cursor pagination.
      // (Latest uses MixedFeedList above.)
      <PostList
        posts={currentPosts}
        actorNames={actorNames}
        hasMore={false}
        loadingMore={loadingMore}
        onLoadMore={handleLoadMore}
      />
    );
  };

  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div ref={scrollContainerRef} className="relative flex flex-1">
        {/* Feed area */}
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l xl:max-w-[700px] xl:flex-[0_1_700px]">
          {/* Header with tabs */}
          <div className="sticky top-0 z-10 flex-shrink-0 bg-background shadow-sm">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <FeedToggle activeTab={tab} onTabChange={setTab} />
            </div>
          </div>

          {/* Feed content */}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <PullToRefreshIndicator
                pullDistance={pullDistance}
                isRefreshing={isRefreshing}
              />

              {/* Inline Composer - shown on feed tabs for authenticated users */}
              {authenticated &&
                (tab === 'latest' || tab === 'forYou' || tab === 'stories') && (
                  <InlineComposer onPostCreated={handlePostCreated} />
                )}

              {/* Feed signal cards — latest tab only */}
              {tab === 'latest' && (gainerCard ?? loserCard) && (
                <div>
                  {gainerCard && <TopGainerCard {...gainerCard} />}
                  {loserCard && <TopLoserCard {...loserCard} />}
                </div>
              )}

              <div>{renderContent()}</div>
            </div>
          </div>
        </div>

        {/* Widget sidebar - lazy loaded, desktop only */}
        <WidgetSidebar showPositions />
      </div>
    </PageContainer>
  );
}
