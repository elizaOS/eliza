'use client';

import type { FeedPost } from '@feed/shared';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NewMarketEntry } from '@/app/api/feed/new-markets/route';
import type { NarrativeStory } from '@/app/feed/types/narrative';
import { mergeChronologically } from '@/app/feed/utils/feedAlgorithms';
import { toFeedPostCardData } from '@/app/feed/utils/postMappers';
import { ArticleCard } from '@/components/articles/ArticleCard';
import { PostCard } from '@/components/posts/PostCard';
import { InviteFriendsBanner } from '@/components/shared/InviteFriendsBanner';
import { useAuthStore } from '@/stores/authStore';
import { NewMarketCard } from './NewMarketCard';

function marketToNarrativeStory(m: NewMarketEntry): NarrativeStory {
  return {
    storyKey: `market:${m.questionNumber}`,
    storyTitle: m.text,
    questionNumber: m.questionNumber,
    arcState: m.arcState,
    storyScore: 0,
    postCount: 0,
    posts: [],
    hasUserPosition: false,
    isNewMarket: true,
    resolutionDate: m.resolutionDate,
    // Pass live market data through for deep-linking and real probability bars
    marketId: m.marketId ?? null,
    yesShares: m.yesShares,
    noShares: m.noShares,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface MixedFeedListProps {
  posts: FeedPost[];
  newMarkets: NewMarketEntry[];
  actorNames: Map<string, string>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  density?: 'default' | 'compact';
}

/**
 * Latest-tab feed renderer that chronologically merges regular posts with
 * new market discovery cards. A market opened 30 minutes ago appears between
 * 25-minute-old and 35-minute-old posts — not batched at the top.
 *
 * When newMarkets is empty this is functionally identical to PostList.
 */
export const MixedFeedList = memo(function MixedFeedList({
  posts,
  newMarkets,
  actorNames,
  hasMore,
  loadingMore,
  onLoadMore,
  density = 'default',
}: MixedFeedListProps) {
  const router = useRouter();
  const { user } = useAuthStore();
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const calculateBannerInterval = useCallback(() => {
    if (!user) return Math.floor(Math.random() * 51) + 50;
    const referralCount = user.referralCount ?? 0;
    const dismissKey = `banner_dismiss_time_${user.id}`;
    const lastDismiss =
      typeof window !== 'undefined' ? localStorage.getItem(dismissKey) : null;
    if (lastDismiss) {
      const daysSinceDismiss =
        (Date.now() - Number.parseInt(lastDismiss)) / 86400000;
      if (daysSinceDismiss < 7) return 999999;
    }
    if (referralCount === 0) return Math.floor(Math.random() * 21) + 30;
    if (referralCount < 5) return Math.floor(Math.random() * 31) + 50;
    if (referralCount < 10) return Math.floor(Math.random() * 41) + 80;
    return Math.floor(Math.random() * 51) + 150;
  }, [user]);

  const bannerInterval = useRef<number>(0);
  if (bannerInterval.current === 0) {
    bannerInterval.current = calculateBannerInterval();
  }

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasMore && !loadingMore) onLoadMore();
      },
      { rootMargin: '200px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  const items = useMemo(
    () => mergeChronologically(posts, newMarkets),
    [posts, newMarkets]
  );

  // Track banner position relative to post items only
  let postIndex = 0;

  return (
    <div className="w-full space-y-0">
      {items.map((item) => {
        if (item.type === 'market') {
          return (
            <NewMarketCard
              key={`market-${item.market.questionNumber}`}
              story={marketToNarrativeStory(item.market)}
            />
          );
        }

        const post = item.post;
        const i = postIndex++;
        const authorId =
          ('authorId' in post ? post.authorId : post.author) || '';
        const authorName =
          actorNames.get(authorId) ||
          ('authorName' in post ? post.authorName : '') ||
          authorId;

        const showBannerAfterThisPost =
          !bannerDismissed && i === bannerInterval.current - 1;

        const postData = toFeedPostCardData(post, authorName);

        return (
          <div key={`post-wrapper-${post.id}-${i}`}>
            {postData.type === 'article' ? (
              <ArticleCard post={postData} density={density} />
            ) : (
              <PostCard
                post={postData}
                density={density}
                showCommentInputBar={false}
                onCommentClick={() => {
                  const postId =
                    postData.isRepost &&
                    !postData.isQuote &&
                    postData.originalPostId != null
                      ? postData.originalPostId
                      : post.id;
                  router.push(`/post/${postId}`);
                }}
              />
            )}
            {showBannerAfterThisPost && (
              <InviteFriendsBanner
                onDismiss={() => {
                  setBannerDismissed(true);
                  bannerInterval.current = calculateBannerInterval();
                }}
              />
            )}
          </div>
        );
      })}

      <div ref={loadMoreRef} className="h-1 w-full" />

      {loadingMore && (
        <div className="py-4 text-center text-muted-foreground text-sm">
          Loading more posts...
        </div>
      )}

      {!loadingMore && !hasMore && posts.length > 0 && (
        <div className="py-4 text-center text-muted-foreground text-xs">
          You&apos;re all caught up.
        </div>
      )}
    </div>
  );
});
