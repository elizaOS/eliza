'use client';

import type { FeedPost } from '@feed/shared';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toFeedPostCardData } from '@/app/feed/utils/postMappers';
import { ArticleCard } from '@/components/articles/ArticleCard';
import { PostCard } from '@/components/posts/PostCard';
import { InviteFriendsBanner } from '@/components/shared/InviteFriendsBanner';
import { useAuthStore } from '@/stores/authStore';

interface PostListProps {
  posts: FeedPost[];
  actorNames: Map<string, string>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  density?: 'default' | 'compact';
}

/**
 * PostList - Renders a list of posts with infinite scroll
 *
 * Features:
 * - Supports both regular posts and articles
 * - Shows invite banner at smart intervals
 * - Intersection observer for infinite scroll
 * - Memoized for performance
 */
export const PostList = memo(function PostList({
  posts,
  actorNames,
  hasMore,
  loadingMore,
  onLoadMore,
  density = 'default',
}: PostListProps) {
  const router = useRouter();
  const { user } = useAuthStore();
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Smart banner interval based on referrals
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

  const bannerInterval = useRef(calculateBannerInterval());

  // Infinite scroll observer
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasMore && !loadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  return (
    <div className="w-full space-y-0">
      {posts.map((post, i) => {
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
                  // For simple reposts, comments live on the original post
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

      {/* Infinite scroll trigger */}
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
