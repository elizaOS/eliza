/**
 * `NEWS_DATA_SERVICE`: fetches and hand-parses the Brave New Coin RSS feed
 * (`bravenewcoin.com/rss/insights`) with a small regex-based XML reader
 * (`parseRSS`/`extractTag`) rather than a full XML parser, into
 * `RealWorldNewsArticle` records. `getTokenNews`/`getDefiNews` are thin
 * query-filter wrappers over `getLatestNews`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import { decodeBasicHtmlEntities } from "@elizaos/plugin-assistant/html-entities";
import type { RealWorldNewsArticle } from "../interfaces/types";

interface RSSItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  category?: string[];
  guid?: string;
  content?: string;
  creator?: string;
}

export const DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS = 10_000;

export class NewsDataService extends Service {
  static serviceType = "NEWS_DATA_SERVICE";
  private rssUrl: string = "https://bravenewcoin.com/rss/insights";

  get capabilityDescription(): string {
    return "Provides real-world cryptocurrency news and events from Brave New Coin RSS feed";
  }

  static async start(runtime: IAgentRuntime) {
    const service = new NewsDataService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(NewsDataService.serviceType);
    if (!service) {
      throw new Error(`${NewsDataService.serviceType} service not found`);
    }
  }

  async stop(): Promise<void> {}

  private parseRSS(xmlText: string): RSSItem[] {
    const items: RSSItem[] = [];

    try {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      const itemMatches = xmlText.matchAll(itemRegex);

      for (const match of itemMatches) {
        const itemXml = match[1];

        const title = this.decodeHtmlEntities(
          this.extractTag(itemXml, "title") || "",
        );
        const link = this.extractTag(itemXml, "link");
        const description = this.extractTag(itemXml, "description");
        const pubDate = this.extractTag(itemXml, "pubDate");
        const guid = this.extractTag(itemXml, "guid");
        const creator =
          this.extractTag(itemXml, "dc:creator") ||
          this.extractTag(itemXml, "author");
        const content = this.extractTag(itemXml, "content:encoded");

        // Extract categories (handle CDATA)
        const categoryRegex =
          /<category>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/category>/gs;
        const categories: string[] = [];
        for (;;) {
          const categoryMatch = categoryRegex.exec(itemXml);
          if (categoryMatch === null) break;
          const cat = categoryMatch[1].trim();
          if (cat) {
            categories.push(cat);
          }
        }

        items.push({
          title,
          link,
          description,
          pubDate,
          category: categories.length > 0 ? categories : undefined,
          guid,
          creator,
          content,
        });
      }
    } catch (error) {
      console.error("❌ [NewsDataService] Error parsing RSS:", error);
    }

    return items;
  }

  private extractTag(xml: string, tagName: string): string | undefined {
    const regex = new RegExp(
      `<${tagName}[^>]*><!\\[CDATA\\[(.*?)\\]\\]><\\/${tagName}>`,
      "s",
    );
    const cdataMatch = xml.match(regex);
    if (cdataMatch) {
      return cdataMatch[1].trim();
    }

    const simpleRegex = new RegExp(
      `<${tagName}[^>]*>(.*?)<\\/${tagName}>`,
      "s",
    );
    const simpleMatch = xml.match(simpleRegex);
    if (simpleMatch) {
      return simpleMatch[1].trim();
    }

    return undefined;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, "").trim();
  }

  private decodeHtmlEntities(text: string): string {
    // The wallet renders the quote code points U+2018/U+2019/U+201C/U+201D
    // as straight quotes, where the shared decoder returns the curly
    // characters. The choice depends on the code point, not the spelling:
    // decimal (`&#8217;`), hex (`&#x2019;`), and uppercase-X hex
    // (`&#X2019;`, the spelling merged #35829 added to the decoder family)
    // render the same. Every other entity defers to the shared decoder.
    // Decode in one pass over the source text: replacement output is never
    // rescanned, so an escaped entity such as `&amp;amp;` decodes one
    // layer to the literal text `&amp;` instead of collapsing both layers
    // to `&`.
    return text.replace(
      /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
      (entity) => {
        const numeric = /^&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));$/.exec(entity);
        if (numeric) {
          const hexDigits = numeric[1];
          const code = hexDigits
            ? Number.parseInt(hexDigits, 16)
            : Number.parseInt(numeric[2] ?? "", 10);
          if (code === 0x2018 || code === 0x2019) return "'";
          if (code === 0x201c || code === 0x201d) return '"';
        }
        return decodeBasicHtmlEntities(entity);
      },
    );
  }

  async getLatestNews(options?: {
    query?: string;
    language?: string;
    category?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<RealWorldNewsArticle[]> {
    try {
      const limit = options?.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new RangeError("limit must be a non-negative safe integer");
      }
      const query = options?.query?.toLowerCase();
      const timeoutSignal = AbortSignal.timeout(
        DEFAULT_NEWS_RSS_FETCH_TIMEOUT_MS,
      );
      const signal = options?.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      const response = await fetch(this.rssUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SpartanBot/1.0)",
        },
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `❌ [NewsDataService] RSS fetch error (${response.status}): ${errorText}`,
        );
        throw new Error(
          `RSS fetch error: ${response.status} ${response.statusText}`,
        );
      }

      const xmlText = await response.text();
      const rssItems = this.parseRSS(xmlText);

      // Convert RSS items to RealWorldNewsArticle format
      let articles: RealWorldNewsArticle[] = rssItems.map((item, index) => ({
        article_id: item.guid || `bnc-${Date.now()}-${index}`,
        title: item.title || "Untitled",
        link: item.link || "",
        description: item.description
          ? this.decodeHtmlEntities(this.stripHtml(item.description))
          : undefined,
        pubDate: item.pubDate || new Date().toISOString(),
        source_id: "bravenewcoin",
        source_priority: 1,
        source_url: "https://bravenewcoin.com",
        language: "en",
        category: item.category,
        creator: item.creator ? [item.creator] : undefined,
        keywords: undefined,
        video_url: null,
        content: item.content ? this.stripHtml(item.content) : undefined,
        image_url: undefined,
        source_icon: undefined,
        country: undefined,
        ai_tag: undefined,
        sentiment: undefined,
        sentiment_stats: undefined,
        ai_region: undefined,
      }));

      // Filter by query if provided
      if (query) {
        articles = articles.filter((article) => {
          const searchText =
            `${article.title} ${article.description || ""} ${article.content || ""} ${article.category?.join(" ") || ""}`.toLowerCase();
          return searchText.includes(query);
        });
      }

      if (limit !== undefined) {
        articles = articles.slice(0, limit);
      }

      return articles;
    } catch (error) {
      if (error instanceof Error) {
        console.error(
          "❌ [NewsDataService] Error fetching news:",
          error.message,
        );
        throw error;
      } else {
        console.error("❌ [NewsDataService] Unknown error:", error);
        throw new Error("Failed to fetch news from Brave New Coin RSS");
      }
    }
  }

  async getTokenNews(
    tokenSymbol: string,
    options?: {
      language?: string;
      limit?: number;
      signal?: AbortSignal;
    },
  ): Promise<RealWorldNewsArticle[]> {
    const query = tokenSymbol.toLowerCase();
    return this.getLatestNews({
      query,
      language: options?.language,
      limit: options?.limit,
      signal: options?.signal,
    });
  }

  async getDefiNews(options?: {
    language?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<RealWorldNewsArticle[]> {
    const query = "defi";
    return this.getLatestNews({
      query,
      language: options?.language,
      limit: options?.limit,
      signal: options?.signal,
    });
  }

  async getCryptoMarketNews(options?: {
    language?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<RealWorldNewsArticle[]> {
    // Return all crypto news from the feed
    return this.getLatestNews({
      language: options?.language,
      limit: options?.limit,
      signal: options?.signal,
    });
  }
}
