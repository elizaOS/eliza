/**
 * Unit Tests: Narrative Feed Algorithms
 *
 * Tests the two pure functions that determine how posts are ordered in the
 * Stories and Latest feeds:
 *   - flattenStories()      — burst interleaving for the Stories tab
 *   - mergeChronologically() — timestamp merge for the Latest tab
 *
 * Both functions are exported from apps/web/src/app/feed/utils/feedAlgorithms.ts
 * so this file imports the real implementation rather than a copy.
 *
 * Run with: bun test unit/narrative-feed-algorithms.test.ts
 */

import { describe, expect, it } from 'bun:test';
import type { NarrativePost, NarrativeStory } from '@feed/shared';

// Import the real implementations (not copies)
import {
  applySlotPattern,
  BURST_LEAD,
  BURST_SIZE,
  flattenStories,
  mergeChronologically,
} from '../../../apps/web/src/app/feed/utils/feedAlgorithms';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePost(
  id: string,
  overrides?: Partial<NarrativePost>
): NarrativePost {
  return {
    id,
    content: `Post ${id}`,
    fullContent: null,
    articleTitle: null,
    category: null,
    imageUrl: null,
    type: null,
    timestamp: new Date().toISOString(),
    authorId: 'user-1',
    authorName: 'Test User',
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

function makeStory(
  key: string,
  postCount: number,
  opts: Partial<NarrativeStory> = {}
): NarrativeStory {
  return {
    storyKey: key,
    storyTitle: `Story ${key}`,
    questionNumber: null,
    arcState: null,
    storyScore: 1,
    postCount,
    posts: Array.from({ length: postCount }, (_, i) =>
      makePost(`${key}-p${i}`)
    ),
    hasUserPosition: false,
    ...opts,
  };
}

// ─── flattenStories tests ─────────────────────────────────────────────────────

describe('flattenStories', () => {
  it('returns empty array for empty input', () => {
    expect(flattenStories([])).toEqual([]);
  });

  it('returns empty for a story with no posts and no isNewMarket', () => {
    const story = makeStory('A', 0);
    expect(flattenStories([story])).toEqual([]);
  });

  it('emits all posts from a single story in original order', () => {
    const story = makeStory('A', 5);
    const items = flattenStories([story]);
    expect(items.length).toBe(5);
    expect(items.every((i) => i.type === 'post')).toBe(true);
    items.forEach((item, idx) => {
      if (item.type === 'post') expect(item.post.id).toBe(`A-p${idx}`);
    });
  });

  it('gives top story BURST_LEAD posts before rotating', () => {
    const storyA = makeStory('A', 10);
    const storyB = makeStory('B', 10);
    const items = flattenStories([storyA, storyB]);

    const firstBatch = items.slice(0, BURST_LEAD);
    expect(
      firstBatch.every((i) => i.type === 'post' && i.key.startsWith('A:'))
    ).toBe(true);

    const secondBatch = items.slice(BURST_LEAD, BURST_LEAD + BURST_SIZE);
    expect(
      secondBatch.every((i) => i.type === 'post' && i.key.startsWith('B:'))
    ).toBe(true);
  });

  it('interleaves posts from three stories', () => {
    const items = flattenStories([
      makeStory('A', 6),
      makeStory('B', 6),
      makeStory('C', 6),
    ]);

    expect(items.length).toBe(18);
    expect(items.filter((i) => i.key.startsWith('A:')).length).toBe(6);
    expect(items.filter((i) => i.key.startsWith('B:')).length).toBe(6);
    expect(items.filter((i) => i.key.startsWith('C:')).length).toBe(6);
  });

  it('injects market card after post rotation, not before', () => {
    const market = makeStory('market:1', 0, {
      isNewMarket: true,
      storyKey: 'market:1',
    });
    const posts = makeStory('posts', 4);
    // market has score ~1.0 (new), but should appear AFTER the first post burst
    const items = flattenStories([market, posts]);

    // First item must be a post (market card deferred to after first rotation)
    expect(items[0]!.type).toBe('post');

    const marketItems = items.filter((i) => i.type === 'market');
    expect(marketItems.length).toBe(1);
    const firstMarket = marketItems[0]!;
    expect(firstMarket.type === 'market' && firstMarket.story.storyKey).toBe(
      'market:1'
    );
  });

  it('does not emit the same market card twice', () => {
    const market = makeStory('market:1', 0, {
      isNewMarket: true,
      storyKey: 'market:1',
    });
    expect(
      flattenStories([market]).filter((i) => i.type === 'market').length
    ).toBe(1);
  });

  it('handles stories with unequal post counts', () => {
    const long = makeStory('long', 10);
    const short = makeStory('short', 1);
    const items = flattenStories([long, short]);

    expect(items.length).toBe(11);
    expect(items.filter((i) => i.key.startsWith('short:')).length).toBe(1);
    expect(items.filter((i) => i.key.startsWith('long:')).length).toBe(10);
  });

  it('includes story reference in post items', () => {
    const story = makeStory('A', 2);
    const items = flattenStories([story]);
    expect(items[0]!.type).toBe('post');
    if (items[0]!.type === 'post') {
      expect(items[0]!.story).toBe(story);
    }
  });

  it('drops undefined posts instead of emitting invalid flat items', () => {
    const story = makeStory('A', 3);
    const malformedStory = {
      ...story,
      posts: [story.posts[0], undefined, story.posts[2]],
    } as unknown as NarrativeStory;

    const items = flattenStories([malformedStory]);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.type === 'post')).toBe(true);
    expect(items.map((item) => item.key)).toEqual([
      `A:${story.posts[0]!.id}`,
      `A:${story.posts[2]!.id}`,
    ]);
  });
});

