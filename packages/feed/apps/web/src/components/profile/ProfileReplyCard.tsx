'use client';

import { getProfileUrl } from '@feed/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CommentInput } from '@/components/interactions/CommentInput';
import { CommentInteractionBar } from '@/components/interactions/CommentInteractionBar';
import { InteractionBar } from '@/components/interactions/InteractionBar';
import { formatTimeAgo } from '@/components/posts/CommentPreview';
import { Avatar } from '@/components/shared/Avatar';
import { TaggedText } from '@/components/shared/TaggedText';
import {
  isNpcIdentifier,
  VerifiedBadge,
} from '@/components/shared/VerifiedBadge';

/**
 * Author info structure
 */
interface AuthorInfo {
  id?: string;
  displayName?: string | null;
  username?: string | null;
  profileImageUrl?: string | null;
}

/**
 * Reply data structure from the API
 */
export interface ProfileReply {
  id: string;
  content: string;
  postId: string;
  parentCommentId?: string | null;
  createdAt: string;
  updatedAt: string;
  likeCount: number;
  replyCount: number;
  isLiked: boolean;
  // Parent comment (if replying to a comment)
  parentComment?: {
    id: string;
    content: string;
    authorId: string;
    createdAt: string;
    author?: AuthorInfo | null;
    likeCount?: number;
    replyCount?: number;
    isLiked?: boolean;
  } | null;
  // Original post
  post: {
    id: string;
    content: string;
    authorId: string;
    timestamp: string;
    author?: AuthorInfo | null;
    likeCount?: number;
    commentCount?: number;
    shareCount?: number;
    isLiked?: boolean;
    isShared?: boolean;
  };
}

interface ProfileReplyCardProps {
  reply: ProfileReply;
  /** The profile owner's author ID */
  authorId: string;
  /** The profile owner's display name */
  authorName: string;
  /** The profile owner's username */
  authorUsername: string | null;
  /** The profile owner's profile image URL */
  authorProfileImageUrl: string | null;
  /** Callback when a reply is submitted */
  onReplySubmit?: () => void;
}

/**
 * ProfileReplyCard - Shows a user's reply in their profile with thread-style layout
 *
 * Layout:
 * - Original post/comment (what they replied to) at top with vertical connector line
 * - User's reply below, connected by the line
 * - Action buttons (reply, like) at the bottom
 */
