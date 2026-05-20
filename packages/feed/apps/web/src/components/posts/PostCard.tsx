"use client";

import type { PostInteraction } from "@feed/shared";
import { cn, getProfileUrl } from "@feed/shared";
import { Repeat2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type MouseEvent, memo } from "react";
import { InteractionBar } from "@/components/interactions";
import { ModerationMenu } from "@/components/moderation/ModerationMenu";
import {
  CommentPreview,
  type CommentPreviewData,
} from "@/components/posts/CommentPreview";
import { Avatar } from "@/components/shared/Avatar";
import { TaggedText } from "@/components/shared/TaggedText";
import {
  isNpcIdentifier,
  VerifiedBadge,
} from "@/components/shared/VerifiedBadge";
import { useFontSize } from "@/contexts/FontSizeContext";
import { useAuth } from "@/hooks/useAuth";

/**
 * Post card component for displaying feed posts.
 *
 * Displays a post with author info, content, timestamp, and interaction bar.
 * Supports reposts, quote posts, articles, and regular posts. Handles
 * client-side repost parsing if API doesn't provide metadata. Includes
 * moderation menu and responsive behavior.
 *
 * Features:
 * - Author avatar and verified badge
 * - Tagged text parsing (@mentions, #hashtags, $cashtags)
 * - Repost/quote post display
 * - Article type support
 * - Interaction bar (like, comment, share)
 * - Moderation menu
 * - Responsive layout
 *
 * @param props - PostCard component props
 * @returns Post card element
 *
 * @example
 * ```tsx
 * <PostCard
 *   post={postData}
 *   showInteractions={true}
 *   onCommentClick={() => openComments()}
 * />
 * ```
 */
export interface PostCardProps {
  post: {
    id: string;
    type?: string; // "post" | "article"
    content: string;
    articleTitle?: string | null;
    byline?: string | null;
    biasScore?: number | null;
    sentiment?: string | null;
    category?: string | null;
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
    deletedAt?: string | null; // Soft delete timestamp
    // Repost metadata
    isRepost?: boolean;
    isQuote?: boolean; // True if it has quote commentary
    quoteComment?: string | null; // The quote commentary text
    originalPostId?: string | null;
    originalPost?: {
      id: string;
      content: string;
      authorId: string;
      authorName: string;
      authorUsername: string | null;
      authorProfileImageUrl: string | null;
      timestamp: string;
    } | null;
    // Comment previews for inline display
    commentPreviews?: CommentPreviewData[];
  };
  className?: string;
  density?: "default" | "compact";
  onCommentClick?: () => void;
  onOpen?: () => void;
  onLikeChange?: (isLiked: boolean) => void;
  onShareChange?: (isShared: boolean) => void;
  showInteractions?: boolean;
  showCommentPreviews?: boolean;
  showCommentInputBar?: boolean;
  isDetail?: boolean;
}

