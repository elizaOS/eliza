/**
 * Feed Health Integration Tests
 *
 * Validates the feed health report and dedup guards using pure in-memory
 * logic — no DB required. Simulates the same checks used by scripts/feed-health.ts
 * and the cross-NPC dedup guard in DirectExecutors.
 *
 * NOTE: The arc event coverage and breaking article rate limiter now use DB queries.
 * Those paths are tested via the unit tests in feed-dedup.test.ts (logic layer)
 * and would be validated with a live DB in E2E / manual testing.
 */

import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Helpers — mirror the feed-health.ts logic exactly
// ---------------------------------------------------------------------------

function jaccardSimilarity(content1: string, content2: string): number {
  const words1 = new Set(
    content1
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  const words2 = new Set(
    content2
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

function firstNWords(text: string, n: number): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, n)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '');
}

interface Post {
  id: string;
  content: string;
  authorId: string;
  type: string;
  timestamp: Date;
}

function detectExactDupes(
  posts: Post[],
  windowMs: number
): Array<{ content: string; count: number; authors: string[] }> {
  const windowStart = new Date(Date.now() - windowMs);
  const recent = posts.filter((p) => p.timestamp >= windowStart);
  const contentMap = new Map<string, { count: number; authors: string[] }>();

  for (const p of recent) {
    const key = p.content.trim().toLowerCase();
    const entry = contentMap.get(key) ?? { count: 0, authors: [] };
    entry.count++;
    if (!entry.authors.includes(p.authorId)) entry.authors.push(p.authorId);
    contentMap.set(key, entry);
  }

  return Array.from(contentMap.entries())
    .filter(([, v]) => v.count > 1)
    .map(([content, v]) => ({ content, ...v }));
}

function detectFirstWordsDupes(
  posts: Post[],
  windowMs: number,
  n = 8
): Array<{ prefix: string; count: number; authors: string[] }> {
  const windowStart = new Date(Date.now() - windowMs);
  const recent = posts.filter((p) => p.timestamp >= windowStart);
  const prefixMap = new Map<string, { count: number; authors: string[] }>();

  for (const p of recent) {
    const prefix = firstNWords(p.content, n);
    if (prefix.split(' ').length < 4) continue;
    const entry = prefixMap.get(prefix) ?? { count: 0, authors: [] };
    entry.count++;
    if (!entry.authors.includes(p.authorId)) entry.authors.push(p.authorId);
    prefixMap.set(prefix, entry);
  }

  return Array.from(prefixMap.entries())
    .filter(([, v]) => v.count > 1 && v.authors.length > 1)
    .map(([prefix, v]) => ({ prefix, ...v }));
}