// ─── mergeChronologically tests ───────────────────────────────────────────────

describe('mergeChronologically', () => {
  const t = (offsetMinutes: number) =>
    new Date(Date.now() - offsetMinutes * 60 * 1000).toISOString();

  const post = (timestamp: string) => ({
    id: 'p',
    content: '',
    author: 'u',
    authorId: 'u',
    authorName: 'User',
    timestamp,
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    isLiked: false,
    isShared: false,
  });

  const market = (createdAt: string) => ({
    questionNumber: 1,
    text: 'Q',
    resolutionDate: t(0),
    createdAt,
    arcState: null,
    marketId: null,
    yesShares: 0,
    noShares: 0,
  });

  it('returns empty array for empty inputs', () => {
    expect(mergeChronologically([], [])).toEqual([]);
  });

  it('returns posts unchanged when markets is empty', () => {
    const result = mergeChronologically([post(t(5)), post(t(10))], []);
    expect(result.length).toBe(2);
    expect(result.every((i) => i.type === 'post')).toBe(true);
  });

  it('returns market items when posts is empty', () => {
    const result = mergeChronologically([], [market(t(3))]);
    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('market');
  });

  it('sorts newest-first', () => {
    const result = mergeChronologically(
      [post(t(30)), post(t(10))],
      [market(t(20))]
    );
    expect(result[0]!.type).toBe('post'); // 10min
    expect(result[1]!.type).toBe('market'); // 20min
    expect(result[2]!.type).toBe('post'); // 30min
  });

  it('places market card at correct chronological position between posts', () => {
    const result = mergeChronologically(
      [post(t(5)), post(t(35))],
      [market(t(20))]
    );
    expect(result[0]!.type).toBe('post'); // 5min
    expect(result[1]!.type).toBe('market'); // 20min
    expect(result[2]!.type).toBe('post'); // 35min
  });

  it('handles multiple market cards', () => {
    const m1 = { ...market(t(5)), questionNumber: 1 };
    const m2 = { ...market(t(30)), questionNumber: 2 };
    const result = mergeChronologically([post(t(15))], [m1, m2]);

    expect(result[0]!.type).toBe('market'); // 5min
    expect(result[1]!.type).toBe('post'); // 15min
    expect(result[2]!.type).toBe('market'); // 30min
  });

  it('handles timestamp ties without throwing', () => {
    const ts = t(10);
    const result = mergeChronologically([post(ts)], [market(ts)]);
    expect(result.length).toBe(2);
  });
});

// ─── applySlotPattern ─────────────────────────────────────────────────────────

