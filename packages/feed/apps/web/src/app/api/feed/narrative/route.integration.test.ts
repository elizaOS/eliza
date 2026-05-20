/**
 * Integration Tests — Narrative Feed API
 *
 * @route GET /api/feed/narrative
 *
 * Tests the full GET handler end-to-end using mock modules for all DB/API
 * dependencies. Verifies story grouping, scoring, filtering, arc state
 * multipliers, authenticated enrichment, and response contract.
 *
 * Pattern: mock.module() → dynamic import → test handler directly
 * (same pattern as apps/web/src/app/api/agents/onboard/route.test.ts)
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
import {
  calculateArcStateMultiplier,
  calculateResolutionBoost,
  calculateStoryScore,
} from './scoring';

type NarrativeStory = {
  storyKey: string;
  storyTitle: string;
  questionNumber: number | null;
  arcState: string | null;
  storyScore: number;
  postCount: number;
  posts: Array<{
    id: string;
    content: string;
    fullContent: string | null;
    articleTitle: string | null;
    category: string | null;
    imageUrl: string | null;
    type: string | null;
    timestamp: string;
    authorId: string;
    authorName: string;
    authorUsername: string | null;
    authorProfileImageUrl: string | null;
    likeCount: number;
    commentCount: number;
    shareCount: number;
    isLiked: boolean;
    isShared: boolean;
    relatedQuestion: number | null;
  }>;
  hasUserPosition: boolean;
};

type NarrativeFeedResponse = {
  success: true;
  stories: NarrativeStory[];
  generatedAt: string;
};

// ─── Chainable Drizzle query builder mock ─────────────────────────────────────

/**
 * Returns a thenable object that resolves to `data`.
 * All Drizzle chain methods (from/where/orderBy/limit/leftJoin) return `this`,
 * so the full query chain resolves to the preset data when awaited.
 */
const makeChain = (data: unknown[]) => {
  const chain: Record<string, unknown> = {};
  const noop = () => chain;
  chain.from = noop;
  chain.where = noop;
  chain.orderBy = noop;
  chain.limit = noop;
  chain.leftJoin = noop;
  // Thenable — called by `await`
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown
  ) => Promise.resolve(data).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(data).catch(reject);
  chain.finally = (cb: () => void) => Promise.resolve(data).finally(cb);
  return chain;
};

// ─── Mutable per-test state ───────────────────────────────────────────────────

/**
 * selectQueue[n] is returned by the n-th call to db.select() in a single test.
 * Query call order (inside getCacheOrFetch factory):
 *   0 — recent posts
 *   1 — author users
 *   2 — questions + arcStates
 * If authenticated (outside factory, via Promise.all):
 *   3 — user reactions
 *   4 — user shares
 *   5 — user positions (Promise.all fires all 3 simultaneously; unset defaults to [])
 */
let selectQueue: unknown[][] = [];
let executeResult: unknown[] = []; // returned by db.execute (CTE engagement query)
let authUser: { userId: string } | null = null;

const mockDbExecute = mock();
const mockDbSelect = mock();

// ─── Module mocks (must be declared before dynamic import) ────────────────────

mock.module('@feed/api', () => ({
  // Bypass cache — call factory directly
  getCacheOrFetch: (_key: string, factory: () => Promise<unknown>) => factory(),
  // Controlled authentication
  optionalAuth: () => Promise.resolve(authUser),
  // Return data directly so tests can inspect it without parsing a Response
  successResponse: (data: unknown) => data,
  // Strip error handling wrapper so the handler is called directly
  withErrorHandling: (handler: (req: NextRequest) => Promise<unknown>) =>
    handler,
}));

mock.module('@feed/engine', () => ({
  StaticDataRegistry: { getActor: () => null },
}));

mock.module('@feed/shared', () => ({
  logger: {
    debug: () => {},
    warn: () => {},
    info: () => {},
    error: () => {},
  },
}));

