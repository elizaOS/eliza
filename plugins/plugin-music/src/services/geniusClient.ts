import { logger } from "@elizaos/core";
import { type RetryableError, retryWithBackoff } from "../utils/retry";

type GeniusHttpError = Error &
  RetryableError & {
    response?: {
      status?: number;
      statusText?: string;
      headers?: Headers;
    };
  };

interface GeniusSearchHit {
  result: {
    id: number;
    title: string;
    primary_artist: {
      name: string;
    };
    url: string;
  };
}

interface GeniusSearchResponse {
  response?: {
    hits?: GeniusSearchHit[];
  };
}

interface GeniusSongResponse {
  response?: {
    song?: {
      title: string;
      primary_artist: {
        name: string;
      };
      url: string;
    };
  };
}

function buildGeniusHttpError(response: Response): GeniusHttpError {
  const error = new Error(
    `Genius API error: ${response.status} ${response.statusText}`,
  ) as GeniusHttpError;
  error.response = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  return error;
}

/**
 * Client for Genius API
 * Free tier with API key
 * Rate limit: Reasonable for free tier
 * Documentation: https://docs.genius.com/
 */
export class GeniusClient {
  private readonly baseUrl = "https://api.genius.com";
  private readonly apiKey: string;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 200; // 200ms = 5 requests per second (conservative)

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Genius API key is required");
    }
    this.apiKey = apiKey;
  }

  /**
   * Rate limit: ensure we don't exceed rate limits
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest),
      );
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Search for a song
   */
  async searchSong(query: string): Promise<Array<{
    id: number;
    title: string;
    artist: string;
    url: string;
  }> | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "ElizaOS-MusicInfo/1.0.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Don't retry on authentication errors
          logger.warn("Genius API: Invalid API key");
          return null;
        }
        throw buildGeniusHttpError(response);
      }

      const data = (await response.json()) as GeniusSearchResponse;
      if (!data.response?.hits) {
        return null;
      }

      return data.response.hits
        .map((hit) => ({
          id: hit.result.id,
          title: hit.result.title,
          artist: hit.result.primary_artist.name,
          url: hit.result.url,
        }))
        .slice(0, 5); // Limit to top 5 results
    }).catch((error) => {
      logger.error(`Error searching Genius after retries: ${error}`);
      return null;
    });
  }

  /**
   * Get lyrics for a song by ID
   * Note: Genius API doesn't directly provide lyrics, but we can get the URL
   * For actual lyrics, we'd need to scrape the page (which requires separate implementation)
   */
  async getSongInfo(songId: number): Promise<{
    title: string;
    artist: string;
    url: string;
    lyricsUrl: string;
  } | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/songs/${songId}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "ElizaOS-MusicInfo/1.0.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw buildGeniusHttpError(response);
      }

      const data = (await response.json()) as GeniusSongResponse;
      if (!data.response?.song) {
        return null;
      }

      const song = data.response.song;
      return {
        title: song.title,
        artist: song.primary_artist.name,
        url: song.url,
        lyricsUrl: song.url, // Genius URLs point to lyrics pages
      };
    }).catch((error) => {
      logger.error(`Error getting Genius song info after retries: ${error}`);
      return null;
    });
  }

  /**
   * Get lyrics for a track (searches first, then gets song info)
   */
  async getLyrics(
    trackName: string,
    artistName?: string,
  ): Promise<string | null> {
    try {
      const query = artistName ? `${trackName} ${artistName}` : trackName;
      const searchResults = await this.searchSong(query);

      if (!searchResults || searchResults.length === 0) {
        return null;
      }

      // Try to find exact match
      let songId: number | null = null;
      const trackLower = trackName.toLowerCase();
      const artistLower = artistName?.toLowerCase();

      for (const result of searchResults) {
        if (result.title.toLowerCase().includes(trackLower)) {
          if (
            !artistLower ||
            result.artist.toLowerCase().includes(artistLower)
          ) {
            songId = result.id;
            break;
          }
        }
      }

      // If no exact match, use first result
      if (!songId && searchResults.length > 0) {
        songId = searchResults[0].id;
      }

      if (!songId) {
        return null;
      }

      const songInfo = await this.getSongInfo(songId);
      if (!songInfo) {
        return null;
      }

      // Note: Genius API doesn't provide lyrics directly via API
      // The lyricsUrl can be used to scrape lyrics if needed
      // For now, we return the URL as a reference
      // A lyrics scraping service would need to be implemented separately
      return songInfo.lyricsUrl;
    } catch (error) {
      logger.error(`Error getting lyrics from Genius: ${error}`);
      return null;
    }
  }

  /**
   * Validate API key by making a test request
   */
  async validateApiKey(): Promise<boolean> {
    return retryWithBackoff(
      async () => {
        await this.rateLimit();
        const url = `${this.baseUrl}/account`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": "ElizaOS-MusicInfo/1.0.0",
            Accept: "application/json",
          },
        });
        return response.ok;
      },
      {
        maxRetries: 2, // Fewer retries for validation
        retryableErrors: (error: RetryableError) => {
          const status = error.response?.status;

          // Only retry on network errors, not auth errors
          return (
            error?.code === "ECONNRESET" ||
            error?.code === "ETIMEDOUT" ||
            error?.code === "ENOTFOUND" ||
            (typeof status === "number" && status >= 500 && status < 600)
          );
        },
      },
    ).catch(() => false);
  }
}
