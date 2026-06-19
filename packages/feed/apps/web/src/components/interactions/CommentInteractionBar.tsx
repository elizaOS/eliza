"use client";

import { cn } from "@feed/shared";
import { MessageCircle, Repeat2 } from "lucide-react";
import { memo } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLoginModal } from "@/hooks/useLoginModal";
import { LikeButton } from "./LikeButton";

/**
 * Props for CommentInteractionBar component.
 */
export interface CommentInteractionBarProps {
  commentId: string;
  likeCount?: number;
  isLiked?: boolean;
  replyCount?: number;
  onReplyClick?: () => void;
  onRepostClick?: () => void;
  className?: string;
}

/**
 * Compact interaction bar for comments.
 *
 * Displays like, reply, and repost buttons in a compact format
 * suitable for inline comment displays. Reuses existing button
 * components for consistency.
 *
 * @example
 * ```tsx
 * <CommentInteractionBar
 *   commentId="comment-123"
 *   likeCount={5}
 *   isLiked={false}
 *   onReplyClick={() => openReplyInput()}
 * />
 * ```
 */
export const CommentInteractionBar = memo(function CommentInteractionBar({
  commentId,
  likeCount = 0,
  isLiked = false,
  replyCount = 0,
  onReplyClick,
  onRepostClick,
  className,
}: CommentInteractionBarProps) {
  const { authenticated } = useAuth();
  const { showLoginModal } = useLoginModal();

  const handleReplyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!authenticated) {
      showLoginModal({
        title: "Login to Reply",
        message: "Log in to reply to comments and engage with the community.",
      });
      return;
    }
    onReplyClick?.();
  };

  const handleRepostClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!authenticated) {
      showLoginModal({
        title: "Login to Repost",
        message: "Log in to share comments with your followers.",
      });
      return;
    }
    onRepostClick?.();
  };

  return (
    <div
      className={cn(
        "mt-2 flex w-full items-center justify-between text-muted-foreground",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Reply button */}
      <button
        type="button"
        onClick={handleReplyClick}
        className={cn(
          "flex items-center gap-1",
          "bg-transparent transition-all duration-200 hover:opacity-70",
          "cursor-pointer text-muted-foreground text-xs",
        )}
        aria-label="Reply to comment"
      >
        <MessageCircle size={18} />
        {replyCount > 0 && (
          <span className="font-medium tabular-nums">{replyCount}</span>
        )}
      </button>

      {/* Repost button */}
      <div>
        <button
          type="button"
          onClick={onRepostClick ? handleRepostClick : undefined}
          disabled={!onRepostClick}
          className={cn(
            "flex items-center gap-1 text-xs",
            onRepostClick
              ? "cursor-pointer bg-transparent text-muted-foreground transition-all duration-200 hover:opacity-70"
              : "cursor-default text-muted-foreground/40",
          )}
          aria-label="Repost comment"
        >
          <Repeat2 size={18} />
        </button>
      </div>

      {/* Like button */}
      <div>
        <LikeButton
          targetId={commentId}
          targetType="comment"
          initialLiked={isLiked}
          initialCount={likeCount}
          size="sm"
          showCount
        />
      </div>
    </div>
  );
});