export function ProfileReplyCard({
  reply,
  authorId,
  authorName,
  authorUsername,
  authorProfileImageUrl,
  onReplySubmit,
}: ProfileReplyCardProps) {
  const router = useRouter();
  const [isReplying, setIsReplying] = useState(false);
  const [replyCount, setReplyCount] = useState(reply.replyCount);

  // Determine if we're replying to a comment or directly to a post
  const isReplyToComment = !!reply.parentComment;

  // Get the parent content info (either parent comment or post)
  const parentAuthorId = isReplyToComment
    ? reply.parentComment?.author?.id || reply.parentComment?.authorId || ''
    : reply.post?.author?.id || reply.post?.authorId || '';
  const parentAuthorName = isReplyToComment
    ? reply.parentComment?.author?.displayName ||
      reply.parentComment?.author?.username ||
      'User'
    : reply.post?.author?.displayName || reply.post?.author?.username || 'User';
  const parentAuthorUsername = isReplyToComment
    ? reply.parentComment?.author?.username || null
    : reply.post?.author?.username || null;
  const parentAuthorProfileImageUrl = isReplyToComment
    ? reply.parentComment?.author?.profileImageUrl || null
    : reply.post?.author?.profileImageUrl || null;
  const parentContent = isReplyToComment
    ? reply.parentComment?.content || ''
    : reply.post?.content || '';
  const parentTimestamp = isReplyToComment
    ? reply.parentComment?.createdAt || ''
    : reply.post?.timestamp || '';
  const parentAuthorIsNPC = isNpcIdentifier(parentAuthorId);

  // Reply author (profile owner) info
  const replyAuthorIsNPC = isNpcIdentifier(authorId);

  // Navigation targets
  const parentNavigateUrl = isReplyToComment
    ? `/comment/${reply.parentComment?.id}`
    : `/post/${reply.post.id}`;

  const parentPostInteractions = useMemo(
    () => ({
      postId: reply.post.id,
      likeCount: reply.post.likeCount ?? 0,
      commentCount: reply.post.commentCount ?? 0,
      shareCount: reply.post.shareCount ?? 0,
      isLiked: reply.post.isLiked ?? false,
      isShared: reply.post.isShared ?? false,
    }),
    [
      reply.post.commentCount,
      reply.post.id,
      reply.post.isLiked,
      reply.post.isShared,
      reply.post.likeCount,
      reply.post.shareCount,
    ]
  );

  const parentPostData = useMemo(
    () => ({
      id: reply.post.id,
      content: reply.post.content,
      authorId: reply.post.authorId,
      authorName: parentAuthorName,
      authorUsername: parentAuthorUsername,
      authorProfileImageUrl: parentAuthorProfileImageUrl,
      timestamp: reply.post.timestamp,
      likeCount: reply.post.likeCount,
      commentCount: reply.post.commentCount,
      shareCount: reply.post.shareCount,
      isLiked: reply.post.isLiked,
      isShared: reply.post.isShared,
    }),
    [
      parentAuthorName,
      parentAuthorProfileImageUrl,
      parentAuthorUsername,
      reply.post.authorId,
      reply.post.commentCount,
      reply.post.content,
      reply.post.id,
      reply.post.isLiked,
      reply.post.isShared,
      reply.post.likeCount,
      reply.post.shareCount,
      reply.post.timestamp,
    ]
  );

  const handleTagClick = (tag: string) => {
    if (tag.startsWith('@')) {
      const username = tag.slice(1);
      router.push(getProfileUrl('', username));
    } else if (tag.startsWith('$')) {
      const symbol = tag.slice(1);
      router.push(`/markets?search=${encodeURIComponent(symbol)}`);
    }
  };

  const handleReplySubmit = async () => {
    setIsReplying(false);
    setReplyCount((prev) => prev + 1);
    onReplySubmit?.();
  };

  return (
    <div className="border-border border-b">
      {/* Parent Content - what they replied to (post or comment) */}
      <div className="relative">
        {/* Connector line - from parent avatar down to reply */}
        <div className="absolute top-10 bottom-0 left-[2.1875rem] w-0.5 bg-border sm:left-[2.6875rem]" />

        <div
          className="flex cursor-pointer gap-3 px-4 py-3 transition-colors hover:bg-muted/50 sm:px-6"
          onClick={() => router.push(parentNavigateUrl)}
        >
          {/* Parent Author Avatar */}
          <div className="flex flex-col items-center">
            <Link
              href={getProfileUrl(parentAuthorId, parentAuthorUsername)}
              className="relative z-10 shrink-0 transition-opacity hover:opacity-80"
              onClick={(e) => e.stopPropagation()}
            >
              <Avatar
                id={parentAuthorId}
                name={parentAuthorName}
                size="md"
                src={parentAuthorProfileImageUrl || undefined}
              />
            </Link>
          </div>

          {/* Parent Content */}
          <div className="min-w-0 flex-1">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 leading-none sm:items-center sm:pt-0.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Link
                  href={getProfileUrl(parentAuthorId, parentAuthorUsername)}
                  className="truncate font-semibold text-[15px] text-foreground leading-tight hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {parentAuthorName}
                </Link>
                {parentAuthorIsNPC && <VerifiedBadge size="sm" />}
                {parentAuthorUsername && (
                  <span className="truncate text-[15px] text-muted-foreground leading-tight">
                    @{parentAuthorUsername}
                  </span>
                )}
              </div>
              {parentTimestamp && (
                <span className="text-[15px] text-muted-foreground leading-tight">
                  {formatTimeAgo(parentTimestamp)}
                </span>
              )}
            </div>

            {/* Parent Content - truncated */}
            <p className="line-clamp-3 text-foreground text-sm leading-relaxed">
              <TaggedText text={parentContent} onTagClick={handleTagClick} />
            </p>

            {/* Parent Interaction Bar */}
            {isReplyToComment ? (
              <CommentInteractionBar
                commentId={reply.parentComment!.id}
                likeCount={reply.parentComment?.likeCount}
                isLiked={reply.parentComment?.isLiked}
                replyCount={reply.parentComment?.replyCount}
                onReplyClick={() =>
                  router.push(`/comment/${reply.parentComment!.id}`)
                }
              />
            ) : (
              <InteractionBar
                postId={reply.post.id}
                initialInteractions={parentPostInteractions}
                onCommentClick={() => router.push(`/post/${reply.post.id}`)}
                postData={parentPostData}
              />
            )}
          </div>
        </div>
      </div>

      {/* User's Reply */}
      <div
        className="flex cursor-pointer gap-3 px-4 pb-3 transition-colors hover:bg-muted/50 sm:px-6"
        onClick={() => router.push(`/comment/${reply.id}`)}
      >
        {/* Reply Author Avatar */}
        <div className="flex flex-col items-center">
          <Link
            href={getProfileUrl(authorId, authorUsername)}
            className="shrink-0 transition-opacity hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar
              id={authorId}
              name={authorName}
              size="md"
              src={authorProfileImageUrl || undefined}
            />
          </Link>
        </div>

        {/* Reply Content */}
        <div className="min-w-0 flex-1">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 leading-none sm:items-center sm:pt-0.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Link
                href={getProfileUrl(authorId, authorUsername)}
                className="truncate font-semibold text-[15px] text-foreground leading-tight hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {authorName}
              </Link>
              {replyAuthorIsNPC && <VerifiedBadge size="sm" />}
              {authorUsername && (
                <span className="truncate text-[15px] text-muted-foreground leading-tight">
                  @{authorUsername}
                </span>
              )}
            </div>
            <span className="text-[15px] text-muted-foreground leading-tight">
              {formatTimeAgo(reply.createdAt)}
            </span>
          </div>

          {/* Reply Content */}
          <p className="whitespace-pre-wrap break-words text-foreground text-sm leading-relaxed">
            <TaggedText text={reply.content} onTagClick={handleTagClick} />
          </p>

          {/* Action Buttons */}
          <CommentInteractionBar
            commentId={reply.id}
            likeCount={reply.likeCount}
            isLiked={reply.isLiked}
            replyCount={replyCount}
            onReplyClick={() => setIsReplying(!isReplying)}
          />

          {/* Inline reply input */}
          {isReplying && (
            <div className="mt-3" onClick={(e) => e.stopPropagation()}>
              <CommentInput
                postId={reply.postId}
                parentCommentId={reply.id}
                placeholder={`Reply to ${authorName}...`}
                replyingToName={authorName}
                autoFocus
                onSubmit={handleReplySubmit}
                onCancel={() => setIsReplying(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