describe('applySlotPattern', () => {
  // ── helpers ──────────────────────────────────────────────────────────────

  /** Actor NPC post (individual personality) */
  const actorPost = (id: string, authorId = `actor-${id}`) =>
    makePost(id, { authorId, authorType: 'actor' });

  /** News org post (media NPC) */
  const newsPost = (id: string, authorId = `org-${id}`) =>
    makePost(id, { authorId, authorType: 'news' });

  /** Article type post (also classified as news by fallback) */
  const articlePost = (id: string) =>
    makePost(id, { type: 'article', authorType: 'user' });

  /** New market FlatItem */
  const marketItem = (
    key: string
  ): ReturnType<typeof applySlotPattern>[number] => ({
    type: 'market',
    key,
    story: {
      storyKey: key,
      storyTitle: `Market ${key}`,
      questionNumber: 1,
      arcState: null,
      storyScore: 1,
      postCount: 0,
      posts: [],
      hasUserPosition: false,
      isNewMarket: true,
    },
  });

  /** Actor FlatItem */
  const actorItem = (
    id: string,
    authorId?: string
  ): ReturnType<typeof applySlotPattern>[number] => ({
    type: 'post',
    key: `story:${id}`,
    post: actorPost(id, authorId),
    marketId: null,
  });

  /** News FlatItem */
  const newsItem = (
    id: string,
    authorId?: string
  ): ReturnType<typeof applySlotPattern>[number] => ({
    type: 'post',
    key: `story:${id}`,
    post: newsPost(id, authorId),
    marketId: null,
  });

  // ── tests ─────────────────────────────────────────────────────────────────

  it('enforces [actor, actor, news, market] pattern with full buckets', () => {
    const items = [
      actorItem('a1'),
      actorItem('a2'),
      actorItem('a3'),
      actorItem('a4'),
      newsItem('n1'),
      newsItem('n2'),
      marketItem('m1'),
      marketItem('m2'),
    ];
    const result = applySlotPattern(items);
    expect(result[0]!.type).toBe('post'); // actor slot
    expect(result[1]!.type).toBe('post'); // actor slot
    expect(result[2]!.type).toBe('post'); // news slot
    expect(result[3]!.type).toBe('market'); // market slot
    expect(result[4]!.type).toBe('post'); // actor slot (second cycle)
    expect(result.length).toBe(8);
  });

  it('classifies article-type posts as news even without authorType', () => {
    const articleItem = (): ReturnType<typeof applySlotPattern>[number] => ({
      type: 'post',
      key: 'article:1',
      post: articlePost('art1'),
      marketId: null,
    });
    const items = [
      actorItem('a1'),
      actorItem('a2'),
      articleItem(),
      marketItem('m1'),
    ];
    const result = applySlotPattern(items);
    // Third slot should be news (article)
    expect(result[2]).toMatchObject({ type: 'post' });
    expect((result[2] as { post: NarrativePost }).post.type).toBe('article');
  });

  it('falls back to available content when a bucket is empty', () => {
    // Only actor posts, no news or markets
    const items = [actorItem('a1'), actorItem('a2'), actorItem('a3')];
    const result = applySlotPattern(items);
    // All should still be emitted despite no news/market slots to fill
    expect(result.length).toBe(3);
    expect(result.every((i) => i.type === 'post')).toBe(true);
  });

  it('prevents two consecutive posts from the same author', () => {
    // Two actor posts from the same author followed by one from a different author
    const sameAuthor = 'actor-same';
    const items = [
      actorItem('a1', sameAuthor),
      actorItem('a2', sameAuthor),
      actorItem('a3', 'actor-other'),
      newsItem('n1'),
      marketItem('m1'),
    ];
    const result = applySlotPattern(items);
    // First two actor slots should not both be from sameAuthor
    const firstActorId =
      result[0]!.type === 'post' ? result[0]!.post.authorId : null;
    const secondActorId =
      result[1]!.type === 'post' ? result[1]!.post.authorId : null;
    expect(firstActorId).not.toBe(secondActorId);
  });

  it('preserves all items with no duplicates or losses', () => {
    const items = [
      actorItem('a1'),
      actorItem('a2'),
      newsItem('n1'),
      marketItem('m1'),
      actorItem('a3'),
      newsItem('n2'),
    ];
    const result = applySlotPattern(items);
    expect(result.length).toBe(items.length);
    const keys = result.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
  });

  it('returns empty array for empty input', () => {
    expect(applySlotPattern([])).toEqual([]);
  });
});