// Schema table mock objects — values are strings so the route can read field
// paths without crashing; actual data shape comes from selectQueue entries.
const postsMock = {
  _t: 'posts',
  id: 'posts.id',
  content: 'posts.content',
  authorId: 'posts.authorId',
  timestamp: 'posts.timestamp',
  type: 'posts.type',
  articleTitle: 'posts.articleTitle',
  fullContent: 'posts.fullContent',
  category: 'posts.category',
  imageUrl: 'posts.imageUrl',
  relatedQuestion: 'posts.relatedQuestion',
  deletedAt: 'posts.deletedAt',
  commentOnPostId: 'posts.commentOnPostId',
  parentCommentId: 'posts.parentCommentId',
};
const usersMock = {
  _t: 'users',
  id: 'users.id',
  username: 'users.username',
  displayName: 'users.displayName',
  profileImageUrl: 'users.profileImageUrl',
};
const questionsMock = {
  _t: 'questions',
  questionNumber: 'questions.questionNumber',
  text: 'questions.text',
  status: 'questions.status',
  id: 'questions.id',
};
const reactionsMock = {
  _t: 'reactions',
  postId: 'reactions.postId',
  userId: 'reactions.userId',
  type: 'reactions.type',
};
const sharesMock = {
  _t: 'shares',
  postId: 'shares.postId',
  userId: 'shares.userId',
};
const arcStatesMock = {
  _t: 'arcStates',
  questionId: 'arcStates.questionId',
  currentState: 'arcStates.currentState',
};
const positionsMock = {
  _t: 'positions',
  userId: 'positions.userId',
  questionId: 'positions.questionId',
};

mock.module('@feed/db', () => ({
  db: { select: mockDbSelect, execute: mockDbExecute },
  and: (...args: unknown[]) => args,
  desc: (x: unknown) => x,
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  inArray: (col: unknown, arr: unknown) => ({ col, arr }),
  isNotNull: (col: unknown) => col,
  isNull: (col: unknown) => col,
  lte: (a: unknown, b: unknown) => [a, b],
  // sql tagged template — returns a sentinel; db.execute mock ignores it
  sql: Object.assign(
    (_s: TemplateStringsArray, ..._v: unknown[]) => ({ _sql: true }),
    { join: () => ({ _sql: true }) }
  ),
  posts: postsMock,
  users: usersMock,
  questions: questionsMock,
  reactions: reactionsMock,
  shares: sharesMock,
  arcStates: arcStatesMock,
  positions: positionsMock,
}));

// ─── Route import (after all mocks are registered) ───────────────────────────

const { GET } = await import('./route');
const GENERAL_STORY_KEY = '__general__';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const makeRequest = (): NextRequest =>
  ({
    url: 'https://feed.market/api/feed/narrative',
    headers: { get: () => null },
  }) as unknown as NextRequest;

const callGet = (req?: NextRequest): Promise<NarrativeFeedResponse> =>
  GET(req ?? makeRequest()) as unknown as Promise<NarrativeFeedResponse>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

interface PostFixture {
  id: string;
  content: string;
  authorId: string;
  timestamp: Date;
  type: string;
  articleTitle: string | null;
  fullContent: string | null;
  category: string | null;
  imageUrl: string | null;
  relatedQuestion: number | null;
}

const makePost = (
  id: string,
  relatedQuestion: number | null,
  hoursOld = 1,
  authorId = 'author-1'
): PostFixture => ({
  id,
  content: `Content of ${id}`,
  authorId,
  timestamp: hoursAgo(hoursOld),
  type: 'post',
  articleTitle: null,
  fullContent: null,
  category: null,
  imageUrl: null,
  relatedQuestion,
});

const makeEngagement = (
  postId: string,
  likes = 0,
  comments = 0,
  sharesCount = 0
) => ({
  post_id: postId,
  like_count: likes,
  comment_count: comments,
  share_count: sharesCount,
});

const makeUser = (id: string) => ({
  id,
  username: `user_${id.replace('-', '_')}`,
  displayName: `Display ${id}`,
  profileImageUrl: null,
});

// Default resolution date far in future → 1.0 boost (preserves existing score expectations)
const FAR_FUTURE = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

