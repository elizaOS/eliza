import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  MemoryType,
  Service,
  type TaskWorker,
} from "@elizaos/core";
import { createEmptyFeed, parseRssToJson } from "./parser";
import type { FeedSubscriptionMetadata, RssFeed } from "./types";

export class RssService extends Service {
  private isRunning = false;

  static serviceType = "RSS";
  capabilityDescription = "The agent is able to deal with RSS/atom feeds";

  /**
   * Fetch and parse an RSS feed from a URL
   * @param urlToFetch - The URL of the RSS feed
   * @returns Parsed RSS feed or null on error
   */
  async fetchUrl(urlToFetch: string): Promise<RssFeed | null> {
    let response: string | undefined;
    try {
      const resp = await fetch(urlToFetch);
      response = await resp.text();

      if (!response) {
        logger.warn({ url: urlToFetch }, "No response for feed URL");
        return null;
      }

      const data = parseRssToJson(response);
      if (!data || !data.title) {
        logger.warn({ url: urlToFetch }, "No RSS data found in response");
        return createEmptyFeed();
      }

      return data;
    } catch (error) {
      logger.error({ error, url: urlToFetch }, "Error fetching RSS feed");
      return null;
    }
  }

  /**
   * Subscribe to an RSS feed
   * @param url - The RSS feed URL
   * @param title - Optional feed title (will be fetched if not provided)
   */
  async subscribeFeed(url: string, title?: string): Promise<boolean> {
    try {
      const feedId = createUniqueUuid(this.runtime, `feed_sub_${url}`);

      // Check if already subscribed
      const existing = await this.runtime.getMemoriesByIds([feedId], "feedsubscriptions");
      if (existing && existing.length > 0) {
        logger.info({ url }, "Already subscribed to feed");
        return true;
      }

      // Fetch feed title if not provided
      let feedTitle = title;
      if (!feedTitle) {
        const feedData = await this.fetchUrl(url);
        if (feedData) {
          feedTitle = feedData.title;
        }
      }

      const subscriptionMemory: Memory = {
        id: feedId,
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: {
          text: feedTitle || url,
          url: url,
        },
        roomId: this.runtime.agentId,
        createdAt: Date.now(),
        metadata: {
          type: MemoryType.CUSTOM,
          subscribedAt: Date.now(),
          lastChecked: 0,
          lastItemCount: 0,
        },
      };

      await this.runtime.createMemory(subscriptionMemory, "feedsubscriptions");
      logger.info({ url, title: feedTitle }, "Subscribed to RSS feed");
      return true;
    } catch (error) {
      logger.error({ error, url }, "Error subscribing to feed");
      return false;
    }
  }

  /**
   * Unsubscribe from an RSS feed
   * @param url - The RSS feed URL
   */
  async unsubscribeFeed(url: string): Promise<boolean> {
    try {
      const feedId = createUniqueUuid(this.runtime, `feed_sub_${url}`);

      // Check if subscribed
      const existing = await this.runtime.getMemoriesByIds([feedId], "feedsubscriptions");
      if (!existing || existing.length === 0) {
        logger.warn({ url }, "Not subscribed to feed");
        return false;
      }

      await this.runtime.deleteMemory(feedId);
      logger.info({ url }, "Unsubscribed from RSS feed");
      return true;
    } catch (error) {
      logger.error({ error, url }, "Error unsubscribing from feed");
      return false;
    }
  }

  /**
   * Get all subscribed feeds
   */
  async getSubscribedFeeds(): Promise<Memory[]> {
    try {
      const feeds = await this.runtime.getMemories({
        tableName: "feedsubscriptions",
        unique: false,
      });
      return feeds || [];
    } catch (error) {
      logger.error({ error }, "Error getting subscribed feeds");
      return [];
    }
  }

