/**
 * RSS Feed Service Unit Tests
 *
 * These are true unit tests that test RSS parsing logic without database access.
 * For database integration tests, see tests/integration/
 */

import { describe, expect, test } from 'bun:test';
import { rssFeedService } from '@feed/engine';

describe('RSSFeedService', () => {
  test('should parse RSS 2.0 format', async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Test Item 1</title>
      <link>https://example.com/item1</link>
      <pubDate>Wed, 13 Nov 2024 12:00:00 GMT</pubDate>
      <description>Test description</description>
    </item>
    <item>
      <title>Test Item 2</title>
      <link>https://example.com/item2</link>
    </item>
  </channel>
</rss>`;

    // Mock fetch for this test
    const originalFetch = global.fetch;
    const mockFetch = async () =>
      ({
        ok: true,
        text: async () => rssXml,
      }) as Response;
    (mockFetch as unknown as typeof fetch).preconnect = fetch.preconnect;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const feed = await rssFeedService.fetchFeed(
        'https://example.com/test.xml'
      );

      expect(feed).toBeDefined();
      expect(feed.title).toBe('Test Feed');
      expect(feed.items).toHaveLength(2);
      expect(feed.items[0]?.title).toBe('Test Item 1');
      expect(feed.items[0]?.link).toBe('https://example.com/item1');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should handle fetch errors gracefully', async () => {
    // Mock fetch to fail
    const originalFetch = global.fetch;
    const mockFetch = async () =>
      ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as Response;
    (mockFetch as unknown as typeof fetch).preconnect = fetch.preconnect;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        rssFeedService.fetchFeed('https://example.com/nonexistent.xml')
      ).rejects.toThrow();
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('service should be defined with expected methods', () => {
    expect(rssFeedService).toBeDefined();
    expect(typeof rssFeedService.fetchFeed).toBe('function');
  });
});
