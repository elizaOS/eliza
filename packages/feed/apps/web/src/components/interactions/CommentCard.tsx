'use client';

import type { CommentCardProps, CommentData } from '@babylon/shared';
import { cn, getProfileUrl } from '@babylon/shared';
import {
  Edit2,
  MessageCircle,
  MoreHorizontal,
  Repeat2,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ModerationMenu } from '@/components/moderation/ModerationMenu';
import { formatTimeAgo } from '@/components/posts/CommentPreview';
import { Avatar } from '@/components/shared/Avatar';
import { TaggedText } from '@/components/shared/TaggedText';
import {
  isNpcIdentifier,
  VerifiedBadge,
} from '@/components/shared/VerifiedBadge';
import { useAuth } from '@/hooks/useAuth';
import { useMenuPosition } from '@/hooks/useMenuPosition';
import { MAX_REPLY_COUNT } from '@/lib/constants';
import { CommentInput } from './CommentInput';
import { LikeButton } from './LikeButton';

// Menu dimensions for edit/delete dropdown
const MENU_HEIGHT = 100;
const MENU_WIDTH = 120;

/**
 * Recursive reply type for counting
 */
interface ReplyWithReplies {
  replies?: ReplyWithReplies[];
}

/**
 * Count total replies recursively
 */
function countAllReplies(replies: ReplyWithReplies[]): number {
  let count = replies.length;
  for (const reply of replies) {
    if (reply.replies && reply.replies.length > 0) {
      count += countAllReplies(reply.replies);
    }
  }
  return count;
}

/**
 * Comment card component for displaying comments with Twitter-like threading.
 *
 * Displays a comment with user avatar, content, timestamp, and actions
 * (like, reply, edit, delete). Uses page-based navigation for replies -
 * clicking the reply count navigates to a dedicated comment thread page.
 *
 * @param props - CommentCard component props
 * @returns Comment card element
 *
 * @example
 * ```tsx
 * <CommentCard
 *   comment={commentData}
 *   postId="post-123"
 *   onReply={handleReply}
 *   onEdit={handleEdit}
 *   onDelete={handleDelete}
 * />
 * ```
 */