export const PostCard = memo(function PostCard({
  post,
  className,
  density = "default",
  onCommentClick,
  onOpen,
  onLikeChange,
  onShareChange,
  showInteractions = true,
  showCommentPreviews = true,
  showCommentInputBar = true,
  isDetail = false,
}: PostCardProps) {
  const router = useRouter();
  const { fontSize } = useFontSize();
  const { user } = useAuth();
  const compact = density === "compact";
  const densityScale = compact ? 0.9 : 1;

  const postDate = new Date(post.timestamp);
  const now = new Date();
  const diffMs = now.getTime() - postDate.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  let timeAgo: string;
  if (diffMinutes < 1) {
    timeAgo = "Just now";
  } else if (diffMinutes < 60) {
    timeAgo = `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    timeAgo = `${diffHours}h ago`;
  } else {
    // Show date for posts older than 24 hours
    timeAgo = postDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year:
        postDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }

  const initialInteractions: PostInteraction = {
    postId: post.id,
    likeCount: post.likeCount ?? 0,
    commentCount: post.commentCount ?? 0,
    shareCount: post.shareCount ?? 0,
    isLiked: post.isLiked ?? false,
    isShared: post.isShared ?? false,
  };

  // Determine if this is a simple repost (no quote) or a quote post
  // Simple repost: isRepost && !isQuote (or !quoteComment)
  // Quote post: isRepost && isQuote (or has quoteComment)
  const isSimpleRepost = post.isRepost && !post.isQuote && !post.quoteComment;

  // For QUOTE posts, show the REPOSTER's info in the header
  // For simple reposts, show the ORIGINAL author's info
  const displayAuthorId =
    isSimpleRepost && post.originalPost
      ? post.originalPost.authorId
      : post.authorId;
  const displayAuthorName =
    isSimpleRepost && post.originalPost
      ? post.originalPost.authorName
      : post.authorName;
  const displayAuthorUsername =
    isSimpleRepost && post.originalPost
      ? post.originalPost.authorUsername
      : post.authorUsername;
  const displayAuthorProfileImageUrl =
    isSimpleRepost && post.originalPost
      ? post.originalPost.authorProfileImageUrl
      : post.authorProfileImageUrl;

  const authorIsNPC = isNpcIdentifier(displayAuthorId);
  const showVerifiedBadge = authorIsNPC;

  // For quote posts with deleted originals, link to the quote post itself
  // For other reposts, link to the original post (if it exists)
  const quotedPostId = post.originalPost
    ? post.originalPostId
    : post.isRepost && post.isQuote
      ? post.id
      : null;

  // Internal click handler that navigates to the correct post
  // For simple reposts, navigate to the original post
  // For quote posts and regular posts, navigate to the post itself
  const handleCardClick = () => {
    onOpen?.();
    // For simple reposts, go to the original post
    if (isSimpleRepost && post.originalPostId) {
      router.push(`/post/${post.originalPostId}`);
    } else {
      // For quote posts and regular posts, go to this post
      router.push(`/post/${post.id}`);
    }
  };

  const handleQuotedPostClick = (event: MouseEvent<HTMLDivElement>) => {
    // Always stop propagation to prevent parent card click
    event.preventDefault();
    event.stopPropagation();

    // Only navigate if we have a valid post ID
    if (quotedPostId) {
      router.push(`/post/${quotedPostId}`);
    }
  };

  const handleQuotedPostKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    // Always stop propagation to prevent parent card click
    event.preventDefault();
    event.stopPropagation();

    // Only navigate if we have a valid post ID
    if (quotedPostId) {
      router.push(`/post/${quotedPostId}`);
    }
  };

  const handleTaggedTextClick = (tag: string) => {
    if (tag.startsWith("@")) {
      const username = tag.slice(1);
      router.push(getProfileUrl("", username));
      return;
    }

    if (tag.startsWith("$")) {
      const symbol = tag.slice(1);
      router.push(`/markets?search=${encodeURIComponent(symbol)}`);
    }
  };

  // If post is deleted, show a minimal placeholder
  if (post.deletedAt) {
    return (
      <article
        className={cn(
          compact ? "px-3 py-2" : "px-4 py-3",
          "w-full overflow-hidden",
          "border-border border-b",
          className,
        )}
      >
        <div className="flex items-center justify-center py-8 text-muted-foreground italic">
          (no post)
        </div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        compact ? "px-3 py-3" : "px-4 py-4",
        !isDetail &&
          "cursor-pointer transition-all duration-200 hover:bg-muted/30",
        "w-full overflow-hidden",
        !isDetail && "border-border border-b",
        className,
      )}
      style={{
        fontSize: `${fontSize * densityScale}rem`,
      }}
      onClick={!isDetail ? handleCardClick : undefined}
    >
      {/* Repost Indicator - Only show for simple reposts (not quote posts) */}
      {isSimpleRepost && (
        <div className="mb-1 flex items-center gap-2 pl-12 text-muted-foreground text-xs">
          <Repeat2 size={14} className="text-green-600" />
          <span>
            Reposted by{" "}
            {user?.id === post.authorId ? (
              <span className="font-semibold text-foreground">you</span>
            ) : (
              <Link
                href={getProfileUrl(post.authorId, null)}
                className="font-semibold text-foreground hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {post.authorName}
              </Link>
            )}
          </span>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-start gap-3">
          {/* Left column: Avatar + Connecting Line */}
          <div className="flex flex-col items-center self-stretch">
            <Link
              href={getProfileUrl(displayAuthorId, null)}
              className="shrink-0 transition-opacity hover:opacity-80"
              onClick={(e) => e.stopPropagation()}
            >
              <Avatar
                id={displayAuthorId}
                name={displayAuthorName}
                type={post.type === "article" ? "business" : "actor"}
                size="md"
                src={displayAuthorProfileImageUrl || undefined}
                scaleFactor={fontSize}
              />
            </Link>
            {/* Connecting line to comments */}
            {showCommentPreviews &&
              !isDetail &&
              (post.commentPreviews?.length ?? 0) > 0 && (
                <div className="mt-2 w-0.5 flex-1 bg-border" />
              )}
          </div>

          {/* Header only — body text is full-width below (matches quote card alignment). */}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3 leading-none sm:items-center sm:pt-0.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link
                    href={getProfileUrl(displayAuthorId, null)}
                    className="truncate font-semibold text-[15px] text-foreground leading-tight hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {displayAuthorName}
                  </Link>
                  {showVerifiedBadge && <VerifiedBadge size="sm" />}
                </div>
                <Link
                  href={getProfileUrl(displayAuthorId, null)}
                  className="truncate text-[15px] text-muted-foreground leading-tight hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  @{displayAuthorUsername || displayAuthorId}
                </Link>
              </div>
              <div className="flex items-start gap-2 sm:items-center">
                <time
                  className="text-[15px] text-muted-foreground leading-tight"
                  title={postDate.toLocaleString()}
                >
                  {timeAgo}
                </time>
                {user && user.id !== displayAuthorId && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <ModerationMenu
                      targetUserId={displayAuthorId}
                      targetUsername={displayAuthorUsername || undefined}
                      targetDisplayName={displayAuthorName}
                      targetProfileImageUrl={
                        displayAuthorProfileImageUrl || undefined
                      }
                      postId={post.id}
                      isNPC={authorIsNPC}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Primary post body — full width, same inset as quote card */}
        {post.type === "article" ? (
          <div className="w-full">
            <div className="mb-3 flex items-start justify-between gap-4">
              <h2 className="flex-1 font-bold text-foreground text-lg leading-tight sm:text-xl">
                {post.articleTitle || "Untitled Article"}
              </h2>
              {!isDetail && (
                <button
                  className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-primary px-3 py-2 font-semibold text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                  onClick={handleCardClick}
                >
                  Read Full Article →
                </button>
              )}
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-muted-foreground text-sm">
              {post.byline && <span>{post.byline}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words text-[15px] text-foreground leading-normal">
              {post.content}
            </div>
          </div>
        ) : post.isRepost && isSimpleRepost ? (
          <div className="post-content w-full whitespace-pre-wrap break-words text-[15px] text-foreground leading-normal">
            {post.originalPost ? (
              <TaggedText
                text={post.originalPost.content}
                onTagClick={handleTaggedTextClick}
              />
            ) : (
              <span className="text-foreground/50 italic">
                This post has been deleted
              </span>
            )}
          </div>
        ) : post.isRepost ? (
          post.quoteComment ? (
            <div className="post-content whitespace-pre-wrap break-words text-[15px] text-foreground leading-normal">
              <TaggedText
                text={post.quoteComment}
                onTagClick={handleTaggedTextClick}
              />
            </div>
          ) : null
        ) : (
          <div className="post-content w-full whitespace-pre-wrap break-words text-[15px] text-foreground leading-normal">
            <TaggedText
              text={post.content || ""}
              onTagClick={handleTaggedTextClick}
            />
          </div>
        )}

        {/* Quote card gets its own full-width row under the avatar lane. */}
        {post.isRepost && !isSimpleRepost && (
          <div
            className={cn(
              "rounded-xl border border-border p-4",
              "overflow-hidden transition-colors",
              quotedPostId
                ? "cursor-pointer hover:bg-muted/50"
                : "cursor-default",
            )}
            role={quotedPostId ? "link" : undefined}
            tabIndex={quotedPostId ? 0 : undefined}
            aria-label={quotedPostId ? "View quoted post" : undefined}
            onClick={quotedPostId ? handleQuotedPostClick : undefined}
            onKeyDown={quotedPostId ? handleQuotedPostKeyDown : undefined}
          >
            {post.originalPost ? (
              <>
                {/* Original post author */}
                <div className="mb-2 flex items-start gap-2">
                  <Link
                    href={getProfileUrl(post.originalPost.authorId, null)}
                    className="shrink-0 transition-opacity hover:opacity-80"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Avatar
                      id={post.originalPost.authorId}
                      name={post.originalPost.authorName}
                      type="actor"
                      size="sm"
                      className="!h-5 !w-5"
                      src={post.originalPost.authorProfileImageUrl || undefined}
                    />
                  </Link>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1">
                      <Link
                        href={getProfileUrl(post.originalPost.authorId, null)}
                        className="truncate font-semibold text-foreground text-sm hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {post.originalPost.authorName}
                      </Link>
                      {isNpcIdentifier(post.originalPost.authorId) && (
                        <VerifiedBadge size="sm" />
                      )}
                    </div>
                    <Link
                      href={getProfileUrl(post.originalPost.authorId, null)}
                      className="truncate text-foreground/50 text-sm hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      @
                      {post.originalPost.authorUsername ||
                        post.originalPost.authorId}
                    </Link>
                  </div>
                </div>

                {/* Original post content */}
                <div className="whitespace-pre-wrap break-words text-[15px] text-foreground/90 leading-normal">
                  <TaggedText
                    text={post.originalPost.content}
                    onTagClick={handleTaggedTextClick}
                  />
                </div>
              </>
            ) : (
              <div className="py-4 text-center text-foreground/50 italic">
                This post has been deleted
              </div>
            )}
          </div>
        )}

        {/* Interaction Bar */}
        {showInteractions && (
          <div onClick={(e) => e.stopPropagation()}>
            <InteractionBar
              postId={post.id}
              initialInteractions={initialInteractions}
              onCommentClick={onCommentClick}
              onLikeChange={onLikeChange}
              onShareChange={onShareChange}
              postData={post}
              className="!mt-0"
            />
          </div>
        )}
      </div>

      {/* Comment Section - Outside two-column layout so avatars align */}
      {showCommentPreviews && !isDetail && (
        <CommentPreview
          comments={post.commentPreviews ?? []}
          totalCommentCount={post.commentCount ?? 0}
          onViewAllClick={onCommentClick ?? handleCardClick}
          showInputBar={showCommentInputBar}
        />
      )}
    </article>
  );
});
