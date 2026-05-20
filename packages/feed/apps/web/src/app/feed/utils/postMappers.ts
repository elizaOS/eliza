/**
 * Post data transformation utilities for the feed.
 *
 * `NarrativePost` (from the feed ranking APIs) and `FeedPost` (from `/api/posts`)
 * both need to be mapped into the shape `PostCard` expects. Keeping this logic in
 * one place prevents drift between feed surfaces and lets us sanitize malformed
 * repost payloads before they reach the client renderer.
 */

import type { FeedPost, NarrativePost } from "@feed/shared";

type FeedLikePost = FeedPost | NarrativePost;

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeOriginalPost(post: FeedLikePost) {
  const rawOriginalPostId = hasText(post.originalPostId)
    ? post.originalPostId
    : null;
  if (!rawOriginalPostId || rawOriginalPostId === post.id) {
    return {
      originalPostId: null,
      originalPost: null,
    };
  }

  if (post.originalPost) {
    const originalId = hasText(post.originalPost.id)
      ? post.originalPost.id
      : rawOriginalPostId;
    if (originalId === post.id) {
      return {
        originalPostId: null,
        originalPost: null,
      };
    }

    return {
      originalPostId: originalId,
      originalPost: {
        id: originalId,
        content: post.originalPost.content,
        authorId: post.originalPost.authorId,
        authorName: post.originalPost.authorName,
        authorUsername: post.originalPost.authorUsername ?? null,
        authorProfileImageUrl: post.originalPost.authorProfileImageUrl ?? null,
        timestamp: post.originalPost.timestamp,
      },
    };
  }

  if (
    "originalContent" in post &&
    (hasText(post.originalContent) ||
      hasText(post.originalAuthorId) ||
      hasText(post.originalAuthorName))
  ) {
    return {
      originalPostId: rawOriginalPostId,
      originalPost: {
        id: rawOriginalPostId,
        content: post.originalContent ?? "",
        authorId: post.originalAuthorId ?? "",
        authorName: post.originalAuthorName ?? post.originalAuthorId ?? "",
        authorUsername: post.originalAuthorUsername ?? null,
        authorProfileImageUrl: post.originalAuthorProfileImageUrl ?? null,
        timestamp: post.timestamp,
      },
    };
  }

  return {
    originalPostId: rawOriginalPostId,
    originalPost: null,
  };
}

function normalizeRepostFields(post: FeedLikePost) {
  const { originalPostId, originalPost } = normalizeOriginalPost(post);
  const isRepost =
    Boolean(post.isRepost) || originalPostId !== null || originalPost !== null;
  const isQuote =
    isRepost && (Boolean(post.isQuote) || hasText(post.quoteComment));

  return {
    isRepost,
    isQuote,
    quoteComment: post.quoteComment ?? null,
    originalPostId,
    originalPost,
  };
}

export function toPostCardData(post: NarrativePost) {
  return {
    id: post.id,
    type: post.type ?? undefined,
    content: post.content,
    articleTitle: post.articleTitle,
    category: post.category,
    authorId: post.authorId,
    authorName: post.authorName,
    authorUsername: post.authorUsername,
    authorProfileImageUrl: post.authorProfileImageUrl,
    timestamp: post.timestamp,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    shareCount: post.shareCount,
    isLiked: post.isLiked,
    isShared: post.isShared,
    ...normalizeRepostFields(post),
  };
}

export function toFeedPostCardData(post: FeedPost, authorName: string) {
  return {
    id: post.id,
    type: post.type ?? undefined,
    content: post.content,
    articleTitle: post.articleTitle ?? null,
    byline: post.byline ?? null,
    biasScore: post.biasScore ?? null,
    category: post.category ?? null,
    authorId: post.authorId ?? post.author,
    authorName,
    authorUsername: post.authorUsername ?? null,
    authorProfileImageUrl: post.authorProfileImageUrl ?? null,
    timestamp: post.timestamp,
    likeCount: post.likeCount ?? 0,
    commentCount: post.commentCount ?? 0,
    shareCount: post.shareCount ?? 0,
    isLiked: post.isLiked ?? false,
    isShared: post.isShared ?? false,
    commentPreviews: post.commentPreviews,
    ...normalizeRepostFields(post),
  };
}

export function toArticleCardData(post: NarrativePost) {
  return {
    id: post.id,
    type: post.type ?? undefined,
    content: post.content,
    fullContent: post.fullContent,
    articleTitle: post.articleTitle,
    category: post.category,
    imageUrl: post.imageUrl,
    authorId: post.authorId,
    authorName: post.authorName,
    authorUsername: post.authorUsername,
    authorProfileImageUrl: post.authorProfileImageUrl,
    timestamp: post.timestamp,
  };
}
