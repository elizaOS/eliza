import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockBuildStoriesFeed = mock();
const mockEnrichStoriesForUser = mock();
const mockPublicRateLimit = mock();

// Cache simulation: getCacheOrFetch returns the SAME object reference on every
// call within the TTL window, which is the root cause of the race condition
// this PR fixes. We store the cached result so the test can assert that the
// original object is never mutated.
let cachedResult: { stories: unknown[]; postIds: string[] } | null = null;

const mockGetCacheOrFetch = mock(
  async <T>(_key: string, fetchFn: () => Promise<T>) => {
    if (!cachedResult) {
      cachedResult = (await fetchFn()) as typeof cachedResult;
    }
    return cachedResult as T;
  }
);

mock.module('@feed/api', () => ({
  addPublicReadHeaders: (
    response: Response,
    rateLimitInfo: { limit: number }
  ) => {
    response.headers.set('Cache-Control', 'public, max-age=30');
    response.headers.set('X-RateLimit-Limit', String(rateLimitInfo.limit));
  },
  getCacheOrFetch: mockGetCacheOrFetch,
  publicRateLimit: mockPublicRateLimit,
  successResponse: (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    }),
  withErrorHandling: (handler: (request: NextRequest) => Promise<Response>) =>
    handler,
}));

mock.module('./pipeline', () => ({
  buildStoriesFeed: mockBuildStoriesFeed,
  enrichStoriesForUser: mockEnrichStoriesForUser,
}));

const { GET } = await import('./route');

/** Encode a cursor the same way the route does (base64url JSON). */
function encodeCursor(score: number, storyKey: string): string {
  return Buffer.from(JSON.stringify({ s: score, k: storyKey })).toString(
    'base64url'
  );
}

const makeRequest = (params: Record<string, string> = {}): NextRequest => {
  const searchParams = new URLSearchParams(params);
  return {
    url: 'https://feed.market/api/feed/stories',
    headers: { get: () => null },
    nextUrl: { searchParams },
  } as unknown as NextRequest;
};

function makeAuthRateLimit(userId: string) {
  return {
    error: null,
    user: { userId },
    rateLimitInfo: { limit: 60, remaining: 59, resetAt: new Date() },
  };
}

function makeAnonRateLimit() {
  return {
    error: null,
    user: null,
    rateLimitInfo: { limit: 100, remaining: 99, resetAt: new Date() },
  };
}

function makePipelineResult() {
  return {
    stories: [
      {
        storyKey: 'story-1',
        storyTitle: 'Test Story',
        storyScore: 1,
        postCount: 2,
        posts: [
          { id: 'post-1', isLiked: false, isShared: false, likeCount: 5 },
          { id: 'post-2', isLiked: false, isShared: false, likeCount: 3 },
        ],
      },
    ],
    postIds: ['post-1', 'post-2'],
    topic: { title: 'Test Topic' },
    generatedAt: '2026-03-19T12:00:00.000Z',
  };
}

beforeEach(() => {
  cachedResult = null;
  mockBuildStoriesFeed.mockReset();
  mockPublicRateLimit.mockReset();
  mockGetCacheOrFetch.mockReset();
  mockEnrichStoriesForUser.mockReset();

  mockGetCacheOrFetch.mockImplementation(
    async <T>(_key: string, fetchFn: () => Promise<T>) => {
      if (!cachedResult) {
        cachedResult = (await fetchFn()) as typeof cachedResult;
      }
      return cachedResult as T;
    }
  );
});

