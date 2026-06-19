import { logger } from "@elizaos/core";
import type { AlbumInfo, ArtistInfo, TrackInfo } from "../types";

const WIKIPEDIA_SERVICE_NAME = "wikipedia";

interface WikipediaSummaryPage {
  extract?: string;
  thumbnail?: {
    source?: string;
  };
  content_urls?: {
    desktop?: {
      page?: string;
    };
  };
}

interface WikipediaSearchEntry {
  title: string;
  snippet: string;
}

interface WikipediaSearchResponse {
  query?: {
    search?: WikipediaSearchEntry[];
  };
}

/**
 * Shared rate limiter for Wikipedia API across all agents per instance
 * Wikipedia recommends: max 200 requests per second per IP
 * We'll be more conservative: 2 requests per second (120 per minute)
 */
class WikipediaRateLimiter {
  private static instance: WikipediaRateLimiter | null = null;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 500; // 500ms = 2 requests per second
  private requestQueue: Array<() => void> = [];
  private processing = false;

  static getInstance(): WikipediaRateLimiter {
    if (!WikipediaRateLimiter.instance) {
      WikipediaRateLimiter.instance = new WikipediaRateLimiter();
    }
    return WikipediaRateLimiter.instance;
  }

  /**
   * Wait for rate limit before making a request
   */
  async waitForRateLimit(): Promise<void> {
    return new Promise((resolve) => {
      this.requestQueue.push(resolve);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.requestQueue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;

      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest),
        );
      }

      this.lastRequestTime = Date.now();
      const resolve = this.requestQueue.shift();
      if (resolve) {
        resolve();
      }
    }

    this.processing = false;
  }
}

/**
 * Service for Wikipedia API access
 * Free, no authentication required
 * Rate limit: 2 requests per second (shared across all agents per instance)
 */
export class WikipediaClient {
  capabilityDescription = "Provides access to Wikipedia API with rate limiting";

  private readonly baseUrl = "https://en.wikipedia.org/api/rest_v1";
  private readonly searchUrl = "https://en.wikipedia.org/w/api.php";
  private readonly rateLimiter = WikipediaRateLimiter.getInstance();

  async stop(): Promise<void> {
    // No cleanup needed - rate limiter is a singleton
  }

  /**
   * Search for a Wikipedia page and get summary
   */
  private async getPageSummary(
    title: string,
  ): Promise<WikipediaSummaryPage | null> {
    await this.rateLimiter.waitForRateLimit();

    try {
      const encodedTitle = encodeURIComponent(title);
      const url = `${this.baseUrl}/page/summary/${encodedTitle}`;

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "ElizaOS-MusicInfo/1.0.0 (https://github.com/elizaos/eliza)",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null; // Page not found
        }
        logger.warn(
          `Wikipedia API error: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      return (await response.json()) as WikipediaSummaryPage;
    } catch (error) {
      logger.error(`Error fetching Wikipedia page: ${error}`);
      return null;
    }
  }

  /**
   * Search Wikipedia for pages matching a query
   */
  private async searchPages(
    query: string,
    limit: number = 3,
  ): Promise<Array<{ title: string; snippet: string }>> {
    await this.rateLimiter.waitForRateLimit();

    try {
      const params = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: limit.toString(),
        format: "json",
        origin: "*",
      });

      const url = `${this.searchUrl}?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "ElizaOS-MusicInfo/1.0.0 (https://github.com/elizaos/eliza)",
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as WikipediaSearchResponse;
      const searchResults = data.query?.search;
      if (!searchResults) {
        return [];
      }

      return searchResults.map((result) => ({
        title: result.title,
        snippet: result.snippet,
      }));
    } catch (error) {
      logger.error(`Error searching Wikipedia: ${error}`);
      return [];
    }
  }

