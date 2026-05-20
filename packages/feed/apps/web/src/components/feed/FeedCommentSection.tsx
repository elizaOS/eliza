'use client';

import type { CommentData, CommentWithReplies } from '@feed/shared';
import { cn, getProfileUrl } from '@feed/shared';
import { MessageCircle, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommentCard } from '@/components/interactions/CommentCard';
import { CommentInput } from '@/components/interactions/CommentInput';
import { Avatar } from '@/components/shared/Avatar';
import { EmptyState } from '@/components/shared/EmptyState';
import { Skeleton } from '@/components/shared/Skeleton';
import { TaggedText } from '@/components/shared/TaggedText';
import {
  isNpcIdentifier,
  VerifiedBadge,
} from '@/components/shared/VerifiedBadge';
import { useAuth } from '@/hooks/useAuth';
import { useInteractionStore } from '@/stores/interactionStore';
import { apiUrl } from '@/utils/api-url';

type PostPreviewData = {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string | null;
  authorProfileImageUrl?: string | null;
  timestamp: string;
};

function PostPreview({ post }: { post: PostPreviewData }) {
  const router = useRouter();

  const postDate = new Date(post.timestamp);
  const now = new Date();

  // Defensive check for invalid timestamps
  const isValidDate =
    !isNaN(postDate.getTime()) && isFinite(postDate.getTime());

  let timeAgo: string;
  if (!isValidDate) {
    timeAgo = 'Unknown time';
  } else {
    // Clamp to 0 to handle future timestamps deterministically (treat as "Just now")
    const diffMs = Math.max(0, now.getTime() - postDate.getTime());
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    timeAgo =
      diffMinutes < 1
        ? 'Just now'
        : diffMinutes < 60
          ? `${diffMinutes}m ago`
          : diffHours < 24
            ? `${diffHours}h ago`
            : postDate.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year:
                  postDate.getFullYear() !== now.getFullYear()
                    ? 'numeric'
                    : undefined,
              });
  }

  const authorIsNPC = isNpcIdentifier(post.authorId);

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
    <article className="w-full overflow-hidden rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="space-y-3">
        {/* Row 1: avatar + header only — body is full width below (matches PostCard) */}
        <div className="flex w-full items-start gap-3">
          <Link
            href={getProfileUrl(post.authorId, null)}
            className="shrink-0 transition-opacity hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar
              id={post.authorId}
              name={post.authorName}
              type="actor"
              size="sm"
              src={post.authorProfileImageUrl || undefined}
            />
          </Link>

          <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-1.5">
                <Link
                  href={getProfileUrl(post.authorId, null)}
                  className="truncate font-semibold text-foreground hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {post.authorName}
                </Link>
                {authorIsNPC && <VerifiedBadge size="sm" />}
              </div>
              <Link
                href={getProfileUrl(post.authorId, null)}
                className="truncate text-foreground/50 text-sm hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                @{post.authorUsername || post.authorId}
              </Link>
            </div>

            <time
              className="shrink-0 text-foreground/50 text-sm"
              title={isValidDate ? postDate.toLocaleString() : 'Unknown time'}
            >
              {timeAgo}
            </time>
          </div>
        </div>

        <div className="whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">
          <TaggedText
            text={post.content || ''}
            onTagClick={handleTaggedTextClick}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * Feed comment section component for displaying post comments.
 *
 * Displays a post with its comments in a modal or inline view. Supports
 * nested replies, comment sorting (newest, oldest, popular), and comment
 * management (edit, delete). Handles body scroll lock and escape key when
 * used as a modal.
 *
 * Features:
 * - Post display with interactions
 * - Comment list with nested replies
 * - Comment input for new comments
 * - Comment sorting options
 * - Edit and delete functionality
 * - Loading states
 *
 * @param props - FeedCommentSection component props
 * @returns Feed comment section element
 *
 * @example
 * ```tsx
 * <FeedCommentSection
 *   postId="post-123"
 *   postData={post}
 *   onClose={() => setShowComments(false)}
 * />
 * ```
 */
interface FeedCommentSectionProps {
  postId: string | null;
  postData?: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername?: string | null;
    authorProfileImageUrl?: string | null;
    timestamp: string;
    likeCount: number;
    commentCount: number;
    shareCount: number;
    isLiked: boolean;
    isShared: boolean;
  };
  onClose?: () => void;
}

