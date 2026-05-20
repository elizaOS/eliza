"use client";

export const dynamic = "force-dynamic";

import { logger } from "@feed/shared";
import { ArrowLeft, TrendingUp } from "lucide-react";
import nextDynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PostCard } from "@/components/posts/PostCard";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { apiUrl } from "@/utils/api-url";

const WidgetSidebar = nextDynamic(
  () =>
    import("@/components/shared/WidgetSidebar").then((m) => ({
      default: m.WidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  },
);

interface PostData {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string | null;
  authorProfileImageUrl?: string | null;
  timestamp: string;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  isLiked?: boolean;
  isShared?: boolean;
}

const PAGE_SIZE = 20;

export default function TrendingTagPage() {
  const params = useParams();
  const router = useRouter();
  const tag = params.tag as string;
  const [posts, setPosts] = useState<PostData[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagInfo, setTagInfo] = useState<{
    name: string;
    displayName: string;
    category?: string | null;
  } | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPosts = useCallback(
    async (requestOffset: number, append = false) => {
      if (append) setLoadingMore(true);
      else setLoading(true);

      const response = await fetch(
        apiUrl(
          `/api/trending/${encodeURIComponent(tag)}?limit=${PAGE_SIZE}&offset=${requestOffset}`,
        ),
      );

      if (!response.ok) {
        if (response.status === 404) {
          logger.warn("Tag not found", { tag }, "TrendingTagPage");
        }
        if (append) setHasMore(false);
        if (append) setLoadingMore(false);
        else setLoading(false);
        return;
      }

      const data = await response.json();

      if (data.success) {
        if (!append && data.tag) {
          setTagInfo(data.tag);
        }

        const newPosts = data.posts || [];

        setPosts((prev) => {
          const combined = append ? [...prev, ...newPosts] : newPosts;
          const unique = new Map<string, PostData>();
          combined.forEach((post: PostData) => {
            if (post?.id) {
              unique.set(post.id, post);
            }
          });

          const deduped = Array.from(unique.values()).sort((a, b) => {
            const aTime = new Date(a.timestamp ?? 0).getTime();
            const bTime = new Date(b.timestamp ?? 0).getTime();
            return bTime - aTime;
          });

          return deduped;
        });

        setOffset(requestOffset + newPosts.length);

        const moreAvailable = newPosts.length === PAGE_SIZE;
        setHasMore(moreAvailable);
      }

      if (append) setLoadingMore(false);
      else setLoading(false);
    },
    [tag],
  );

  useEffect(() => {
    setOffset(0);
    setHasMore(true);
    fetchPosts(0, false);
  }, [fetchPosts]);

  const handleLoadMore = () => {
    if (!loading && !loadingMore && hasMore) {
      fetchPosts(offset, true);
    }
  };

  const headerTitle = tagInfo?.displayName || decodeURIComponent(tag);
  const headerCategory = tagInfo?.category || null;

  const feedContent = (
    <>
      {loading ? (
        <div className="space-y-4 sm:px-4 sm:py-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : posts.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <h2 className="mb-2 font-semibold text-xl">No posts found</h2>
            <p className="text-muted-foreground">
              No posts have been tagged with &quot;
              {tagInfo?.displayName || tag}&quot; yet.
            </p>
          </div>
        </div>
      ) : (
        <div>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} showCommentInputBar={false} />
          ))}

          {hasMore && (
            <div className="py-4 text-center">
              {loadingMore ? (
                <div className="text-muted-foreground text-sm">
                  Loading more posts...
                </div>
              ) : (
                <button
                  onClick={handleLoadMore}
                  className="rounded-lg bg-primary px-6 py-2 text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Load More
                </button>
              )}
            </div>
          )}

          {!hasMore && posts.length > 0 && (
            <div className="py-4 text-center text-muted-foreground text-xs">
              You&apos;re all caught up.
            </div>
          )}
        </div>
      )}

      {/* Spacer for login bar */}
      <div className="pb-24" />
    </>
  );

  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
        {/* Desktop: Content area */}
        <div className="hidden min-w-0 flex-1 flex-col border-border lg:flex lg:border-r lg:border-l">
          {/* Desktop header */}
          <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
            <div className="px-6 py-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.back()}
                  className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Go back"
                >
                  <ArrowLeft size={20} />
                </button>
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  <h1 className="font-bold text-xl">{headerTitle}</h1>
                </div>
                {headerCategory && (
                  <p className="ml-auto text-muted-foreground text-sm">
                    {headerCategory} · Trending
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Feed content */}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              {feedContent}
            </div>
          </div>
        </div>

        {/* Widget sidebar - desktop only */}
        <WidgetSidebar />

        {/* Mobile/Tablet: Single column layout */}
        <div className="flex flex-1 flex-col overflow-hidden lg:hidden">
          {/* Mobile header */}
          <div className="sticky top-0 z-10 shrink-0 border-border border-b bg-background">
            <div className="flex items-center gap-4 px-4 py-3">
              <button
                onClick={() => router.back()}
                className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Go back"
              >
                <ArrowLeft size={20} />
              </button>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                <h1 className="font-bold text-xl">{headerTitle}</h1>
              </div>
              {headerCategory && (
                <p className="ml-auto text-muted-foreground text-sm">
                  {headerCategory} · Trending
                </p>
              )}
            </div>
          </div>

          {/* Mobile content */}
          <div className="flex-1 overflow-y-auto">{feedContent}</div>
        </div>
      </div>
    </PageContainer>
  );
}
