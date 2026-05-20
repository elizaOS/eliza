import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockDbSelect = mock();

const postsMock = {
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
  originalPostId: 'posts.originalPostId',
  deletedAt: 'posts.deletedAt',
  commentOnPostId: 'posts.commentOnPostId',
  parentCommentId: 'posts.parentCommentId',
};

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  const noop = () => chain;
  chain.from = noop;
  chain.where = noop;
  chain.orderBy = noop;
  chain.limit = noop;
  chain.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (error: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (error: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  chain.finally = (cb: () => void) => Promise.resolve(result).finally(cb);
  return chain;
}

mock.module('@feed/db', () => ({
  and: (...args: unknown[]) => args,
  db: { select: mockDbSelect },
  gte: (a: unknown, b: unknown) => [a, b],
  isNull: (value: unknown) => value,
  lt: (a: unknown, b: unknown) => [a, b],
  posts: postsMock,
  sql: (_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    sql: true,
  }),
}));

const { loadDiscoveryForYouCandidatePosts, loadHistoricalForYouBackfillPosts } =
  await import('./historicalBackfill');

describe('historical For You backfill helpers', () => {
  beforeEach(() => {
    mockDbSelect.mockReset();
  });

  it('returns no rows without querying when backfill capacity is zero', async () => {
    const result = await loadHistoricalForYouBackfillPosts(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-15T00:00:00.000Z'),
      0
    );

    expect(result).toEqual([]);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('loads historical backfill posts from source tables', async () => {
    const rows = [
      {
        id: 'post-1',
        content: 'hello',
        authorId: 'author-1',
        timestamp: new Date('2026-03-14T00:00:00.000Z'),
        type: 'post',
        articleTitle: null,
        fullContent: null,
        category: null,
        imageUrl: null,
        relatedQuestion: null,
        originalPostId: null,
      },
    ];

    mockDbSelect.mockImplementation(() => makeChain(rows));

    const result = await loadHistoricalForYouBackfillPosts(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-15T00:00:00.000Z'),
      10
    );

    expect(result).toEqual(rows);
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('loads discovery candidates from source tables', async () => {
    const rows = [
      {
        id: 'post-2',
        content: 'discovery',
        authorId: 'author-2',
        timestamp: new Date('2026-03-10T00:00:00.000Z'),
        type: 'post',
        articleTitle: null,
        fullContent: null,
        category: null,
        imageUrl: null,
        relatedQuestion: null,
        originalPostId: null,
      },
    ];

    mockDbSelect.mockImplementation(() => makeChain(rows));

    const result = await loadDiscoveryForYouCandidatePosts(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-15T00:00:00.000Z'),
      20
    );

    expect(result).toEqual(rows);
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });
});
