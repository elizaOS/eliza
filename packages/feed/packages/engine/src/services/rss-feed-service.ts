/**
 * RSS Feed Service
 *
 * Fetches and parses RSS feeds from news sources without requiring API keys.
 * Uses standard RSS/Atom feed formats that are publicly available.
 *
 * @module services/rss-feed-service
 */

import type { RSSHeadline } from "@feed/db";
import {
  and,
  db,
  desc,
  eq,
  gte,
  lt,
  parodyHeadlines,
  rssFeedSources,
  rssHeadlines,
  sql,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { parseStringPromise } from "xml2js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type Xml2JsFeed = {
  rss?: {
    channel?: Array<{
      title?: string[];
      item?: Array<Record<string, JsonValue>>;
    }>;
  };
  feed?: {
    title?: string[];
    entry?: Array<Record<string, JsonValue>>;
  };
};

export interface RSSFeedItem {
  title: string;
  link?: string;
  pubDate?: string;
  description?: string;
  content?: string;
  guid?: string;
}

export interface ParsedFeed {
  title: string;
  items: RSSFeedItem[];
}

/**
 * RSS Feed Service
 * Handles fetching, parsing, and storing RSS feed data
 */
export class RSSFeedService {
  /**
   * Fetch and parse RSS feed from URL with exponential retry
   */
  async fetchFeed(url: string, maxRetries = 3): Promise<ParsedFeed> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Exponential backoff: 1s, 2s, 4s
        if (attempt > 0) {
          const delayMs = 2 ** (attempt - 1) * 1000;
          logger.info(
            `Retrying RSS feed fetch (attempt ${attempt + 1}/${maxRetries})`,
            { url, delayMs },
            "RSSFeedService",
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; FeedBot/1.0)",
          },
          signal: AbortSignal.timeout(15000), // 15 second timeout
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const xmlText = await response.text();
        const parsed = (await parseStringPromise(xmlText)) as Xml2JsFeed;

        // Handle RSS 2.0 format
        if (parsed.rss?.channel?.[0]) {
          const channel = parsed.rss.channel[0];
          return {
            title: channel.title?.[0] || "Unknown Feed",
            items: (channel.item || []).map(
              (item: Record<string, JsonValue>) => {
                const title = Array.isArray(item.title)
                  ? item.title[0]
                  : item.title;
                const link = Array.isArray(item.link)
                  ? item.link[0]
                  : item.link;
                const pubDate = Array.isArray(item.pubDate)
                  ? item.pubDate[0]
                  : item.pubDate;
                const description = Array.isArray(item.description)
                  ? item.description[0]
                  : item.description;
                const content = Array.isArray(item["content:encoded"])
                  ? item["content:encoded"][0]
                  : item["content:encoded"];
                const guidRaw = Array.isArray(item.guid)
                  ? item.guid[0]
                  : item.guid;
                const guid =
                  typeof guidRaw === "object" &&
                  guidRaw !== null &&
                  !Array.isArray(guidRaw) &&
                  "_" in guidRaw
                    ? (guidRaw as { _?: JsonValue })._
                    : guidRaw;

                return {
                  title: typeof title === "string" ? title : "",
                  link: typeof link === "string" ? link : undefined,
                  pubDate: typeof pubDate === "string" ? pubDate : undefined,
                  description:
                    typeof description === "string" ? description : undefined,
                  content: typeof content === "string" ? content : undefined,
                  guid:
                    typeof guid === "string"
                      ? guid
                      : typeof guid === "number"
                        ? String(guid)
                        : undefined,
                };
              },
            ),
          };
        }

        // Handle Atom format
        if (parsed.feed?.entry) {
          return {
            title: parsed.feed.title?.[0] || "Unknown Feed",
            items: (parsed.feed.entry || []).map(
              (entry: Record<string, JsonValue>) => {
                const title = Array.isArray(entry.title)
                  ? entry.title[0]
                  : entry.title;
                const linkRaw = Array.isArray(entry.link)
                  ? entry.link[0]
                  : entry.link;
                const linkObj =
                  typeof linkRaw === "object" &&
                  linkRaw !== null &&
                  !Array.isArray(linkRaw) &&
                  "$" in linkRaw
                    ? (linkRaw as { $?: { href?: JsonValue } }).$
                    : undefined;
                const link = linkObj?.href;
                const pubDate = Array.isArray(entry.published)
                  ? entry.published[0]
                  : entry.published;
                const description = Array.isArray(entry.summary)
                  ? entry.summary[0]
                  : entry.summary;
                const content = Array.isArray(entry.content)
                  ? entry.content[0]
                  : entry.content;
                const guid = Array.isArray(entry.id) ? entry.id[0] : entry.id;

                return {
                  title: typeof title === "string" ? title : "",
                  link: typeof link === "string" ? link : undefined,
                  pubDate: typeof pubDate === "string" ? pubDate : undefined,
                  description:
                    typeof description === "string" ? description : undefined,
                  content: typeof content === "string" ? content : undefined,
                  guid:
                    typeof guid === "string"
                      ? guid
                      : typeof guid === "number"
                        ? String(guid)
                        : undefined,
                };
              },
            ),
          };
        }

