import { describe, expect, it } from 'bun:test';
import type { NarrativePost, NarrativeStory } from '@feed/shared';
import {
  calculateConversationDepthScore,
  calculateForYouScore,
  calculateFreshnessScore,
  calculateVelocityScore,
  diversifyForYouStories,
  spreadNewMarkets,
} from './scoring';

function makeStory(
  storyKey: string,
  overrides: Partial<NarrativeStory> = {}
): NarrativeStory {
  return {
    storyKey,
    storyTitle: storyKey,
    questionNumber: null,
    arcState: null,
    storyScore: 1,
    finalRankScore: 1,
    postCount: 1,
    posts: [
      {
        id: `${storyKey}-post`,
        content: storyKey,
        fullContent: null,
        articleTitle: null,
        category: null,
        imageUrl: null,
        type: 'post',
        timestamp: new Date().toISOString(),
        authorId: `${storyKey}-author`,
        authorName: storyKey,
        authorUsername: null,
        authorProfileImageUrl: null,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        isLiked: false,
        isShared: false,
        relatedQuestion: null,
      },
    ],
    hasUserPosition: false,
    ...overrides,
  };
}

function makeAnchorPost(
  id: string,
  overrides: Partial<NarrativePost> = {}
): NarrativePost {
  return {
    id,
    content: 'NEW MARKET: Will BTC reach $100k?',
    fullContent: null,
    articleTitle: null,
    category: null,
    imageUrl: null,
    type: 'post',
    timestamp: new Date().toISOString(),
    authorId: 'npc-org-1',
    authorName: 'AIxios',
    authorUsername: 'aixios',
    authorProfileImageUrl: null,
    likeCount: 5,
    commentCount: 2,
    shareCount: 1,
    isLiked: false,
    isShared: false,
    relatedQuestion: 42,
    authorType: 'news',
    ...overrides,
  };
}

describe('isNewMarket story invariants', () => {
  // diversifyForYouStories ranks by `finalRankScore ?? storyScore`.
  // MARKET_WINDOW_PENALTY (0.5) is subtracted from a new-market story's
  // finalRankScore when another new-market story appeared in the previous
  // MARKET_WINDOW_SIZE positions. narrative.finalRankScore (8.8) must exceed
  // market2's penalised score (9 - 0.5 = 8.5) for the penalty to flip ordering.
  it('diversifyForYouStories separates consecutive new-market stories', () => {
    const market1 = makeStory('market:1', {
      isNewMarket: true,
      finalRankScore: 10,
      posts: [makeAnchorPost('anchor-1')],
      anchorPostId: 'anchor-1',
    });
    const market2 = makeStory('market:2', {
      isNewMarket: true,
      finalRankScore: 9,
      posts: [makeAnchorPost('anchor-2')],
      anchorPostId: 'anchor-2',
    });
    const narrative = makeStory('story:1', {
      isNewMarket: false,
      finalRankScore: 8.8,
    });

    const input = [market1, market2, narrative];
    const result = diversifyForYouStories(input);

    const marketIndices = result
      .map((s, i) => (s.isNewMarket ? i : -1))
      .filter((i) => i !== -1);
    expect(marketIndices.length).toBe(2);
    expect((marketIndices[1] ?? 0) - (marketIndices[0] ?? 0)).toBeGreaterThan(
      1
    );
  });

  it('diversifyForYouStories preserves anchor post data on new-market stories', () => {
    const anchorPost = makeAnchorPost('anchor-1', { likeCount: 7 });
    const market = makeStory('market:42', {
      isNewMarket: true,
      finalRankScore: 5,
      anchorPostId: 'anchor-1',
      posts: [anchorPost],
    });

    const [result] = diversifyForYouStories([market]);
    const found = result?.posts.find((p) => p.id === result.anchorPostId);
    expect(found).toBeDefined();
    expect(found?.likeCount).toBe(7);
  });
});