const makeQuestion = (
  questionNumber: number,
  text: string,
  status = 'active',
  arcState: string | null = null,
  resolutionDate: Date = FAR_FUTURE
) => ({ questionNumber, text, status, arcState, resolutionDate });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/feed/narrative — integration', () => {
  beforeEach(() => {
    authUser = null;
    selectQueue = [];
    executeResult = [];

    // Reset call counts so .toHaveBeenCalled() assertions are per-test
    mockDbSelect.mockClear();
    mockDbExecute.mockClear();

    let callIndex = 0;
    mockDbSelect.mockImplementation(() => {
      const data = selectQueue[callIndex] ?? [];
      callIndex++;
      return makeChain(data);
    });
    mockDbExecute.mockImplementation(() => Promise.resolve(executeResult));
  });

  // ── Empty feed ─────────────────────────────────────────────────────────────

  describe('empty feed', () => {
    it('returns empty stories array and success=true when no posts exist', async () => {
      selectQueue[0] = []; // posts query returns nothing

      const response = await callGet();

      expect(response.success).toBe(true);
      expect(response.stories).toHaveLength(0);
      expect(typeof response.generatedAt).toBe('string');
      // generatedAt must be a valid ISO timestamp
      expect(() => new Date(response.generatedAt)).not.toThrow();
    });

    it('skips engagement and question queries when there are no posts', async () => {
      selectQueue[0] = [];

      await callGet();

      // db.execute (CTE) should NOT be called when there are no posts
      expect(mockDbExecute).not.toHaveBeenCalled();
    });
  });

  // ── Story grouping ─────────────────────────────────────────────────────────

  describe('story grouping', () => {
    it('groups posts sharing the same relatedQuestion into one story', async () => {
      selectQueue[0] = [makePost('p1', 42, 1), makePost('p2', 42, 2)];
      executeResult = [
        makeEngagement('p1', 5, 2, 1),
        makeEngagement('p2', 3, 0, 0),
      ];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Will Bitcoin hit 100k?')];

      const response = await callGet();

      expect(response.stories).toHaveLength(1);
      const story = response.stories[0]!;
      expect(story.storyKey).toBe('42');
      expect(story.questionNumber).toBe(42);
      expect(story.storyTitle).toBe('Will Bitcoin hit 100k?');
      expect(story.postCount).toBe(2);
      expect(story.posts).toHaveLength(2);
    });

    it('creates separate stories for different relatedQuestions', async () => {
      selectQueue[0] = [
        makePost('p1', 1, 1, 'author-1'),
        makePost('p2', 2, 1, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p1', 10, 5, 2),
        makeEngagement('p2', 8, 3, 1),
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Question One'),
        makeQuestion(2, 'Question Two'),
      ];

      const response = await callGet();

      expect(response.stories).toHaveLength(2);
      const keys = response.stories.map((s) => s.storyKey);
      expect(keys).toContain('1');
      expect(keys).toContain('2');
    });

    it('posts within a story are sorted newest first', async () => {
      // DB returns posts already DESC (route also re-sorts, just verifying)
      const newPost = makePost('p-new', 42, 1);
      const oldPost = makePost('p-old', 42, 5);

      selectQueue[0] = [newPost, oldPost];
      executeResult = [makeEngagement('p-new'), makeEngagement('p-old')];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Ordering Test')];

      const response = await callGet();

      const posts = response.stories[0]!.posts;
      expect(posts[0]!.id).toBe('p-new');
      expect(posts[1]!.id).toBe('p-old');
    });

    it('posts without relatedQuestion go into the general story', async () => {
      const generalPost = makePost('p-gen', null, 2);

      selectQueue[0] = [generalPost];
      executeResult = [makeEngagement('p-gen', 10, 5, 2)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = []; // no question numbers

      const response = await callGet();

      expect(response.stories).toHaveLength(1);
      expect(response.stories[0]!.storyKey).toBe(GENERAL_STORY_KEY);
      expect(response.stories[0]!.questionNumber).toBeNull();
      expect(response.stories[0]!.storyTitle).toBe('General');
    });

    it('uses Story #N fallback title when questionNumber has no DB metadata', async () => {
      selectQueue[0] = [makePost('p1', 77, 1)];
      executeResult = [makeEngagement('p1')];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = []; // question 77 has no metadata

      const response = await callGet();

      expect(response.stories[0]!.storyTitle).toBe('Story #77');
    });
  });

  // ── Story sorting ──────────────────────────────────────────────────────────

  describe('story sorting by score', () => {
    it('ranks higher-engagement story above low-engagement story', async () => {
      selectQueue[0] = [
        makePost('p-high', 1, 1, 'author-1'),
        makePost('p-low', 2, 1, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p-high', 100, 50, 20),
        makeEngagement('p-low', 1, 0, 0),
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'High Engagement'),
        makeQuestion(2, 'Low Engagement'),
      ];

      const response = await callGet();

      expect(response.stories[0]!.storyKey).toBe('1');
      expect(response.stories[0]!.storyScore).toBeGreaterThan(
        response.stories[1]!.storyScore
      );
    });

    it('ranks more-recent story above older story with same engagement', async () => {
      selectQueue[0] = [
        makePost('p-recent', 1, 1, 'author-1'), // 1 hour old
        makePost('p-stale', 2, 36, 'author-2'), // 36 hours old
      ];
      executeResult = [
        makeEngagement('p-recent', 10, 5, 2),
        makeEngagement('p-stale', 10, 5, 2), // identical engagement
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Recent Story'),
        makeQuestion(2, 'Stale Story'),
      ];

      const response = await callGet();

      expect(response.stories[0]!.storyKey).toBe('1'); // recent wins
    });

    it('general story is always last regardless of engagement score', async () => {
      selectQueue[0] = [
        makePost('p-story', 1, 1, 'author-1'),
        makePost('p-gen', null, 1, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p-story', 1, 0, 0), // minimal engagement
        makeEngagement('p-gen', 9999, 9999, 9999), // massive engagement
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [makeQuestion(1, 'Actual Story')];

      const response = await callGet();

      expect(response.stories).toHaveLength(2);
      const last = response.stories[response.stories.length - 1]!;
      expect(last.storyKey).toBe(GENERAL_STORY_KEY);
    });
  });

  // ── Arc state multiplier ───────────────────────────────────────────────────

  describe('arc state multiplier', () => {
    it('exposes arcState on each NarrativeStory', async () => {
      selectQueue[0] = [makePost('p1', 42, 1)];
      executeResult = [makeEngagement('p1', 5, 2, 1)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Crisis Story', 'active', 'crisis')];

      const response = await callGet();

      expect(response.stories[0]!.arcState).toBe('crisis');
    });

    it('null arcState is stored as null (no boost)', async () => {
      selectQueue[0] = [makePost('p1', 42, 1)];
      executeResult = [makeEngagement('p1', 5, 2, 1)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'No Arc', 'active', null)];

      const response = await callGet();

      expect(response.stories[0]!.arcState).toBeNull();
    });

    it('crisis story outranks setup story with identical base engagement', async () => {
      selectQueue[0] = [
        makePost('p-crisis', 1, 2, 'author-1'),
        makePost('p-setup', 2, 2, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p-crisis', 10, 5, 2),
        makeEngagement('p-setup', 10, 5, 2), // exactly the same engagement
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Crisis Story', 'active', 'crisis'), // 1.4× multiplier
        makeQuestion(2, 'Setup Story', 'active', 'setup'), // 1.0× multiplier
      ];

      const response = await callGet();

      expect(response.stories[0]!.storyKey).toBe('1'); // crisis first
      expect(response.stories[0]!.storyScore).toBeGreaterThan(
        response.stories[1]!.storyScore
      );
    });

    it('resolution (0.85×) story ranks below setup (1.0×) with equal base score', async () => {
      selectQueue[0] = [
        makePost('p-res', 1, 2, 'author-1'),
        makePost('p-setup', 2, 2, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p-res', 10, 5, 2),
        makeEngagement('p-setup', 10, 5, 2),
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Resolution Story', 'active', 'resolution'), // 0.85×
        makeQuestion(2, 'Setup Story', 'active', 'setup'), // 1.0×
      ];

      const response = await callGet();

      expect(response.stories[0]!.storyKey).toBe('2'); // setup wins
    });

    it('storyScore reflects the arc multiplier applied to base score', async () => {
      const hoursOld = 3;
      selectQueue[0] = [makePost('p1', 42, hoursOld)];
      executeResult = [makeEngagement('p1', 10, 5, 2)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [
        makeQuestion(42, 'Escalation Story', 'active', 'escalation'),
      ];

      const response = await callGet();

      const story = response.stories[0]!;
      const timestamp = new Date(story.posts[0]!.timestamp);
      const expectedBase = calculateStoryScore(10, 5, 2, 1, timestamp);
      const expectedScore =
        Math.round(
          expectedBase * calculateArcStateMultiplier('escalation') * 10000
        ) / 10000;

      expect(story.storyScore).toBeCloseTo(expectedScore, 3);
    });
  });

  // ── Resolved question filtering ────────────────────────────────────────────

  describe('resolved question filtering', () => {
    it('excludes stories for resolved questions entirely', async () => {
      selectQueue[0] = [
        makePost('p-active', 1, 1, 'author-1'),
        makePost('p-resolved', 2, 1, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p-active', 10, 5, 2),
        makeEngagement('p-resolved', 100, 50, 20), // high engagement but resolved
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Active Market', 'active'),
        makeQuestion(2, 'Resolved Market', 'resolved'), // ← must be excluded
      ];

      const response = await callGet();

      const keys = response.stories.map((s) => s.storyKey);
      expect(keys).not.toContain('2');
      expect(keys).toContain('1');
      expect(response.stories).toHaveLength(1);
    });

    it('includes all stories when none are resolved', async () => {
      selectQueue[0] = [
        makePost('p1', 1, 1, 'author-1'),
        makePost('p2', 2, 1, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p1', 5, 2, 0),
        makeEngagement('p2', 3, 1, 0),
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Active Q1', 'active'),
        makeQuestion(2, 'Active Q2', 'active'),
      ];

      const response = await callGet();

      expect(response.stories).toHaveLength(2);
    });
  });

  // ── NarrativePost field mapping ────────────────────────────────────────────

  describe('NarrativePost field mapping', () => {
    it('maps all post fields to NarrativePost correctly', async () => {
      const post: PostFixture = {
        ...makePost('p1', 42, 2),
        content: 'Crypto market collapses',
        type: 'article',
        articleTitle: 'The Big Short 2.0',
        fullContent: 'Full article text here...',
        category: 'finance',
        imageUrl: 'https://cdn.feed.market/img.jpg',
      };

      selectQueue[0] = [post];
      executeResult = [makeEngagement('p1', 7, 3, 2)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Financial Crisis?')];

      const response = await callGet();
      const np = response.stories[0]!.posts[0]!;

      expect(np.id).toBe('p1');
      expect(np.content).toBe('Crypto market collapses');
      expect(np.type).toBe('article');
      expect(np.articleTitle).toBe('The Big Short 2.0');
      expect(np.fullContent).toBe('Full article text here...');
      expect(np.category).toBe('finance');
      expect(np.imageUrl).toBe('https://cdn.feed.market/img.jpg');
      expect(np.likeCount).toBe(7);
      expect(np.commentCount).toBe(3);
      expect(np.shareCount).toBe(2);
      expect(np.isLiked).toBe(false);
      expect(np.isShared).toBe(false);
      expect(np.relatedQuestion).toBe(42);
      expect(typeof np.timestamp).toBe('string'); // toISOStringStrict → ISO string
    });

    it('uses user displayName as authorName when user is found', async () => {
      selectQueue[0] = [makePost('p1', 42, 1, 'author-1')];
      executeResult = [makeEngagement('p1')];
      selectQueue[1] = [
        {
          id: 'author-1',
          username: 'alice',
          displayName: 'Alice Smith',
          profileImageUrl: null,
        },
      ];
      selectQueue[2] = [makeQuestion(42, 'Test')];

      const response = await callGet();

      expect(response.stories[0]!.posts[0]!.authorName).toBe('Alice Smith');
      expect(response.stories[0]!.posts[0]!.authorUsername).toBe('alice');
    });

    it('falls back to authorId as authorName when no user is found', async () => {
      selectQueue[0] = [makePost('p1', 42, 1, 'unknown-actor-999')];
      executeResult = [makeEngagement('p1')];
      selectQueue[1] = []; // user lookup returns empty
      selectQueue[2] = [makeQuestion(42, 'Test')];

      const response = await callGet();

      const np = response.stories[0]!.posts[0]!;
      expect(np.authorId).toBe('unknown-actor-999');
      expect(np.authorName).toBe('unknown-actor-999');
    });

    it('posts with null optional fields have null values (not undefined)', async () => {
      selectQueue[0] = [makePost('p1', 42, 1)]; // all optional fields null
      executeResult = [makeEngagement('p1')];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Null Fields Test')];

      const response = await callGet();
      const np = response.stories[0]!.posts[0]!;

      expect(np.articleTitle).toBeNull();
      expect(np.fullContent).toBeNull();
      expect(np.category).toBeNull();
      expect(np.imageUrl).toBeNull();
    });
  });

  // ── Authenticated user enrichment ──────────────────────────────────────────

  describe('authenticated user enrichment', () => {
    it('sets isLiked=true for posts the user has liked', async () => {
      authUser = { userId: 'user-123' };

      selectQueue[0] = [makePost('p1', 42, 1), makePost('p2', 42, 2)];
      executeResult = [
        makeEngagement('p1', 5, 0, 0),
        makeEngagement('p2', 3, 0, 0),
      ];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Likes Test')];
      selectQueue[3] = [{ postId: 'p1' }]; // user liked only p1
      selectQueue[4] = []; // user shared nothing

      const response = await callGet();
      const posts = response.stories[0]!.posts;

      expect(posts.find((p) => p.id === 'p1')!.isLiked).toBe(true);
      expect(posts.find((p) => p.id === 'p2')!.isLiked).toBe(false);
    });

    it('sets isShared=true for posts the user has shared', async () => {
      authUser = { userId: 'user-123' };

      selectQueue[0] = [makePost('p1', 42, 1), makePost('p2', 42, 2)];
      executeResult = [
        makeEngagement('p1', 0, 0, 3),
        makeEngagement('p2', 0, 0, 0),
      ];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Shares Test')];
      selectQueue[3] = []; // user liked nothing
      selectQueue[4] = [{ postId: 'p1' }]; // user shared p1

      const response = await callGet();
      const posts = response.stories[0]!.posts;

      expect(posts.find((p) => p.id === 'p1')!.isShared).toBe(true);
      expect(posts.find((p) => p.id === 'p2')!.isShared).toBe(false);
    });

    it('isLiked and isShared remain false when user is unauthenticated', async () => {
      authUser = null;

      selectQueue[0] = [makePost('p1', 42, 1)];
      executeResult = [makeEngagement('p1', 5, 2, 1)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Unauth Test')];
      // selectQueue[3/4] should NOT be reached

      const response = await callGet();

      const np = response.stories[0]!.posts[0]!;
      expect(np.isLiked).toBe(false);
      expect(np.isShared).toBe(false);
    });

    it('does not call reactions/shares queries when there are no postIds', async () => {
      authUser = { userId: 'user-123' };
      selectQueue[0] = []; // no posts → empty cache result

      await callGet();

      // With empty postIds, enrichment block is skipped entirely
      // Only the initial posts select should have been called
      expect(mockDbExecute).not.toHaveBeenCalled();
    });
  });

  // ── Engagement aggregation ─────────────────────────────────────────────────

  describe('engagement aggregation across story posts', () => {
    it('sums likes, comments, and shares across all posts in the story for scoring', async () => {
      // 2 posts in same story: total engagement = (10+3) likes, (5+1) comments, (2+0) shares
      selectQueue[0] = [makePost('p1', 42, 1), makePost('p2', 42, 2)];
      executeResult = [
        makeEngagement('p1', 10, 5, 2),
        makeEngagement('p2', 3, 1, 0),
      ];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Multi-Post Story')];

      const response = await callGet();
      const story = response.stories[0]!;

      // Verify score corresponds to aggregated engagement (13 likes, 6 comments, 2 shares)
      const newestTimestamp = new Date(story.posts[0]!.timestamp); // newest first
      const expectedBase = calculateStoryScore(13, 6, 2, 2, newestTimestamp);
      const expectedScore =
        Math.round(expectedBase * calculateArcStateMultiplier(null) * 10000) /
        10000;

      expect(story.storyScore).toBeCloseTo(expectedScore, 3);
    });

    it('postCount on NarrativeStory equals number of posts in the story', async () => {
      selectQueue[0] = [
        makePost('p1', 42, 1),
        makePost('p2', 42, 2),
        makePost('p3', 42, 3),
      ];
      executeResult = [
        makeEngagement('p1'),
        makeEngagement('p2'),
        makeEngagement('p3'),
      ];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Three Posts')];

      const response = await callGet();

      expect(response.stories[0]!.postCount).toBe(3);
      expect(response.stories[0]!.posts).toHaveLength(3);
    });
  });

  // ── Response contract ──────────────────────────────────────────────────────

  describe('response contract', () => {
    it('response has success, stories array, and ISO generatedAt', async () => {
      selectQueue[0] = [];

      const response = await callGet();

      expect(response.success).toBe(true);
      expect(Array.isArray(response.stories)).toBe(true);
      expect(typeof response.generatedAt).toBe('string');
      // Must be parseable as a Date
      const parsed = new Date(response.generatedAt);
      expect(isNaN(parsed.getTime())).toBe(false);
    });

    it('each NarrativeStory has all required fields', async () => {
      selectQueue[0] = [makePost('p1', 42, 1)];
      executeResult = [makeEngagement('p1', 3, 1, 0)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [
        makeQuestion(42, 'Shape Check', 'active', 'escalation'),
      ];

      const response = await callGet();
      const story = response.stories[0]! as NarrativeStory;

      expect(typeof story.storyKey).toBe('string');
      expect(typeof story.storyTitle).toBe('string');
      expect(typeof story.storyScore).toBe('number');
      expect(typeof story.postCount).toBe('number');
      expect(Array.isArray(story.posts)).toBe(true);
      expect('arcState' in story).toBe(true);
      expect('questionNumber' in story).toBe(true);
      expect(typeof story.hasUserPosition).toBe('boolean');
    });

    it('storyScore is rounded to at most 4 decimal places', async () => {
      selectQueue[0] = [makePost('p1', 42, 3)];
      executeResult = [makeEngagement('p1', 7, 3, 2)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Precision Test')];

      const response = await callGet();
      const score = response.stories[0]!.storyScore;

      // Verify Math.round(...* 10000) / 10000 was applied
      expect(Math.round(score * 10000) / 10000).toBe(score);
    });

    it('NarrativePost timestamp is an ISO 8601 string', async () => {
      selectQueue[0] = [makePost('p1', 42, 1)];
      executeResult = [makeEngagement('p1')];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(42, 'Timestamp Test')];

      const response = await callGet();
      const ts = response.stories[0]!.posts[0]!.timestamp;

      expect(typeof ts).toBe('string');
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ── Resolution proximity boost ────────────────────────────────────────────

  describe('resolution proximity boost', () => {
    it('applies 1.4x boost when question resolves within 6 hours', async () => {
      const nearFuture = new Date(Date.now() + 1000 * 60 * 60 * 3); // 3h from now

      selectQueue[0] = [
        makePost('p1', 1, 2, 'author-1'), // near resolution story
        makePost('p2', 2, 2, 'author-2'), // far future resolution (control)
      ];
      executeResult = [
        makeEngagement('p1', 10, 5, 2),
        makeEngagement('p2', 10, 5, 2), // identical engagement
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Near Resolution', 'active', null, nearFuture), // 1.4x boost
        makeQuestion(2, 'Far Resolution', 'active', null), // 1.0x boost (30 days)
      ];

      const response = await callGet();

      expect(response.stories[0]!.questionNumber).toBe(1); // near resolution wins
      expect(response.stories[0]!.storyScore).toBeGreaterThan(
        response.stories[1]!.storyScore
      );
      // Score should be ~1.4x the far resolution score
      expect(response.stories[0]!.storyScore).toBeCloseTo(
        response.stories[1]!.storyScore * 1.4,
        2
      );
    });

    it('applies no boost when question has far future resolution date', async () => {
      selectQueue[0] = [makePost('p1', 1, 2)];
      executeResult = [makeEngagement('p1', 10, 5, 2)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(1, 'Far Future', 'active', null)]; // 30 days out → 1.0

      const response = await callGet();
      const story = response.stories[0]!;

      const ts = new Date(story.posts[0]!.timestamp);
      const expectedBase = calculateStoryScore(10, 5, 2, 1, ts);
      // arc=null→1.0, boost→1.0
      const expectedScore =
        Math.round(
          expectedBase *
            calculateArcStateMultiplier(null) *
            calculateResolutionBoost(FAR_FUTURE) *
            10000
        ) / 10000;

      expect(story.storyScore).toBeCloseTo(expectedScore, 3);
    });

    it('applies no boost when resolutionDate is in the past', async () => {
      const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24); // 24h ago

      selectQueue[0] = [
        makePost('p1', 1, 2, 'author-1'), // past resolution
        makePost('p2', 2, 2, 'author-2'), // far future (control)
      ];
      executeResult = [
        makeEngagement('p1', 10, 5, 2),
        makeEngagement('p2', 10, 5, 2), // identical engagement
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Past Resolution', 'active', null, pastDate), // 1.0x (expired)
        makeQuestion(2, 'Far Resolution', 'active', null), // 1.0x (30 days)
      ];

      const response = await callGet();

      // Both should have identical scores (both 1.0 boost)
      expect(response.stories[0]!.storyScore).toBeCloseTo(
        response.stories[1]!.storyScore,
        3
      );
    });
  });

  // ── Per-user position signal ───────────────────────────────────────────────

  describe('per-user position signal', () => {
    it('sets hasUserPosition: true for stories where user holds a position', async () => {
      authUser = { userId: 'user-123' };

      selectQueue[0] = [makePost('p1', 1, 1)];
      executeResult = [makeEngagement('p1', 5, 2, 1)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(1, 'Question With Position')];
      selectQueue[3] = []; // user reactions
      selectQueue[4] = []; // user shares
      selectQueue[5] = [{ questionId: 1 }]; // user has position on question 1

      const response = await callGet();

      expect(response.stories[0]!.hasUserPosition).toBe(true);
    });

    it('sets hasUserPosition: false for stories with no user position', async () => {
      authUser = { userId: 'user-123' };

      selectQueue[0] = [makePost('p1', 1, 1)];
      executeResult = [makeEngagement('p1', 5, 2, 1)];
      selectQueue[1] = [makeUser('author-1')];
      selectQueue[2] = [makeQuestion(1, 'Question No Position')];
      selectQueue[3] = []; // user reactions
      selectQueue[4] = []; // user shares
      selectQueue[5] = []; // user has no positions

      const response = await callGet();

      expect(response.stories[0]!.hasUserPosition).toBe(false);
    });

    it('re-sorts stories with positions to the top', async () => {
      authUser = { userId: 'user-123' };

      selectQueue[0] = [
        makePost('p1', 1, 1, 'author-1'), // lower engagement
        makePost('p2', 2, 1, 'author-2'), // higher engagement
      ];
      executeResult = [
        makeEngagement('p1', 1, 0, 0), // low
        makeEngagement('p2', 100, 50, 20), // high
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Low Score Story'),
        makeQuestion(2, 'High Score Story'),
      ];
      selectQueue[3] = []; // no likes
      selectQueue[4] = []; // no shares
      selectQueue[5] = [{ questionId: 1 }]; // position on story 1 (lower score)

      const response = await callGet();

      // Story 1 (lower score but has position) should be first
      expect(response.stories[0]!.questionNumber).toBe(1);
      expect(response.stories[0]!.hasUserPosition).toBe(true);
      expect(response.stories[1]!.hasUserPosition).toBe(false);
    });

    it('general story always sorts last even when user has positions', async () => {
      authUser = { userId: 'user-123' };

      selectQueue[0] = [
        makePost('p1', 1, 1, 'author-1'),
        makePost('p-gen', null, 1, 'author-2'),
      ];
      executeResult = [
        makeEngagement('p1', 5, 2, 1),
        makeEngagement('p-gen', 5, 2, 1),
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [makeQuestion(1, 'Question Story')];
      selectQueue[3] = []; // no likes
      selectQueue[4] = []; // no shares
      selectQueue[5] = [{ questionId: 1 }]; // position on question 1

      const response = await callGet();

      const last = response.stories[response.stories.length - 1]!;
      expect(last.storyKey).toBe(GENERAL_STORY_KEY);
      // General stories never have positions (questionNumber is null)
      expect(last.hasUserPosition).toBe(false);
    });

    it('unauthenticated request has hasUserPosition: false on all stories', async () => {
      authUser = null; // not authenticated

      selectQueue[0] = [makePost('p1', 1, 1), makePost('p2', 2, 1, 'author-2')];
      executeResult = [
        makeEngagement('p1', 5, 2, 1),
        makeEngagement('p2', 3, 1, 0),
      ];
      selectQueue[1] = [makeUser('author-1'), makeUser('author-2')];
      selectQueue[2] = [
        makeQuestion(1, 'Story One'),
        makeQuestion(2, 'Story Two'),
      ];

      const response = await callGet();

      for (const story of response.stories) {
        expect(story.hasUserPosition).toBe(false);
      }
    });
  });

  // ── Mixed: multiple stories with various arc states ────────────────────────

  describe('full pipeline — mixed stories', () => {
    it('correctly orders 3 stories: active arc state, resolved excluded, general last', async () => {
      selectQueue[0] = [
        makePost('p-crisis', 1, 2, 'author-1'), // crisis arc — should rank first
        makePost('p-setup', 2, 2, 'author-2'), // setup arc — should rank second
        makePost('p-resolved', 3, 2, 'author-3'), // resolved — should be excluded
        makePost('p-general', null, 1, 'author-4'), // general — always last
      ];
      executeResult = [
        makeEngagement('p-crisis', 20, 10, 5),
        makeEngagement('p-setup', 20, 10, 5), // same engagement as crisis
        makeEngagement('p-resolved', 100, 50, 25),
        makeEngagement('p-general', 1, 0, 0),
      ];
      selectQueue[1] = [
        makeUser('author-1'),
        makeUser('author-2'),
        makeUser('author-3'),
        makeUser('author-4'),
      ];
      selectQueue[2] = [
        makeQuestion(1, 'Crisis Market', 'active', 'crisis'),
        makeQuestion(2, 'Setup Market', 'active', 'setup'),
        makeQuestion(3, 'Resolved Market', 'resolved', null),
      ];

      const response = await callGet();

      const keys = response.stories.map((s) => s.storyKey);

      // 3 resolved excluded → 3 stories: crisis, setup, general
      expect(response.stories).toHaveLength(3);
      expect(keys).not.toContain('3'); // resolved excluded

      // Crisis first
      expect(keys[0]).toBe('1');
      // General always last
      expect(keys[keys.length - 1]).toBe(GENERAL_STORY_KEY);
    });
  });
});