function detectArticleFlood(
  posts: Post[],
  windowHours: number,
  maxPerHour: number
): Array<{ hour: string; count: number; isFlood: boolean }> {
  const now = Date.now();
  const buckets: Array<{ hour: string; count: number; isFlood: boolean }> = [];

  for (let h = 0; h < windowHours; h++) {
    const bucketStart = new Date(now - (h + 1) * 3600_000);
    const bucketEnd = new Date(now - h * 3600_000);
    const count = posts.filter(
      (p) =>
        p.type === 'article' &&
        p.timestamp >= bucketStart &&
        p.timestamp < bucketEnd
    ).length;
    buckets.unshift({
      hour: bucketStart.toISOString().slice(0, 13),
      count,
      isFlood: count > maxPerHour,
    });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// 1. Exact duplicate detection
// ---------------------------------------------------------------------------
describe('feed health — exact duplicate detection', () => {
  const base = new Date(Date.now() - 5 * 60_000); // 5 min ago

  test('no duplicates when all content is unique', () => {
    const posts: Post[] = [
      {
        id: '1',
        content: 'Bitcoin surges to new highs',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
      {
        id: '2',
        content: 'Federal reserve holds rates steady',
        authorId: 'npc-b',
        type: 'post',
        timestamp: base,
      },
    ];
    expect(detectExactDupes(posts, 60 * 60_000)).toHaveLength(0);
  });

  test('detects exact duplicate from two different NPCs', () => {
    const posts: Post[] = [
      {
        id: '1',
        content: 'Bitcoin hits 100k',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
      {
        id: '2',
        content: 'Bitcoin hits 100k',
        authorId: 'npc-b',
        type: 'post',
        timestamp: base,
      },
    ];
    const dupes = detectExactDupes(posts, 60 * 60_000);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.count).toBe(2);
    expect(dupes[0]?.authors).toContain('npc-a');
    expect(dupes[0]?.authors).toContain('npc-b');
  });

  test('ignores posts outside time window', () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000); // 2h ago
    const posts: Post[] = [
      {
        id: '1',
        content: 'Old duplicate post content here',
        authorId: 'npc-a',
        type: 'post',
        timestamp: old,
      },
      {
        id: '2',
        content: 'Old duplicate post content here',
        authorId: 'npc-b',
        type: 'post',
        timestamp: old,
      },
    ];
    // Window is only 30 min
    expect(detectExactDupes(posts, 30 * 60_000)).toHaveLength(0);
  });

  test('same author posting same content twice is flagged', () => {
    const posts: Post[] = [
      {
        id: '1',
        content: 'Interesting development in markets today',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
      {
        id: '2',
        content: 'Interesting development in markets today',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
    ];
    const dupes = detectExactDupes(posts, 60 * 60_000);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. First-N-words near-dupe detection
// ---------------------------------------------------------------------------
describe('feed health — first-N-words near-dupe detection', () => {
  const base = new Date(Date.now() - 5 * 60_000);

  test('catches near-duplicates across different authors', () => {
    const posts: Post[] = [
      {
        id: '1',
        content:
          'Feed social platform launches exciting prediction markets feature today',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
      {
        id: '2',
        content:
          'Feed social platform launches exciting prediction markets feature now',
        authorId: 'npc-b',
        type: 'post',
        timestamp: base,
      },
    ];
    const dupes = detectFirstWordsDupes(posts, 30 * 60_000, 8);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.authors).toContain('npc-a');
    expect(dupes[0]?.authors).toContain('npc-b');
  });

  test('does NOT flag same prefix from same author', () => {
    const posts: Post[] = [
      {
        id: '1',
        content:
          'Feed social platform launches exciting prediction markets today',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
      {
        id: '2',
        content:
          'Feed social platform launches exciting prediction markets now',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
    ];
    // Same author — first-words dedup requires authors.length > 1
    const dupes = detectFirstWordsDupes(posts, 30 * 60_000, 8);
    expect(dupes).toHaveLength(0);
  });

  test('ignores very short prefixes (< 4 words)', () => {
    const posts: Post[] = [
      {
        id: '1',
        content: 'ok good',
        authorId: 'npc-a',
        type: 'post',
        timestamp: base,
      },
      {
        id: '2',
        content: 'ok good',
        authorId: 'npc-b',
        type: 'post',
        timestamp: base,
      },
    ];
    const dupes = detectFirstWordsDupes(posts, 30 * 60_000, 8);
    expect(dupes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Article flood detection
// ---------------------------------------------------------------------------
describe('feed health — article flood detection', () => {
  test('flags hour with more than maxPerHour articles', () => {
    const now = Date.now();
    const posts: Post[] = Array.from({ length: 8 }, (_, i) => ({
      id: `art-${i}`,
      content: `Article ${i} content here`,
      authorId: 'org-media',
      type: 'article',
      timestamp: new Date(now - 30 * 60_000), // 30 min ago (in current bucket)
    }));

    const buckets = detectArticleFlood(posts, 1, 6);
    expect(buckets[0]?.isFlood).toBe(true);
    expect(buckets[0]?.count).toBe(8);
  });

  test('does not flag hour within limit', () => {
    const now = Date.now();
    const posts: Post[] = Array.from({ length: 2 }, (_, i) => ({
      id: `art-${i}`,
      content: `Article ${i}`,
      authorId: 'org-media',
      type: 'article',
      timestamp: new Date(now - 30 * 60_000),
    }));

    const buckets = detectArticleFlood(posts, 1, 6);
    expect(buckets[0]?.isFlood).toBe(false);
  });

  test('only counts article type posts', () => {
    const now = Date.now();
    const posts: Post[] = Array.from({ length: 10 }, (_, i) => ({
      id: `p-${i}`,
      content: `Post ${i} content here`,
      authorId: 'npc-a',
      type: 'post', // NOT article
      timestamp: new Date(now - 30 * 60_000),
    }));

    const buckets = detectArticleFlood(posts, 1, 6);
    expect(buckets[0]?.count).toBe(0);
    expect(buckets[0]?.isFlood).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-NPC dedup guard (mirrors DirectExecutors logic)
// ---------------------------------------------------------------------------
describe('cross-NPC dedup guard (integration)', () => {
  const THRESHOLD = 0.5;

  function wouldBeBlocked(newContent: string, recentPosts: Post[]): boolean {
    for (const p of recentPosts) {
      const sim = jaccardSimilarity(newContent, p.content);
      if (sim >= THRESHOLD) return true;
    }
    return false;
  }

  test('first NPC to post a topic is always allowed', () => {
    const recent: Post[] = [];
    const newContent =
      'Federal Reserve announces surprise rate cut of fifty basis points today';
    expect(wouldBeBlocked(newContent, recent)).toBe(false);
  });

  test('second NPC posting near-identical content is blocked', () => {
    const recent: Post[] = [
      {
        id: '1',
        content:
          'Federal Reserve announces surprise rate cut of fifty basis points today',
        authorId: 'npc-a',
        type: 'post',
        timestamp: new Date(),
      },
    ];
    const newContent =
      'Federal Reserve announces surprise rate cut of fifty basis points today';
    expect(wouldBeBlocked(newContent, recent)).toBe(true);
  });

  test('NPC posting about a completely different topic is allowed', () => {
    const recent: Post[] = [
      {
        id: '1',
        content:
          'Federal Reserve announces surprise rate cut of fifty basis points today',
        authorId: 'npc-a',
        type: 'post',
        timestamp: new Date(),
      },
    ];
    const newContent =
      'Scientists discover massive undersea volcano erupting near Pacific coast';
    expect(wouldBeBlocked(newContent, recent)).toBe(false);
  });
});
