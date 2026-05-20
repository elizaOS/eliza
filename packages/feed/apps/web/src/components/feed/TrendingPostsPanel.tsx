"use client";

import { getProfileUrl } from "@feed/shared";
import { formatDistanceToNow } from "date-fns";
import { Heart, MessageCircle, Share2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/shared/Skeleton";
import { apiUrl } from "@/utils/api-url";

/**
 * Trending post structure for trending posts panel.
 */
interface TrendingPost {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string | null;
  timestamp: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  trendingScore: number;
}

/**
 * Trending posts panel component for displaying trending posts.
 *
 * Displays a list of trending posts with interaction counts and timestamps.
 * Automatically refreshes every 30 seconds. Navigates to feed with post
 * query parameter on click to open comments.
 *
 * Features:
 * - Trending posts list
 * - Interaction counts (likes, comments, shares)
 * - Relative timestamps
 * - Auto-refresh (30s interval)
 * - Loading states
 *
 * @returns Trending posts panel element
 */
export function TrendingPostsPanel() {
  const [posts, setPosts] = useState<TrendingPost[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const fetchTrendingPosts = async () => {
      const response = await fetch(apiUrl("/api/feed/widgets/trending-posts"));
      const data = await response.json();
      if (data.success) {
        setPosts(data.posts || []);
      }
      setLoading(false);
    };

    fetchTrendingPosts();
    // Refresh every 30 seconds
    const interval = setInterval(fetchTrendingPosts, 30000);
    return () => clearInterval(interval);
  }, []);

  const handlePostClick = (postId: string) => {
    // Navigate to feed with post query param to open comments
    router.push(`/feed?post=${postId}`);
  };

  const truncateContent = (content: string, maxLength = 100) => {
    if (content.length <= maxLength) return content;
    return `${content.slice(0, maxLength)}...`;
  };

  return (
    <div className="flex flex-1 flex-col rounded-lg bg-sidebar p-4">
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-[#0066FF]" />
        <h2 className="font-bold text-foreground text-xl">Trending</h2>
      </div>
      {loading ? (
        <div className="flex-1 space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : posts.length === 0 ? (
        <div className="flex-1 text-muted-foreground text-sm">
          No trending posts at the moment.
        </div>
      ) : (
        <div className="flex-1 space-y-3">
          {posts.map((post) => {
            const postDate = new Date(post.timestamp);
            const timeAgo = formatDistanceToNow(postDate, { addSuffix: true });

            return (
              <div
                key={post.id}
                onClick={() => handlePostClick(post.id)}
                className="-mx-2 cursor-pointer rounded-lg p-2 transition-colors hover:bg-muted/50"
              >
                {/* Author */}
                <div className="mb-1.5 flex items-center gap-2">
                  <Link
                    href={getProfileUrl(post.authorId, null)}
                    onClick={(e) => e.stopPropagation()}
                    className="truncate font-semibold text-foreground text-sm hover:underline"
                  >
                    {post.authorName}
                  </Link>
                  <span className="truncate text-muted-foreground text-xs">
                    @{post.authorUsername || post.authorId}
                  </span>
                  <span className="ml-auto text-muted-foreground text-xs">
                    {timeAgo}
                  </span>
                </div>

                {/* Content */}
                <p className="mb-2 line-clamp-2 break-words text-foreground text-sm">
                  {truncateContent(post.content, 120)}
                </p>

                {/* Interaction counts */}
                <div className="flex items-center gap-4 text-muted-foreground text-xs">
                  <div className="flex items-center gap-1">
                    <Heart className="h-3 w-3" />
                    <span>{post.likeCount}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <MessageCircle className="h-3 w-3" />
                    <span>{post.commentCount}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Share2 className="h-3 w-3" />
                    <span>{post.shareCount}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