  /**
   * Get track information from Wikipedia
   */
  async getTrackInfo(
    trackName: string,
    artistName?: string,
  ): Promise<TrackInfo | null> {
    try {
      // Try searching for the song
      let searchQuery = trackName;
      if (artistName) {
        searchQuery = `${trackName} ${artistName}`;
      }

      const searchResults = await this.searchPages(searchQuery, 5);

      // Look for a result that seems to be about the song
      for (const result of searchResults) {
        const title = result.title.toLowerCase();
        const snippet = result.snippet.toLowerCase();
        const trackLower = trackName.toLowerCase();

        // Check if this looks like a song page
        if (title.includes(trackLower) || snippet.includes(trackLower)) {
          const page = await this.getPageSummary(result.title);
          if (page?.extract) {
            const trackInfo: TrackInfo = {
              title: trackName,
              artist:
                artistName ||
                this.extractArtistFromExtract(page.extract) ||
                "Unknown Artist",
              description: this.cleanExtract(page.extract),
              url: page.content_urls?.desktop?.page,
            };

            // Try to extract additional info from extract
            const yearMatch = page.extract.match(/\b(19|20)\d{2}\b/);
            if (yearMatch) {
              trackInfo.year = parseInt(yearMatch[0], 10);
            }

            return trackInfo;
          }
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error getting Wikipedia track info: ${error}`);
      return null;
    }
  }

  /**
   * Get artist information from Wikipedia
   */
  async getArtistInfo(artistName: string): Promise<ArtistInfo | null> {
    try {
      // Try direct page lookup first
      let page = await this.getPageSummary(artistName);

      // If not found, try searching
      if (!page) {
        const searchResults = await this.searchPages(artistName, 3);
        if (searchResults.length > 0) {
          // Try the first result
          page = await this.getPageSummary(searchResults[0].title);
        }
      }

      if (!page?.extract) {
        return null;
      }

      const extract = page.extract;
      const artistInfo: ArtistInfo = {
        name: artistName,
        bio: this.cleanExtract(extract),
        image: page.thumbnail?.source,
      };

      // Try to extract genres from the extract
      const genreKeywords = [
        "rock",
        "pop",
        "jazz",
        "hip hop",
        "rap",
        "country",
        "electronic",
        "classical",
        "blues",
        "folk",
        "metal",
        "punk",
        "reggae",
        "r&b",
        "soul",
        "funk",
        "disco",
        "indie",
        "alternative",
      ];
      const foundGenres: string[] = [];
      const extractLower = extract.toLowerCase();

      for (const genre of genreKeywords) {
        if (extractLower.includes(genre)) {
          foundGenres.push(genre);
        }
      }

      if (foundGenres.length > 0) {
        artistInfo.genres = foundGenres.slice(0, 5); // Limit to 5 genres
      }

      // Extract related artists and influences from Wikipedia extract
      // This helps with music discovery and selection
      const relatedArtists = this.extractRelatedArtists(extract);
      if (relatedArtists.length > 0) {
        artistInfo.similarArtists = relatedArtists;
      }

      return artistInfo;
    } catch (error) {
      logger.error(`Error getting Wikipedia artist info: ${error}`);
      return null;
    }
  }

  /**
   * Get album information from Wikipedia
   */
  async getAlbumInfo(
    albumTitle: string,
    artistName?: string,
  ): Promise<AlbumInfo | null> {
    try {
      // Try searching for the album
      let searchQuery = albumTitle;
      if (artistName) {
        searchQuery = `${albumTitle} ${artistName}`;
      }

      const searchResults = await this.searchPages(searchQuery, 5);

      // Look for a result that seems to be about the album
      for (const result of searchResults) {
        const title = result.title.toLowerCase();
        const snippet = result.snippet.toLowerCase();
        const albumLower = albumTitle.toLowerCase();

        // Check if this looks like an album page
        if (title.includes(albumLower) || snippet.includes(albumLower)) {
          const page = await this.getPageSummary(result.title);
          if (page?.extract) {
            const albumInfo: AlbumInfo = {
              title: albumTitle,
              artist:
                artistName ||
                this.extractArtistFromExtract(page.extract) ||
                "Unknown Artist",
              description: this.cleanExtract(page.extract),
              coverArt: page.thumbnail?.source,
            };

            // Try to extract year from extract
            const yearMatch = page.extract.match(/\b(19|20)\d{2}\b/);
            if (yearMatch) {
              albumInfo.year = parseInt(yearMatch[0], 10);
            }

            return albumInfo;
          }
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error getting Wikipedia album info: ${error}`);
      return null;
    }
  }

  /**
   * Clean Wikipedia extract text (remove HTML, truncate)
   */
  private cleanExtract(extract: string, maxLength: number = 1000): string {
    // Remove HTML tags
    let cleaned = extract.replace(/<[^>]*>/g, "");
    // Remove reference markers like [1], [2], etc.
    cleaned = cleaned.replace(/\[\d+\]/g, "");
    // Truncate if too long
    if (cleaned.length > maxLength) {
      cleaned = `${cleaned.substring(0, maxLength).trim()}...`;
    }
    return cleaned;
  }

  /**
   * Try to extract artist name from Wikipedia extract
   */
  private extractArtistFromExtract(extract: string): string | null {
    // Look for common patterns like "by Artist" or "Artist's song"
    const patterns = [
      /\bby\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/,
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)'s\s+(?:song|album|track)/i,
    ];

    for (const pattern of patterns) {
      const match = extract.match(pattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Extract related artists, influences, and similar acts from Wikipedia extract
   * Looks for patterns like "influenced by", "similar to", "associated acts", etc.
   * This data helps drive intelligent music selection and discovery
   */
  private extractRelatedArtists(extract: string): string[] {
    const relatedArtists: Set<string> = new Set();

    // Patterns to find related artists
    const patterns = [
      // Influences
      /(?:influenced by|inspired by|drew inspiration from)[:\s]+([^.]+)/i,
      // Similar artists
      /(?:similar to|comparable to|like)[:\s]+([^.]+)/i,
      // Associated acts
      /(?:associated acts|associated with|collaborated with)[:\s]+([^.]+)/i,
      // Musical influences
      /(?:musical influences|influences include)[:\s]+([^.]+)/i,
      // Genre peers
      /(?:alongside|along with|together with)[:\s]+([^.]+)/i,
    ];

    for (const pattern of patterns) {
      const matches = extract.matchAll(new RegExp(pattern.source, "gi"));
      for (const match of matches) {
        if (match[1]) {
          // Extract artist names from the matched text
          const artistsText = match[1];
          // Split by common separators
          const artists = artistsText
            .split(/[,;]| and | & /)
            .map((a) => a.trim())
            .filter((a) => a.length > 0 && a.length < 100); // Reasonable length

          for (const artist of artists) {
            // Clean up the artist name
            const cleanArtist = artist
              .replace(/\[.*?\]/g, "") // Remove Wikipedia references
              .replace(/\(.*?\)/g, "") // Remove parenthetical info
              .trim();

            // Only add if it looks like an artist name (starts with capital, reasonable length)
            if (
              cleanArtist.length > 2 &&
              cleanArtist.length < 80 &&
              /^[A-Z]/.test(cleanArtist)
            ) {
              relatedArtists.add(cleanArtist);
            }
          }
        }
      }
    }

    // Limit to top 10 related artists
    return Array.from(relatedArtists).slice(0, 10);
  }
}

export const WIKIPEDIA_HELPER_NAME = WIKIPEDIA_SERVICE_NAME;

export { WikipediaClient as WikipediaService };
