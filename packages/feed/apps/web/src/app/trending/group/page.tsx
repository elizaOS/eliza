"use client";

export const dynamic = "force-dynamic";

import { logger } from "@feed/shared";
import { ArrowLeft, TrendingUp } from "lucide-react";
import nextDynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
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
  type?: string;
  isShared?: boolean;
  articleTitle?: string | null;
  byline?: string | null;
  biasScore?: number | null;
  category?: string | null;
}

interface TagInfo {
  id: string;
  displayName: string;
  category: string | null;
}

export default function GroupedTrendingPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tagsParam = searchParams.get("tags") || "";
  const [posts, setPosts] = useState<PostData[]>([]);
  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<TagInfo[]>([]);

  const fetchPosts = useCallback(async () => {
    if (!tagsParam) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const response = await fetch(
      apiUrl(`/api/trending/group?tags=${tagsParam}&limit=50`),
    );

    if (!response.ok) {
      logger.warn(
        "Failed to fetch grouped trending posts",
        { tagsParam },
        "GroupedTrendingPage",
      );
      setLoading(false);
      return;
    }

    const data = await response.json();

    if (data.success) {
      setPosts(data.posts || []);
      setTags(data.tags || []);
    }

    setLoading(false);
  }, [tagsParam]);

  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  const headerTitle =
    tags.length > 0
      ? tags.map((t) => t.displayName).join(" · ")
      : "Grouped Trending";

  const headerCategory =
    tags.length > 0 && tags[0]?.category ? tags[0].category : null;

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
              No posts found for these trending topics yet.
            </p>
          </div>
        </div>
      ) : (
        <div>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} showCommentInputBar={false} />
          ))}

          {posts.length > 0 && (
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
                    {headerCategory}
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
                  {headerCategory}
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
