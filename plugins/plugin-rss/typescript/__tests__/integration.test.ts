import { describe, expect, it } from "vitest";

describe("RSS Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export rssPlugin", async () => {
      const { rssPlugin } = await import("../index");
      expect(rssPlugin).toBeDefined();
      expect(rssPlugin.name).toBe("rss");
    });

    it("should have correct description", async () => {
      const { rssPlugin } = await import("../index");
      expect(rssPlugin.description).toContain("RSS");
    });

    it("should have services defined", async () => {
      const { rssPlugin } = await import("../index");
      expect(rssPlugin.services).toBeDefined();
      expect(Array.isArray(rssPlugin.services)).toBe(true);
    });

    it("should have providers defined", async () => {
      const { rssPlugin } = await import("../index");
      expect(rssPlugin.providers).toBeDefined();
      expect(Array.isArray(rssPlugin.providers)).toBe(true);
    });

    it("should have actions defined", async () => {
      const { rssPlugin } = await import("../index");
      expect(rssPlugin.actions).toBeDefined();
      expect(Array.isArray(rssPlugin.actions)).toBe(true);
    });

    it("should have init function", async () => {
      const { rssPlugin } = await import("../index");
      expect(typeof rssPlugin.init).toBe("function");
    });

    it("should have tests defined", async () => {
      const { rssPlugin } = await import("../index");
      expect(rssPlugin.tests).toBeDefined();
    });
  });

  describe("Actions", () => {
    it("should export getFeedAction", async () => {
      const { getFeedAction } = await import("../actions");
      expect(getFeedAction).toBeDefined();
      expect(getFeedAction.name).toBe("GET_NEWSFEED");
    });

    it("should export subscribeFeedAction", async () => {
      const { subscribeFeedAction } = await import("../actions");
      expect(subscribeFeedAction).toBeDefined();
    });

    it("should export unsubscribeFeedAction", async () => {
      const { unsubscribeFeedAction } = await import("../actions");
      expect(unsubscribeFeedAction).toBeDefined();
    });

    it("should export listFeedsAction", async () => {
      const { listFeedsAction } = await import("../actions");
      expect(listFeedsAction).toBeDefined();
    });
  });

  describe("Providers", () => {
    it("should export feedItemsProvider", async () => {
      const { feedItemsProvider } = await import("../providers");
      expect(feedItemsProvider).toBeDefined();
      expect(feedItemsProvider.name).toBe("FEEDITEMS");
    });
  });

  describe("Parser", () => {
    it("should parse valid RSS", async () => {
      const { parseRssToJson } = await import("../parser");

      const sampleRss = `<?xml version="1.0"?>
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

      const feed = parseRssToJson(sampleRss);

      expect(feed.title).toBe("Test Feed");
      expect(feed.items.length).toBe(1);
      expect(feed.items[0].title).toBe("Test Article");
    });
  });

  describe("Utils", () => {
    it("should extract URLs from text", async () => {
      const { extractUrls } = await import("../utils");

      const text = "Check out https://example.com/feed.rss and http://test.com for more.";
      const urls = extractUrls(text);

      expect(urls.length).toBe(2);
      expect(urls.some((u) => u.includes("example.com"))).toBe(true);
    });
  });

  describe("Service", () => {
    it("should export RssService", async () => {
      const { RssService } = await import("../service");
      expect(RssService).toBeDefined();
    });
  });
});
