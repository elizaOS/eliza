import { describe, expect, it } from "bun:test";
import type { FeedPost, NarrativePost } from "@feed/shared";
import {
  toFeedPostCardData,
  toPostCardData,
} from "../../../apps/web/src/app/feed/utils/postMappers";

const BASE_TIMESTAMP = "2026-03-30T12:00:00.000Z";

function makeFeedPost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id: "post-1",
    author: "user-1",
    authorId: "user-1",
    authorName: "Feed User",
    content: "Hello world",
    timestamp: BASE_TIMESTAMP,
    ...overrides,
  };
}

function makeNarrativePost(
  overrides: Partial<NarrativePost> = {},
): NarrativePost {
  return {
    id: "story-post-1",
    content: "Story post",
    fullContent: null,
    articleTitle: null,
    category: null,
    imageUrl: null,
    type: null,
    timestamp: BASE_TIMESTAMP,
    authorId: "actor-1",
    authorName: "Actor One",
    authorUsername: null,
    authorProfileImageUrl: null,
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    isLiked: false,
    isShared: false,
    relatedQuestion: null,
    ...overrides,
  };
}

describe("feed post mappers", () => {
  it("drops self-referential originals before they reach PostCard", () => {
    const post = makeFeedPost({
      isRepost: true,
      originalPostId: "post-1",
      originalPost: {
        id: "post-1",
        content: "Recursive original",
        authorId: "user-1",
        authorName: "Feed User",
        authorUsername: "feeduser",
        authorProfileImageUrl: null,
        timestamp: BASE_TIMESTAMP,
      },
    });

    const result = toFeedPostCardData(post, "Feed User");

    expect(result.isRepost).toBe(true);
    expect(result.originalPostId).toBeNull();
    expect(result.originalPost).toBeNull();
  });

  it("rebuilds originalPost from flat repost metadata when nested data is absent", () => {
    const post = makeFeedPost({
      isRepost: true,
      isQuote: true,
      quoteComment: "Worth sharing",
      originalPostId: "original-1",
      originalAuthorId: "author-2",
      originalAuthorName: "Original Author",
      originalAuthorUsername: "original-author",
      originalAuthorProfileImageUrl: "/avatars/original.png",
      originalContent: "Original content",
    });

    const result = toFeedPostCardData(post, "Feed User");

    expect(result.isRepost).toBe(true);
    expect(result.isQuote).toBe(true);
    expect(result.originalPostId).toBe("original-1");
    expect(result.originalPost).toEqual({
      id: "original-1",
      content: "Original content",
      authorId: "author-2",
      authorName: "Original Author",
      authorUsername: "original-author",
      authorProfileImageUrl: "/avatars/original.png",
      timestamp: BASE_TIMESTAMP,
    });
  });

  it("normalizes falsy string quote flags from feed payloads to booleans", () => {
    const post = makeFeedPost({
      isRepost: true,
      isQuote: "" as unknown as boolean,
      originalPostId: "original-1",
      originalPost: {
        id: "original-1",
        content: "Original content",
        authorId: "author-2",
        authorName: "Original Author",
        authorUsername: null,
        authorProfileImageUrl: null,
        timestamp: BASE_TIMESTAMP,
      },
    });

    const result = toFeedPostCardData(post, "Feed User");

    expect(result.isRepost).toBe(true);
    expect(result.isQuote).toBe(false);
  });

  it("sanitizes malformed narrative reposts with self-pointing originals too", () => {
    const post = makeNarrativePost({
      isRepost: true,
      originalPostId: "story-post-1",
      originalPost: {
        id: "story-post-1",
        content: "Recursive original",
        authorId: "actor-1",
        authorName: "Actor One",
        authorUsername: null,
        authorProfileImageUrl: null,
        timestamp: BASE_TIMESTAMP,
      },
    });

    const result = toPostCardData(post);

    expect(result.originalPostId).toBeNull();
    expect(result.originalPost).toBeNull();
  });
});