  /**
   * Check all subscribed feeds and store new items
   */
  async checkAllFeeds(): Promise<void> {
    try {
      const feeds = await this.getSubscribedFeeds();
      logger.info({ count: feeds.length }, "Checking subscribed RSS feeds");

      for (const feed of feeds) {
        try {
          const url = feed.content.url;
          if (!url) {
            logger.warn({ feedId: feed.id }, "Feed subscription missing URL");
            continue;
          }

          logger.debug({ url }, "Fetching feed");
          const feedData = await this.fetchUrl(url);

          if (!feedData || !feedData.items) {
            logger.warn({ url }, "No data returned for feed");
            continue;
          }

          let newItemCount = 0;

          // Process each item with improved duplicate detection
          for (const item of feedData.items) {
            // Primary ID: based on guid
            const primaryId = createUniqueUuid(this.runtime, `${url}_${item.guid}`);

            // Fallback ID: based on title and pubDate (for feeds with inconsistent guids)
            const fallbackId = createUniqueUuid(
              this.runtime,
              `${url}_${item.title}_${item.pubDate}`
            );

            // Check both IDs to avoid duplicates
            const existingByGuid = await this.runtime.getMemoriesByIds([primaryId], "feeditems");
            const existingByTitleDate = await this.runtime.getMemoriesByIds(
              [fallbackId],
              "feeditems"
            );

            // Only create if item doesn't exist by either method
            if (
              (!existingByGuid || existingByGuid.length === 0) &&
              (!existingByTitleDate || existingByTitleDate.length === 0)
            ) {
              // Use primary ID if guid exists, otherwise use fallback
              const itemId = item.guid ? primaryId : fallbackId;

              const itemMemory: Memory = {
                id: itemId,
                entityId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                  text: item.title,
                  url: item.link,
                },
                roomId: this.runtime.agentId,
                createdAt: Date.now(),
                metadata: {
                  type: MemoryType.CUSTOM,
                  feedUrl: url,
                  feedTitle: feedData.title,
                  title: item.title,
                  link: item.link,
                  pubDate: item.pubDate,
                  description: item.description,
                  author: item.author,
                  category: item.category.join(","),
                  comments: item.comments,
                  guid: item.guid,
                },
              };

              await this.runtime.createMemory(itemMemory, "feeditems");
              newItemCount++;
            }
          }

          // Update feed subscription metadata
          if (!feed.id) {
            continue;
          }
          const currentMetadata = feed.metadata as FeedSubscriptionMetadata;
          await this.runtime.updateMemory({
            id: feed.id,
            metadata: {
              type: MemoryType.CUSTOM,
              subscribedAt: currentMetadata.subscribedAt ?? Date.now(),
              lastChecked: Date.now(),
              lastItemCount: feedData.items.length,
            },
          });

          if (newItemCount > 0) {
            logger.info(
              { count: newItemCount, feed: feedData.title || url },
              "Found new items from feed"
            );
          } else {
            logger.debug({ feed: feedData.title || url }, "No new items from feed");
          }
        } catch (error) {
          logger.error({ error, url: feed.content.url }, "Error checking feed");
        }
      }

      logger.info("Completed checking all RSS feeds");
    } catch (error) {
      logger.error({ error }, "Error in checkAllFeeds");
    }
  }

  /**
   * Load initial feeds from environment configuration
   */
  private async loadInitialFeeds(): Promise<void> {
    const rssFeeds = this.runtime.getSetting("RSS_FEEDS");

    if (!rssFeeds) {
      logger.debug("No RSS_FEEDS configured in environment");
      return;
    }

    try {
      let feedUrls: string[] = [];

      // Try to parse as JSON array first
      if (typeof rssFeeds === "string") {
        try {
          const parsed = JSON.parse(rssFeeds);
          if (Array.isArray(parsed)) {
            feedUrls = parsed;
          } else {
            // Treat as comma-separated list
            feedUrls = rssFeeds
              .split(",")
              .map((url) => url.trim())
              .filter((url) => url.length > 0);
          }
        } catch {
          // Not JSON, treat as comma-separated
          feedUrls = rssFeeds
            .split(",")
            .map((url) => url.trim())
            .filter((url) => url.length > 0);
        }
      } else if (Array.isArray(rssFeeds)) {
        feedUrls = rssFeeds;
      }

      logger.info({ count: feedUrls.length }, "Loading RSS feeds from configuration");

      for (const url of feedUrls) {
        await this.subscribeFeed(url);
      }

      logger.info("Completed loading initial RSS feeds");
    } catch (error) {
      logger.error({ error }, "Error loading initial RSS feeds from configuration");
    }
  }

  /**
   * Register the RSS feed check task worker
   */
  private registerFeedCheckWorker(): void {
    const worker: TaskWorker = {
      name: "RSS_FEED_CHECK",
      validate: async (_runtime, _message) => {
        return true;
      },
      execute: async (runtime) => {
        try {
          logger.debug("Executing RSS feed check task");
          const rssService = runtime.getService("RSS") as RssService;
          if (rssService) {
            await rssService.checkAllFeeds();
          }
        } catch (error) {
          logger.error({ error }, "Error executing RSS feed check task");
        }
      },
    };

    this.runtime.registerTaskWorker(worker);
    logger.info("Registered RSS_FEED_CHECK task worker");
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("RSS service is already running");
      return;
    }

    try {
      logger.info("Starting RSS service...");

      // Register the feed check task worker
      this.registerFeedCheckWorker();

      // Load initial feeds from environment configuration
      await this.loadInitialFeeds();

      // Create periodic feed check task
      const checkIntervalSetting = this.runtime.getSetting("RSS_CHECK_INTERVAL_MINUTES");
      const checkIntervalMinutes =
        typeof checkIntervalSetting === "number" ? checkIntervalSetting : 15;
      const intervalInMs = checkIntervalMinutes * 60 * 1000;

      await this.runtime.createTask({
        name: "RSS_FEED_CHECK",
        description: "Periodically check RSS feeds for new items",
        worldId: this.runtime.agentId,
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updateInterval: intervalInMs,
        },
        tags: ["queue", "repeat", "rss"],
      });

      logger.info({ interval: checkIntervalMinutes }, "RSS periodic feed check task created");

      this.isRunning = true;
      logger.info("RSS service started successfully");
    } catch (error) {
      logger.error({ error }, "Error starting RSS service");
      throw error;
    }
  }

  /**
   * Start the RSS service with the given runtime.
   */
  static async start(runtime: IAgentRuntime): Promise<RssService> {
    const service = new RssService(runtime);
    await service.start();
    return service;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("RSS service is not running");
      return;
    }

    try {
      logger.info("Stopping RSS service...");

      this.isRunning = false;
      logger.info("RSS service stopped successfully");
    } catch (error) {
      logger.error({ error }, "Error stopping RSS service");
      throw error;
    }
  }

  /**
   * Stops the RSS service associated with the given runtime.
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(RssService.serviceType);
    if (!service) {
      throw new Error(`${RssService.serviceType} service not found`);
    }
    await service.stop();
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}

// Legacy export for backwards compatibility
export const rssService = RssService;