export function CommentCard({
  comment,
  postId,
  onReply,
  onEdit,
  onDelete,
  onReplySubmit,
  className,
}: CommentCardProps) {
  const router = useRouter();
  const { user, authenticated, login } = useAuth();
  const [showActions, setShowActions] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);

  // Use custom hook for menu positioning
  const {
    buttonRef: actionButtonRef,
    menuPosition,
    updatePosition,
    mounted,
  } = useMenuPosition(showActions, {
    menuHeight: MENU_HEIGHT,
    menuWidth: MENU_WIDTH,
    padding: 4,
  });

  const hasReplies = comment.replies && comment.replies.length > 0;
  const replyCount = hasReplies ? countAllReplies(comment.replies) : 0;

  const showVerifiedBadge = isNpcIdentifier(comment.userId);
  const isOwnComment = user?.id === comment.userId;
  const authorIsNPC = isNpcIdentifier(comment.userId);

  const handleReply = () => {
    if (!authenticated) {
      login();
      return;
    }
    setIsReplying(true);
    if (onReply) {
      onReply(comment.id);
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
    setShowActions(false);
  };

  const handleSaveEdit = () => {
    if (onEdit && editContent.trim() !== comment.content) {
      onEdit(comment.id, editContent.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditContent(comment.content);
    setIsEditing(false);
  };

  const handleDelete = () => {
    if (onDelete && confirm('Are you sure you want to delete this comment?')) {
      onDelete(comment.id);
    }
    setShowActions(false);
  };

  // Navigate to comment thread page
  const handleNavigateToThread = () => {
    router.push(`/comment/${comment.id}`);
  };

  const handleTaggedTextClick = (tag: string) => {
    if (tag.startsWith('@')) {
      const username = tag.slice(1);
      router.push(getProfileUrl('', username));
      return;
    }
    if (tag.startsWith('$')) {
      const symbol = tag.slice(1);
      router.push(`/markets?search=${encodeURIComponent(symbol)}`);
    }
  };

  return (
    <div
      className={cn(
        'border-border border-b px-4 py-4',
        'cursor-pointer transition-all duration-200 hover:bg-muted/30',
        className
      )}
      onClick={handleNavigateToThread}
    >
      <div className="space-y-3">
        {/* Row 1: avatar + header only (matches PostCard) */}
        <div className="flex items-start gap-3">
          <Link
            href={getProfileUrl(comment.userId, comment.userUsername)}
            className="shrink-0 transition-opacity hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar
              id={comment.userId}
              name={comment.userName}
              size="md"
              src={comment.userAvatar || undefined}
              imageUrl={comment.userAvatar || undefined}
            />
          </Link>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3 leading-none sm:items-center sm:pt-0.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link
                    href={getProfileUrl(comment.userId, comment.userUsername)}
                    className="truncate font-semibold text-[15px] text-foreground leading-tight hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {comment.userName}
                  </Link>
                  {showVerifiedBadge && <VerifiedBadge size="sm" />}
                </div>
                <Link
                  href={getProfileUrl(comment.userId, comment.userUsername)}
                  className="truncate text-[15px] text-muted-foreground leading-tight hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  @{comment.userUsername || comment.userName}
                </Link>
              </div>
              <div className="flex items-start gap-2 sm:items-center">
                <span className="text-[15px] text-muted-foreground leading-tight">
                  {formatTimeAgo(new Date(comment.createdAt).toISOString())}
                </span>

                {isOwnComment ? (
                  <div
                    className="relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      ref={actionButtonRef}
                      type="button"
                      onClick={() => {
                        if (!showActions) {
                          updatePosition();
                        }
                        setShowActions(!showActions);
                      }}
                      className="rounded-lg p-2 transition-colors hover:bg-muted"
                      aria-label="More options"
                    >
                      <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
                    </button>

                    {showActions &&
                      mounted &&
                      createPortal(
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => setShowActions(false)}
                          />

                          <div
                            className="fade-in slide-in-from-top-2 fixed z-50 min-w-[120px] animate-in rounded-md border border-border bg-popover py-1 shadow-lg duration-150"
                            style={{
                              top: menuPosition.openUpward
                                ? 'auto'
                                : menuPosition.top,
                              bottom: menuPosition.openUpward
                                ? menuPosition.windowHeight - menuPosition.top
                                : 'auto',
                              left: menuPosition.left,
                            }}
                          >
                            <button
                              type="button"
                              onClick={handleEdit}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                            >
                              <Edit2 size={14} />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={handleDelete}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-destructive text-sm transition-colors hover:bg-muted"
                            >
                              <Trash2 size={14} />
                              Delete
                            </button>
                          </div>
                        </>,
                        document.body
                      )}
                  </div>
                ) : user ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <ModerationMenu
                      targetUserId={comment.userId}
                      targetUsername={comment.userUsername || undefined}
                      targetDisplayName={comment.userName}
                      targetProfileImageUrl={comment.userAvatar || undefined}
                      isNPC={authorIsNPC}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Full-width: reply context, body, actions (aligned with PostCard body) */}
        {comment.parentCommentId && comment.parentCommentAuthorName && (
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <span>Replying to</span>
            <span className="font-medium text-primary">
              @{comment.parentCommentAuthorName}
            </span>
          </div>
        )}

        {isEditing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[60px] w-full resize-none rounded-md border border-border bg-muted p-2 text-sm focus:border-border focus:outline-none"
              autoFocus
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={!editContent.trim()}
                className="rounded-md bg-primary px-3 py-1 text-primary-foreground text-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={handleCancelEdit}
                className="px-3 py-1 text-muted-foreground text-sm transition-colors hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-foreground text-sm">
            <TaggedText
              text={comment.content}
              onTagClick={handleTaggedTextClick}
            />
          </p>
        )}

        <div
          className="flex w-full items-center justify-between px-8 text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleReply}
            className={cn(
              'flex items-center gap-1',
              'bg-transparent transition-all duration-200 hover:opacity-70',
              'cursor-pointer text-muted-foreground text-xs',
              isReplying && 'text-[#0066FF]'
            )}
          >
            <MessageCircle size={18} />
            {hasReplies && (
              <span className="font-medium tabular-nums">
                {replyCount >= MAX_REPLY_COUNT
                  ? `${MAX_REPLY_COUNT}+`
                  : replyCount}
              </span>
            )}
          </button>

          <div>
            <button
              type="button"
              disabled
              className="flex cursor-default items-center gap-1 text-muted-foreground/40 text-xs"
            >
              <Repeat2 size={18} />
            </button>
          </div>

          <div>
            <LikeButton
              targetId={comment.id}
              targetType="comment"
              initialLiked={comment.isLiked}
              initialCount={comment.likeCount}
              size="sm"
              showCount
            />
          </div>
        </div>

        {isReplying && (
          <div onClick={(e) => e.stopPropagation()}>
            <CommentInput
              postId={postId}
              parentCommentId={comment.id}
              placeholder={`Reply to ${comment.userName}...`}
              replyingToName={comment.userName}
              autoFocus
              onSubmit={async (replyComment: CommentData) => {
                setIsReplying(false);
                if (onReplySubmit && replyComment) {
                  onReplySubmit(replyComment);
                }
              }}
              onCancel={() => setIsReplying(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