        throw new Error("Unknown feed format");
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxRetries - 1) {
          // Final retry attempt failed
          logger.error(
            `Failed to fetch RSS feed after ${maxRetries} attempts`,
            { url, error },
            "RSSFeedService",
          );
          throw lastError;
        }

        // Log retry
        logger.warn(
          "RSS feed fetch failed, will retry",
          { url, attempt: attempt + 1, error: (error as Error).message },
          "RSSFeedService",
        );
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError || new Error("Failed to fetch RSS feed");
  }

  /**
   * Fetch all active RSS feeds and store new headlines
   */
  async fetchAllFeeds(): Promise<{
    fetched: number;
    stored: number;
    errors: number;
  }> {
    const sources = await db
      .select()
      .from(rssFeedSources)
      .where(eq(rssFeedSources.isActive, true));

    logger.info(
      `Fetching ${sources.length} RSS feeds`,
      undefined,
      "RSSFeedService",
    );

    let fetched = 0;
    let stored = 0;
    const errors = 0;

    for (const source of sources) {
      const feed = await this.fetchFeed(source.feedUrl);
      fetched++;

      // Store new headlines (check by link to avoid duplicates)
      for (const item of feed.items) {
        if (!item.title) continue;

        // Pre-filter: skip non-news garbage before any DB work
        const trimmedTitle = item.title.trim();
        if (trimmedTitle.length < 15) continue; // too short for news
        if (trimmedTitle.length > 500) continue; // paragraph, not headline
        if (/^https?:\/\//i.test(trimmedTitle)) continue; // just a URL
        if (
          /\b(subscribe|newsletter|click here|unsubscribe)\b/i.test(
            trimmedTitle,
          )
        )
          continue;

        // Check if we already have this headline
        const existingResult = item.link
          ? await db
              .select({ id: rssHeadlines.id })
              .from(rssHeadlines)
              .where(eq(rssHeadlines.link, item.link))
              .limit(1)
          : [];

        const existing = existingResult[0];

        if (existing) continue;

        const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date();

        await db.insert(rssHeadlines).values({
          id: await generateSnowflakeId(),
          sourceId: source.id,
          title: item.title,
          link: item.link || null,
          publishedAt,
          summary: item.description || null,
          content: item.content || null,
          // RSSFeedItem is a plain object with JsonValue-compatible fields (all string/undefined)
          // Convert through unknown first for type safety
          rawData: JSON.parse(JSON.stringify(item)) as JsonValue,
          fetchedAt: new Date(),
        });

        stored++;
      }

      // Update last fetched timestamp
      await db
        .update(rssFeedSources)
        .set({
          lastFetched: new Date(),
          fetchErrors: 0,
        })
        .where(eq(rssFeedSources.id, source.id));
    }

    logger.info(
      `RSS fetch complete: ${fetched} feeds fetched, ${stored} headlines stored, ${errors} errors`,
      { fetched, stored, errors },
      "RSSFeedService",
    );

    return { fetched, stored, errors };
  }

  /**
   * Get recent headlines that haven't been transformed into parodies yet
   * Only returns headlines from the last 7 days
   */
  async getUntransformedHeadlines(limit = 50): Promise<RSSHeadline[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get headlines without parody by checking if no parodyHeadline exists with matching originalHeadlineId
    const results = await db
      .select()
      .from(rssHeadlines)
      .where(
        and(
          gte(rssHeadlines.publishedAt, sevenDaysAgo),
          sql`NOT EXISTS (
            SELECT 1 FROM ${parodyHeadlines} 
            WHERE ${parodyHeadlines.originalHeadlineId} = ${rssHeadlines.id}
          )`,
        ),
      )
      .orderBy(desc(rssHeadlines.publishedAt))
      .limit(limit);

    return results;
  }

  /**
   * Clean up old headlines (older than 7 days)
   */
  async cleanupOldHeadlines(): Promise<number> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const result = await db
      .delete(rssHeadlines)
      .where(lt(rssHeadlines.publishedAt, sevenDaysAgo))
      .returning({ id: rssHeadlines.id });

    const count = result.length;

    logger.info(
      `Cleaned up ${count} old RSS headlines`,
      { count },
      "RSSFeedService",
    );

    return count;
  }
}

// Singleton instance
export const rssFeedService = new RSSFeedService();