export function FeedCommentSection({
  postId,
  postData,
  onClose,
}: FeedCommentSectionProps) {
  const { user } = useAuth();
  const router = useRouter();
  const [comments, setComments] = useState<CommentWithReplies[]>([]);
  const [post, setPost] = useState<{
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername?: string | null;
    authorProfileImageUrl?: string | null;
    timestamp: string;
    likeCount: number;
    commentCount: number;
    shareCount: number;
    isLiked: boolean;
    isShared: boolean;
  } | null>(postData || null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingPost, setIsLoadingPost] = useState(false);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'popular'>(
    'newest'
  );

  const { loadComments, editComment, deleteComment } = useInteractionStore();

  // Handle escape key and body scroll lock for modal
  useEffect(() => {
    if (!onClose) return; // Only for modal mode

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  // Load comments data function - defined before useEffect that uses it
  const loadCommentsData = useCallback(async () => {
    if (!postId) return;

    setIsLoading(true);
    const loadedComments = await loadComments(postId);
    setComments(loadedComments);
    setIsLoading(false);
  }, [postId, loadComments]);

  // Load post data when postId changes
  useEffect(() => {
    const loadPostData = async () => {
      if (!postId) {
        setPost(null);
        return;
      }

      // Use provided postData if available
      if (postData) {
        setPost(postData);
        return;
      }

      setIsLoadingPost(true);
      const response = await fetch(apiUrl(`/api/posts/${postId}`));
      if (response.ok) {
        const result = await response.json();
        setPost(result.data);
      }
      setIsLoadingPost(false);
    };

    loadPostData();
  }, [postId, postData]);

  // Update internal post state when postData prop changes
  useEffect(() => {
    if (postData) {
      setPost(postData);
    }
  }, [postData]);

  // Load comments when postId changes
  useEffect(() => {
    if (postId) {
      loadCommentsData();
    } else {
      setComments([]);
    }
  }, [postId, loadCommentsData]);

  // Reload comments when comment count changes (e.g., from SSE updates)
  useEffect(() => {
    if (post?.commentCount !== undefined && postId) {
      loadCommentsData();
    }
  }, [post?.commentCount, postId, loadCommentsData]);

  // Helper functions
  const removeCommentById = (
    commentList: CommentWithReplies[],
    commentId: string
  ): CommentWithReplies[] => {
    return commentList
      .filter((comment) => comment.id !== commentId)
      .map((comment) => ({
        ...comment,
        replies: removeCommentById(comment.replies, commentId),
      }));
  };

  const addReplyToComment = (
    commentList: CommentWithReplies[],
    parentCommentId: string,
    newReply: CommentWithReplies
  ): CommentWithReplies[] => {
    return commentList.map((comment) => {
      if (comment.id === parentCommentId) {
        return {
          ...comment,
          replies: [newReply, ...comment.replies],
        };
      }
      if (comment.replies.length > 0) {
        return {
          ...comment,
          replies: addReplyToComment(
            comment.replies,
            parentCommentId,
            newReply
          ),
        };
      }
      return comment;
    });
  };

  const findParentAuthorName = (
    commentList: CommentWithReplies[],
    parentCommentId: string
  ): string | undefined => {
    for (const comment of commentList) {
      if (comment.id === parentCommentId) {
        return comment.userName;
      }
      if (comment.replies.length > 0) {
        const found = findParentAuthorName(comment.replies, parentCommentId);
        if (found) return found;
      }
    }
    return undefined;
  };

  const handleEdit = async (commentId: string, content: string) => {
    await editComment(commentId, content);
    await loadCommentsData();
  };

  const handleDelete = async (commentId: string) => {
    if (!postId) return;
    await deleteComment(commentId, postId);
    setComments((prev) => removeCommentById(prev, commentId));
  };

  const handleReplySubmit = async (
    replyComment: CommentData,
    parentCommentId: string
  ) => {
    if (!postId) return;

    const parentAuthorName = findParentAuthorName(comments, parentCommentId);

    const optimisticReply: CommentWithReplies = {
      id: replyComment.id,
      content: replyComment.content,
      createdAt:
        replyComment.createdAt instanceof Date
          ? replyComment.createdAt
          : new Date(replyComment.createdAt),
      updatedAt:
        replyComment.updatedAt instanceof Date
          ? replyComment.updatedAt
          : new Date(replyComment.updatedAt),
      userId: replyComment.authorId,
      userName:
        replyComment.author?.displayName ||
        replyComment.author?.username ||
        'Unknown',
      userUsername: replyComment.author?.username || null,
      userAvatar: replyComment.author?.profileImageUrl || undefined,
      parentCommentId: replyComment.parentCommentId,
      parentCommentAuthorName: parentAuthorName,
      likeCount: replyComment.likeCount ?? 0,
      isLiked: false,
      replies: [],
    };

    setComments((prev) =>
      addReplyToComment(prev, parentCommentId, optimisticReply)
    );
    // Brief delay to allow the optimistic update to render before
    // fetching server data, preventing visual jank from rapid state changes
    await new Promise((resolve) => setTimeout(resolve, 200));
    await loadCommentsData();
  };

  const handleTopLevelCommentSubmit = async (commentData: CommentData) => {
    if (!postId) return;

    const optimisticComment: CommentWithReplies = {
      id: commentData.id,
      content: commentData.content,
      createdAt:
        commentData.createdAt instanceof Date
          ? commentData.createdAt
          : new Date(commentData.createdAt),
      updatedAt:
        commentData.updatedAt instanceof Date
          ? commentData.updatedAt
          : new Date(commentData.updatedAt),
      userId: commentData.authorId,
      userName:
        commentData.author?.displayName ||
        commentData.author?.username ||
        'Unknown',
      userUsername: commentData.author?.username || null,
      userAvatar: commentData.author?.profileImageUrl || undefined,
      parentCommentId: undefined,
      parentCommentAuthorName: undefined,
      likeCount: commentData.likeCount ?? 0,
      isLiked: false,
      replies: [],
    };

    setComments((prev) => [optimisticComment, ...prev]);

    // If it's a modal, close it and navigate to post page
    if (onClose) {
      // Close modal and navigate - the post page will load fresh data
      onClose();
      router.push(`/post/${postId}`);
    }
    // If not modal (inline view on post page), the comment count change
    // will trigger the useEffect that watches post.commentCount,
    // which will automatically reload comments
  };

  const sortedComments = useMemo(() => {
    return [...comments].sort((a, b) => {
      // Always prioritize current user's comments at the top
      const aIsCurrentUser = user && a.userId === user.id;
      const bIsCurrentUser = user && b.userId === user.id;

      if (aIsCurrentUser && !bIsCurrentUser) return -1;
      if (!aIsCurrentUser && bIsCurrentUser) return 1;

      // For non-user comments (or both are user comments), apply the selected sort
      switch (sortBy) {
        case 'newest':
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        case 'oldest':
          return (
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        case 'popular':
          return b.likeCount - a.likeCount;
        default:
          return 0;
      }
    });
  }, [comments, user, sortBy]);

  if (!postId) {
    return null;
  }

  if (isLoadingPost) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden bg-background">
        <div className="w-full max-w-md space-y-3 p-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }

  if (!post) {
    return null;
  }

  // If onClose is provided, it's a modal (mobile). Otherwise, it's inline (desktop post page)
  const isModal = !!onClose;

  return (
    <>
      {/* Backdrop for modal only */}
      {isModal && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      {/* Modal Container - centered on desktop */}
      {isModal ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]">
          <div
            className={cn(
              'pointer-events-auto relative w-full max-w-[700px] rounded-2xl bg-background shadow-2xl',
              'fade-in-0 zoom-in-95 animate-in duration-200',
              'flex max-h-[85vh] flex-col'
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-4 border-border border-b px-4 py-3">
              <button
                type="button"
                onClick={onClose}
                className="-ml-2 rounded-full p-2 transition-colors hover:bg-muted"
                aria-label="Close"
              >
                <X size={20} />
              </button>
              <div className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-[#0066FF]" />
                <h2 className="font-semibold text-base">Reply</h2>
              </div>
              <div className="w-10" /> {/* Spacer for centering */}
            </div>

            {/* Content - scrollable */}
            <div className="flex-1 overflow-y-auto">
              {/* Original Post - Compact preview */}
              <div className="px-4 pt-3">
                <PostPreview post={post} />
              </div>

              {/* Visual thread connector */}
              <div className="px-4">
                <div className="ml-6 h-4 border-border border-l-2" />
              </div>

              {/* Comment Input */}
              <div className="px-4 pb-4">
                <CommentInput
                  postId={postId}
                  placeholder={`Reply to ${post.authorName}...`}
                  autoFocus
                  onSubmit={handleTopLevelCommentSubmit}
                  className="mt-2"
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Non-modal inline view (for post detail page) */
        <div className="relative flex w-full flex-col overflow-hidden bg-background">
          {/* Sort options */}
          {comments.length > 1 && (
            <div className="flex shrink-0 items-center gap-2 bg-background px-4 py-2">
              <span className="text-muted-foreground text-xs">Sort:</span>
              <div className="flex gap-1">
                {(['newest', 'oldest', 'popular'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setSortBy(option)}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs capitalize transition-colors',
                      sortBy === option
                        ? 'bg-[#0066FF] text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Comments list */}
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center px-4 py-8">
                <div className="w-full space-y-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              </div>
            ) : sortedComments.length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title="No comments yet"
                description="Be the first to comment!"
              />
            ) : (
              <div>
                {sortedComments.map((comment) => (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    postId={postId || ''}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onReplySubmit={(replyComment: CommentData) => {
                      if (replyComment.parentCommentId) {
                        handleReplySubmit(
                          replyComment,
                          replyComment.parentCommentId
                        );
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
