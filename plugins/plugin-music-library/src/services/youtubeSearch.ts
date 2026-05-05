import { logger } from "@elizaos/core";

const YOUTUBE_SEARCH_SERVICE_NAME = "youtubeSearch";

interface PlayDlSearchResult {
  url?: string;
  title?: string;
  durationInSec?: number;
  channel?: {
    name?: string;
  };
  views?: number;
}

export interface YouTubeSearchResult {
  url: string;
  title: string;
  duration?: number;
  channel?: string;
  views?: number;
}

/**
 * Service for searching YouTube videos
 * Centralizes YouTube search logic for reuse across multiple actions
 */
export class YouTubeSearchHelper {
  capabilityDescription = "Searches YouTube for videos and returns metadata";

  private cache: Map<
    string,
    { results: YouTubeSearchResult[]; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour

  async stop(): Promise<void> {
    this.clearCache();
  }

  /**
   * Clear all cached searches
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Search YouTube for videos
   * @param query - Search query string
   * @param options - Search options
   * @returns Array of search results
   */
  async search(
    query: string,
    options: {
      limit?: number;
      includeShorts?: boolean;
    } = {},
  ): Promise<YouTubeSearchResult[]> {
    const { limit = 5, includeShorts = false } = options;

    // Check cache
    const cacheKey = `${query}:${limit}:${includeShorts}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      logger.debug(`YouTube search cache hit for: ${query}`);
      return cached.results;
    }

    try {
      // Lazy-load play-dl to avoid initialization issues during plugin load
      const play = await import("@vookav2/play-dl").then((m) => m.default || m);

      logger.debug(`Searching YouTube for: ${query} (limit: ${limit})`);

      let searchResults: PlayDlSearchResult[];
      try {
        searchResults = await play.search(query, {
          limit: limit * 2, // Get extra results for filtering
          source: { youtube: "video" },
        });
      } catch (error) {
        logger.error(
          "Error in YouTube search API:",
          error instanceof Error ? error.message : String(error),
        );
        throw new Error(
          `YouTube search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }

      if (!searchResults || searchResults.length === 0) {
        logger.warn(`No YouTube results found for: ${query}`);
        return [];
      }

      // Filter and format results
      const results: YouTubeSearchResult[] = [];
      for (const result of searchResults) {
        // Skip if not a valid video URL
        if (!result.url?.includes("youtube.com/watch")) {
          continue;
        }

        // Skip shorts if not included
        if (!includeShorts && result.url.includes("/shorts/")) {
          continue;
        }

        // Add to results
        const channelName = result.channel?.name;
        const views =
          typeof result.views === "number" ? result.views : undefined;
        results.push({
          url: result.url,
          title: result.title || "Unknown Title",
          duration:
            typeof result.durationInSec === "number"
              ? result.durationInSec
              : undefined,
          channel: typeof channelName === "string" ? channelName : undefined,
          views,
        });

        // Stop when we have enough results
        if (results.length >= limit) {
          break;
        }
      }

      // Cache results
      this.cache.set(cacheKey, {
        results,
        timestamp: Date.now(),
      });

      logger.info(`Found ${results.length} YouTube results for: ${query}`);
      return results;
    } catch (error) {
      logger.error(
        "Error in YouTubeSearchService:",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Search and return the top result
   * @param query - Search query
   * @returns Top search result or null
   */
  async searchOne(query: string): Promise<YouTubeSearchResult | null> {
    const results = await this.search(query, { limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Validate if a URL is a valid YouTube video
   */
  async validateUrl(url: string): Promise<boolean> {
    try {
      const play = await import("@vookav2/play-dl").then((m) => m.default || m);
      return play.yt_validate(url) === "video";
    } catch (error) {
      logger.error(
        "Error validating YouTube URL:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Get video info from URL
   */
  async getVideoInfo(url: string): Promise<YouTubeSearchResult | null> {
    try {
      const play = await import("@vookav2/play-dl").then((m) => m.default || m);

      if (!play.yt_validate(url)) {
        return null;
      }

      const videoInfo = await play.video_info(url);
      if (!videoInfo) {
        return null;
      }

      const details = videoInfo.video_details;
      const channelName = details.channel?.name;
      return {
        url: details.url,
        title: details.title || "Unknown Title",
        duration: details.durationInSec,
        channel: typeof channelName === "string" ? channelName : undefined,
        views: details.views,
      };
    } catch (error) {
      logger.error(
        "Error getting video info:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
}

export const YOUTUBE_SEARCH_HELPER_NAME = YOUTUBE_SEARCH_SERVICE_NAME;

export { YouTubeSearchHelper as YouTubeSearchService };

export default YouTubeSearchHelper;