describe('for-you scoring helpers', () => {
  it('rewards fresher items with higher freshness scores', () => {
    const now = calculateFreshnessScore(new Date());
    const yesterday = calculateFreshnessScore(
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    expect(now).toBeGreaterThan(yesterday);
  });

  it('rewards engagement velocity for recent engaged content', () => {
    const recent = calculateVelocityScore(30, new Date());
    const stale = calculateVelocityScore(
      30,
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    expect(recent).toBeGreaterThan(stale);
  });

  it('rewards deeper conversation threads', () => {
    expect(calculateConversationDepthScore(12, 4)).toBeGreaterThan(
      calculateConversationDepthScore(1, 1)
    );
  });

  it('weights topic and market relevance in the final score', () => {
    const highIntent = calculateForYouScore({
      baseScore: 2,
      topicMatchScore: 1.75,
      socialAffinityScore: 1.2,
      marketRelevanceScore: 1.5,
      engagementVelocityScore: 1.1,
      conversationDepthScore: 0.9,
      narrativeUrgencyScore: 0.6,
      freshnessScore: 1,
      noveltyScore: 0.4,
    });
    const lowIntent = calculateForYouScore({
      baseScore: 2,
      topicMatchScore: 0,
      socialAffinityScore: 0.1,
      marketRelevanceScore: 0.1,
      engagementVelocityScore: 0.2,
      conversationDepthScore: 0.1,
      narrativeUrgencyScore: 0,
      freshnessScore: 0.4,
      noveltyScore: 0.1,
    });

    expect(highIntent).toBeGreaterThan(lowIntent);
  });

  it('spreadNewMarkets returns empty array unchanged', () => {
    expect(spreadNewMarkets([])).toEqual([]);
  });

  it('spreadNewMarkets leaves a feed with no adjacent markets unchanged', () => {
    const input = [
      makeStory('p1'),
      makeStory('m1', { isNewMarket: true }),
      makeStory('p2'),
      makeStory('m2', { isNewMarket: true }),
    ];
    const result = spreadNewMarkets(input);
    expect(result.map((s) => s.storyKey)).toEqual(['p1', 'm1', 'p2', 'm2']);
  });

  it('spreadNewMarkets separates two back-to-back markets', () => {
    const input = [
      makeStory('m1', { isNewMarket: true }),
      makeStory('m2', { isNewMarket: true }),
      makeStory('p1'),
      makeStory('p2'),
    ];
    const result = spreadNewMarkets(input);
    expect(result.map((s) => s.storyKey)).toEqual(['m1', 'p1', 'm2', 'p2']);
    expect(result[0]?.isNewMarket).toBe(true);
    expect(result[1]?.isNewMarket).toBeFalsy();
    expect(result[2]?.isNewMarket).toBe(true);
  });

  it('spreadNewMarkets handles three consecutive markets with available posts', () => {
    const input = [
      makeStory('m1', { isNewMarket: true }),
      makeStory('m2', { isNewMarket: true }),
      makeStory('m3', { isNewMarket: true }),
      makeStory('p1'),
      makeStory('p2'),
      makeStory('p3'),
    ];
    const result = spreadNewMarkets(input);
    for (let i = 0; i < result.length - 1; i++) {
      expect(!!(result[i]?.isNewMarket && result[i + 1]?.isNewMarket)).toBe(
        false
      );
    }
    expect(result).toHaveLength(6);
  });

  it('spreadNewMarkets leaves all-market feed unchanged when no posts exist', () => {
    const input = [
      makeStory('m1', { isNewMarket: true }),
      makeStory('m2', { isNewMarket: true }),
      makeStory('m3', { isNewMarket: true }),
    ];
    expect(spreadNewMarkets(input).map((s) => s.storyKey)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('spreadNewMarkets does not mutate the original array', () => {
    const input = [
      makeStory('m1', { isNewMarket: true }),
      makeStory('m2', { isNewMarket: true }),
      makeStory('p1'),
    ];
    const inputKeys = input.map((s) => s.storyKey);
    spreadNewMarkets(input);
    expect(input.map((s) => s.storyKey)).toEqual(inputKeys);
  });

  it('diversifies repeated authors and clusters', () => {
    const stories = [
      makeStory('a1', {
        finalRankScore: 9,
        primaryAuthorId: 'same-author',
        clusterId: 'cluster-a',
      }),
      makeStory('a2', {
        finalRankScore: 8.5,
        primaryAuthorId: 'same-author',
        clusterId: 'cluster-a',
      }),
      makeStory('b1', {
        finalRankScore: 8,
        primaryAuthorId: 'other-author',
        clusterId: 'cluster-b',
      }),
    ];

    const diversified = diversifyForYouStories(stories);
    expect(diversified[0]?.storyKey).toBe('a1');
    expect(diversified[1]?.storyKey).toBe('b1');
  });
});