describe('GET /api/feed/stories', () => {
  it('does not mutate the cached stories object during per-user enrichment', async () => {
    mockPublicRateLimit.mockResolvedValue(makeAuthRateLimit('user-A'));
    mockBuildStoriesFeed.mockResolvedValue(makePipelineResult());

    // enrichStoriesForUser mutates the stories array it receives in-place
    mockEnrichStoriesForUser.mockImplementation(
      (
        stories: Array<{
          posts: Array<{ isLiked: boolean; isShared: boolean }>;
        }>
      ) => {
        for (const story of stories) {
          for (const post of story.posts) {
            post.isLiked = true;
            post.isShared = true;
          }
        }
      }
    );

    // First request: user-A triggers enrichment, which mutates isLiked/isShared
    await GET(makeRequest());

    // The cached object must still have the original false values —
    // structuredClone should have prevented in-place mutation.
    expect(cachedResult).not.toBeNull();
    for (const story of cachedResult!.stories as Array<{
      posts: Array<{ isLiked: boolean; isShared: boolean }>;
    }>) {
      for (const post of story.posts) {
        expect(post.isLiked).toBe(false);
        expect(post.isShared).toBe(false);
      }
    }
  });

  it('returns per-user enriched state without cross-user bleed', async () => {
    mockBuildStoriesFeed.mockResolvedValue(makePipelineResult());

    // Simulate user-A who liked post-1 only
    mockPublicRateLimit.mockResolvedValue(makeAuthRateLimit('user-A'));
    mockEnrichStoriesForUser.mockImplementation(
      (
        stories: Array<{
          posts: Array<{ id: string; isLiked: boolean; isShared: boolean }>;
        }>
      ) => {
        for (const story of stories) {
          for (const post of story.posts) {
            post.isLiked = post.id === 'post-1';
            post.isShared = false;
          }
        }
      }
    );

    const responseA = await GET(makeRequest());
    const payloadA = await responseA.json();
    expect(payloadA.stories[0].posts[0].isLiked).toBe(true);
    expect(payloadA.stories[0].posts[1].isLiked).toBe(false);

    // Simulate user-B who liked post-2 only
    mockPublicRateLimit.mockResolvedValue(makeAuthRateLimit('user-B'));
    mockEnrichStoriesForUser.mockImplementation(
      (
        stories: Array<{
          posts: Array<{ id: string; isLiked: boolean; isShared: boolean }>;
        }>
      ) => {
        for (const story of stories) {
          for (const post of story.posts) {
            post.isLiked = post.id === 'post-2';
            post.isShared = false;
          }
        }
      }
    );

    const responseB = await GET(makeRequest());
    const payloadB = await responseB.json();
    // user-B must see their own state, not user-A's
    expect(payloadB.stories[0].posts[0].isLiked).toBe(false);
    expect(payloadB.stories[0].posts[1].isLiked).toBe(true);
  });

  it('skips enrichment for anonymous users', async () => {
    mockPublicRateLimit.mockResolvedValue(makeAnonRateLimit());
    mockBuildStoriesFeed.mockResolvedValue(makePipelineResult());

    const response = await GET(makeRequest());
    const payload = await response.json();

    expect(mockEnrichStoriesForUser).not.toHaveBeenCalled();
    expect(payload.stories[0].posts[0].isLiked).toBe(false);
  });

  it('paginates the cloned stories array correctly with cursor', async () => {
    mockPublicRateLimit.mockResolvedValue(makeAnonRateLimit());
    // 25-item dataset ranked by descending score
    const manyStories = Array.from({ length: 25 }, (_, i) => ({
      storyKey: `story-${i}`,
      storyScore: 25 - i, // descending: story-0 has score 25, story-24 has score 1
      posts: [],
    }));
    mockBuildStoriesFeed.mockResolvedValue({
      stories: manyStories,
      postIds: [],
      topic: { title: 'Test' },
      generatedAt: '2026-03-19T12:00:00.000Z',
    });

    // Cursor after story-19 (score=6)
    const cursor = encodeCursor(6, 'story-19');
    const response = await GET(makeRequest({ cursor, limit: '20' }));
    const payload = await response.json();

    expect(payload.stories).toHaveLength(5);
    expect(payload.hasMore).toBe(false);
  });
});
