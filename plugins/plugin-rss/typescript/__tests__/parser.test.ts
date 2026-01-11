import { describe, expect, test } from "vitest";
import { createEmptyFeed, parseRssToJson } from "../parser";
import { extractUrls, formatRelativeTime } from "../utils";

describe("RSS Parser", () => {
  test("should parse basic RSS 2.0 feed", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://example.com</link>
          <description>A test RSS feed</description>
          <item>
            <title>Test Article</title>
            <link>https://example.com/article1</link>
            <description>This is a test article</description>
            <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
            <guid>article-1</guid>
          </item>
        </channel>
      </rss>`;

    const feed = parseRssToJson(xml);

    expect(feed.title).toBe("Test Feed");
    expect(feed.link).toBe("https://example.com");
    expect(feed.description).toBe("A test RSS feed");
    expect(feed.items.length).toBe(1);
    expect(feed.items[0].title).toBe("Test Article");
    expect(feed.items[0].guid).toBe("article-1");
  });

  test("should parse RSS with multiple categories", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <item>
            <title>Multi-category Article</title>
            <category>Tech</category>
            <category>News</category>
            <category>AI</category>
          </item>
        </channel>
      </rss>`;

    const feed = parseRssToJson(xml);

    expect(feed.items.length).toBe(1);
    expect(feed.items[0].category).toContain("Tech");
    expect(feed.items[0].category).toContain("News");
    expect(feed.items[0].category).toContain("AI");
  });

  test("should parse RSS with enclosure", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Podcast Feed</title>
          <item>
            <title>Episode 1</title>
            <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="12345678"/>
          </item>
        </channel>
      </rss>`;

    const feed = parseRssToJson(xml);

    expect(feed.items.length).toBe(1);
    expect(feed.items[0].enclosure).not.toBeNull();
    expect(feed.items[0].enclosure?.url).toBe("https://example.com/ep1.mp3");
    expect(feed.items[0].enclosure?.type).toBe("audio/mpeg");
  });

  test("should parse RSS with CDATA", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <item>
            <title>CDATA Article</title>
            <description><![CDATA[<p>HTML content here</p>]]></description>
          </item>
        </channel>
      </rss>`;

    const feed = parseRssToJson(xml);

    expect(feed.items.length).toBe(1);
    expect(feed.items[0].description).toContain("<p>HTML content here</p>");
  });

  test("should create empty feed", () => {
    const feed = createEmptyFeed();

    expect(feed.title).toBe("");
    expect(feed.items).toEqual([]);
  });
});

describe("URL Extraction", () => {
  test("should extract HTTP URLs", () => {
    const text = "Check out https://example.com and http://test.com for more.";
    const urls = extractUrls(text);

    expect(urls.length).toBe(2);
    expect(urls.some((u) => u.includes("example.com"))).toBe(true);
    expect(urls.some((u) => u.includes("test.com"))).toBe(true);
  });

  test("should extract www URLs", () => {
    const text = "Visit www.example.com for details.";
    const urls = extractUrls(text);

    expect(urls.length).toBe(1);
    expect(urls[0].startsWith("http://www.example.com")).toBe(true);
  });

  test("should extract URLs with paths", () => {
    const text = "Read https://example.com/blog/post-1?id=123";
    const urls = extractUrls(text);

    expect(urls.length).toBe(1);
    expect(urls[0]).toContain("example.com/blog/post-1");
  });

  test("should strip trailing punctuation", () => {
    const text = "See https://example.com. Also https://test.com!";
    const urls = extractUrls(text);

    expect(urls.length).toBe(2);
    expect(urls.every((u) => !u.endsWith(".") && !u.endsWith("!"))).toBe(true);
  });

  test("should deduplicate URLs", () => {
    const text = "Visit https://example.com and https://example.com again.";
    const urls = extractUrls(text);

    expect(urls.length).toBe(1);
  });

  test("should handle text with no URLs", () => {
    const text = "This text has no URLs.";
    const urls = extractUrls(text);

    expect(urls.length).toBe(0);
  });
});

describe("Relative Time Formatting", () => {
  test("should format just now", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 30000); // 30 seconds ago

    expect(result).toBe("just now");
  });

  test("should format minutes ago", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 5 * 60000); // 5 minutes ago

    expect(result).toContain("5 minute");
  });

  test("should format hours ago", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 3 * 60 * 60000); // 3 hours ago

    expect(result).toContain("3 hour");
  });

  test("should format days ago", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 2 * 24 * 60 * 60000); // 2 days ago

    expect(result).toContain("2 day");
  });
});
