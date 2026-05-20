'use client';

import type { CommentPreviewData } from '@feed/shared';
import { cn, getProfileUrl } from '@feed/shared';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo } from 'react';
import { CommentInteractionBar } from '@/components/interactions';
import { Avatar } from '@/components/shared/Avatar';
import {
  isNpcIdentifier,
  VerifiedBadge,
} from '@/components/shared/VerifiedBadge';

// Re-export for convenience
export type { CommentPreviewData } from '@feed/shared';

interface CommentPreviewProps {
  comments: CommentPreviewData[];
  totalCommentCount: number;
  onViewAllClick?: () => void;
  showInputBar?: boolean;
  className?: string;
}

/**
 * Inline comment preview component for post cards.
 *
 * Displays 1-2 top comments based on engagement directly on the feed,
 * similar to how social platforms show engagement context.
 * High-engagement posts (50+ comments) show 2 previews, others show 1.
 *
 * Features:
 * - Avatar + name/handle + timestamp layout
 * - Full comment content display
 * - Verified badges for NPCs
 * - "View all comments" link
 * - Inline comment input bar
 *
 * @example
 * ```tsx
 * <CommentPreview
 *   comments={topComments}
 *   totalCommentCount={15}
 *   onViewAllClick={() => openComments()}
 * />
 * ```
 */
export const CommentPreview = memo(function CommentPreview({
  comments,
  totalCommentCount,
  onViewAllClick,
  showInputBar = true,
  className,
}: CommentPreviewProps) {
  // Type-safe check: comments is always an array (required prop)
  const hasComments = comments.length > 0;

  // Don't render anything if no comments and input bar is hidden
  if (!hasComments && !showInputBar) return null;

  const showViewAll = hasComments && totalCommentCount > comments.length;

  return (
    <div className={cn('mt-3', className)} onClick={(e) => e.stopPropagation()}>
      {/* Comment list - only show if there are comments */}
      {hasComments && (
        <div className="space-y-3">
          {comments.map((comment) => (
            <CommentPreviewItem
              key={comment.id}
              comment={comment}
              onClick={onViewAllClick}
            />
          ))}
        </div>
      )}

      {/* View all comments link - only show if there are more comments than previewed */}
      {showViewAll && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewAllClick?.();
          }}
          className="mt-3 text-primary text-sm transition-colors hover:underline"
        >
          View all {totalCommentCount} comments
        </button>
      )}

      {/* Comment input bar - shown when showInputBar is true */}
      {showInputBar && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewAllClick?.();
          }}
          className={cn(
            'mt-3 w-full rounded-full border border-border/20 bg-muted',
            'px-4 py-2 text-left text-muted-foreground text-sm',
            'hover:bg-muted/80',
            'cursor-text transition-colors'
          )}
        >
          Leave a comment...
        </button>
      )}
    </div>
  );
});

/**
 * Individual comment preview item - two-column layout matching post style
 */
const CommentPreviewItem = memo(function CommentPreviewItem({
  comment,
  onClick,
}: {
  comment: CommentPreviewData;
  onClick?: () => void;
}) {
  const router = useRouter();
  const isNPC = isNpcIdentifier(comment.userId);
  const timeAgo = formatTimeAgo(comment.createdAt);

  return (
    <div
      className="flex cursor-pointer gap-3"
      onClick={(e) => {
        e.stopPropagation();
        router.push(`/comment/${comment.id}`);
      }}
    >
      {/* Left column: Avatar */}
      <div className="flex flex-col items-center">
        <Link
          href={getProfileUrl(comment.userId, comment.userUsername)}
          className="shrink-0 transition-opacity hover:opacity-80"
          onClick={(e) => e.stopPropagation()}
        >
          <Avatar
            id={comment.userId}
            name={comment.userName}
            type="actor"
            size="md"
            src={comment.userAvatar || undefined}
          />
        </Link>
      </div>

      {/* Right column: Content */}
      <div className="min-w-0 flex-1">
        {/* Header: Name + Username + Time */}
        <div className="flex items-start justify-between gap-3 leading-none sm:items-center sm:pt-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Link
              href={getProfileUrl(comment.userId, comment.userUsername)}
              className="truncate font-semibold text-[15px] text-foreground leading-tight hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {comment.userName}
            </Link>
            {isNPC && <VerifiedBadge size="sm" />}
            {comment.userUsername && (
              <span className="truncate text-[15px] text-muted-foreground leading-tight">
                @{comment.userUsername}
              </span>
            )}
          </div>
          {timeAgo && (
            <span className="text-[15px] text-muted-foreground leading-tight">
              {timeAgo}
            </span>
          )}
        </div>

        {/* Comment content */}
        <p className="text-foreground text-sm leading-relaxed">
          {comment.content}
        </p>

        {/* Interaction bar */}
        <CommentInteractionBar
          commentId={comment.id}
          likeCount={comment.likeCount}
          isLiked={comment.isLiked}
          onReplyClick={onClick}
        />
      </div>
    </div>
  );
});

/**
 * Format timestamp to relative time with suffix (e.g., "5m ago", "2h ago", "just now")
 * Exported for unit testing.
 */
export function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;

  return formatDistanceToNow(date, { addSuffix: true });
}
