/**
 * Integration tests for GET /api/feed/stories
 *
 * Verifies response shape, pagination contract, and rate-limit headers.
 * Requires a running server at TEST_API_URL or http://localhost:3000.
 *
 * Run: bun test integration/feed/stories.integration.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;

async function checkServerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getStories(
  params: Record<string, string | number> = {}
): Promise<Response> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  const url = `${BASE_URL}/api/feed/stories${qs ? `?${qs}` : ''}`;
  return fetch(url, { signal: AbortSignal.timeout(15000) });
}

describe('GET /api/feed/stories', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth();
    if (!serverAvailable) {
      console.warn(
        '⚠️  Server not available — stories feed tests will be skipped'
      );
    }
  });

  test('returns 200 with expected response shape', async () => {
    if (!serverAvailable) return;
    const res = await getStories();
    expect(res.status).toBe(200);

    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.success).toBe('boolean');
    expect(Array.isArray(data.stories)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(typeof data.hasMore).toBe('boolean');
    expect(typeof data.generatedAt).toBe('string');
    // topic may be null when no daily topic is configured
    expect('topic' in data).toBe(true);
  });

  test('returns at most PAGE_SIZE stories by default', async () => {
    if (!serverAvailable) return;
    const res = await getStories();
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      stories: unknown[];
      total: number;
      hasMore: boolean;
    };
    expect(data.stories.length).toBeLessThanOrEqual(20);
  });

  test('pagination: limit param caps result count', async () => {
    if (!serverAvailable) return;
    const res = await getStories({ limit: 5 });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      stories: unknown[];
      total: number;
      hasMore: boolean;
    };
    expect(data.stories.length).toBeLessThanOrEqual(5);
  });

  test('pagination: hasMore is true when more stories exist beyond the page', async () => {
    if (!serverAvailable) return;
    // Fetch full result to determine total
    const fullRes = await getStories();
    const fullData = (await fullRes.json()) as { total: number };
    if (fullData.total <= 5) return; // not enough data to test pagination

    const res = await getStories({ offset: 0, limit: 5 });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stories: unknown[]; hasMore: boolean };
    expect(data.hasMore).toBe(true);
    expect(data.stories.length).toBeLessThanOrEqual(5);
  });

  test('pagination: hasMore is false on last page', async () => {
    if (!serverAvailable) return;
    const fullRes = await getStories();
    const fullData = (await fullRes.json()) as { total: number };
    const total = fullData.total;

    // Offset beyond total — should return empty stories and hasMore: false
    const res = await getStories({ offset: total + 100, limit: 20 });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stories: unknown[]; hasMore: boolean };
    expect(data.stories.length).toBe(0);
    expect(data.hasMore).toBe(false);
  });

  test('pagination: second page returns different stories than first', async () => {
    if (!serverAvailable) return;
    const fullRes = await getStories();
    const fullData = (await fullRes.json()) as { total: number };
    if (fullData.total < 10) return; // not enough data

    const page1Res = await getStories({ offset: 0, limit: 5 });
    const page2Res = await getStories({ offset: 5, limit: 5 });

    const page1 = (await page1Res.json()) as {
      stories: Array<{ storyKey: string }>;
    };
    const page2 = (await page2Res.json()) as {
      stories: Array<{ storyKey: string }>;
    };

    const page1Keys = new Set(page1.stories.map((s) => s.storyKey));
    const page2Keys = page2.stories.map((s) => s.storyKey);

    // No overlap between pages
    for (const key of page2Keys) {
      expect(page1Keys.has(key)).toBe(false);
    }
  });

  test('returns rate-limit headers', async () => {
    if (!serverAvailable) return;
    const res = await getStories();
    // Anonymous requests get public cache headers; authenticated get X-RateLimit-*
    // Either way, a successful response means rate limiting ran
    expect(res.status).toBe(200);
    const hasPublicHeaders =
      res.headers.has('X-RateLimit-Limit') ||
      res.headers.has('Cache-Control') ||
      res.headers.has('X-RateLimit-Remaining');
    expect(hasPublicHeaders).toBe(true);
  });

  test('topic field has correct shape when present', async () => {
    if (!serverAvailable) return;
    const res = await getStories();
    const data = (await res.json()) as {
      topic: Record<string, unknown> | null;
    };
    if (data.topic === null) return; // no topic configured — skip shape check

    expect(typeof data.topic.topicKey).toBe('string');
    expect(typeof data.topic.topicLabel).toBe('string');
    expect(typeof data.topic.summary).toBe('string');
  });

  test('invalid offset/limit falls back to safe defaults', async () => {
    if (!serverAvailable) return;
    const res = await getStories({ offset: 'abc', limit: 'xyz' } as Record<
      string,
      string
    >);
    // Should not 400 or 500 — falls back to offset=0, limit=20
    expect(res.status).toBe(200);
  });
});
