import { logger } from "@elizaos/core";
import { type RetryableError, retryWithBackoff } from "../utils/retry";

type TheAudioDbHttpError = Error & RetryableError;

interface AudioDbArtistSummary {
  idArtist: string;
  strArtist: string;
  strArtistThumb: string;
  strArtistLogo: string;
  strArtistFanart: string;
  strArtistBanner: string;
}

interface AudioDbArtistDetail extends AudioDbArtistSummary {
  strBiographyEN?: string;
  intFormedYear?: string;
  strGenre?: string;
  strCountry?: string;
}

interface AudioDbAlbumSummary {
  idAlbum: string;
  strAlbum: string;
  strArtist: string;
  strAlbumThumb: string;
  strAlbumCDart: string;
}

interface AudioDbAlbumDetail extends AudioDbAlbumSummary {
  intYearReleased?: string;
  strGenre?: string;
  strDescriptionEN?: string;
}

interface AudioDbArtistSearchResponse {
  artists?: AudioDbArtistSummary[];
}

interface AudioDbArtistDetailResponse {
  artists?: AudioDbArtistDetail[];
}

interface AudioDbAlbumSearchResponse {
  album?: AudioDbAlbumSummary[];
}

interface AudioDbAlbumDetailResponse {
  album?: AudioDbAlbumDetail[];
}

function buildTheAudioDbHttpError(response: Response): TheAudioDbHttpError {
  const error = new Error(
    `TheAudioDB API error: ${response.status} ${response.statusText}`,
  ) as TheAudioDbHttpError;
  error.response = {
    status: response.status,
    headers: response.headers,
  };
  return error;
}

/**
 * Client for TheAudioDB API
 * Free tier with API key
 * Rate limit: Generous for free tier
 * Documentation: https://www.theaudiodb.com/api_guide.php
 */
export class TheAudioDbClient {
  private readonly baseUrl = "https://theaudiodb.com/api/v1/json";
  private readonly apiKey: string;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 100; // 100ms = 10 requests per second (conservative)

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("TheAudioDB API key is required");
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
   * Search for an artist
   */
  async searchArtist(artistName: string): Promise<Array<{
    idArtist: string;
    strArtist: string;
    strArtistThumb: string;
    strArtistLogo: string;
    strArtistFanart: string;
    strArtistBanner: string;
  }> | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/${this.apiKey}/search.php?s=${encodeURIComponent(artistName)}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw buildTheAudioDbHttpError(response);
      }

      const data = (await response.json()) as AudioDbArtistSearchResponse;
      const artists = data.artists ?? [];
      if (artists.length === 0) {
        return null;
      }

      return artists;
    }).catch((error) => {
      logger.error(`Error searching TheAudioDB artist after retries: ${error}`);
      return null;
    });
  }

  /**
   * Get artist information including high-quality images
   */
  async getArtistInfo(artistName: string): Promise<{
    strArtist: string;
    strArtistThumb: string;
    strArtistLogo: string;
    strArtistFanart: string;
    strArtistBanner: string;
    strBiographyEN?: string;
    intFormedYear?: string;
    strGenre?: string;
    strCountry?: string;
  } | null> {
    try {
      const artists = await this.searchArtist(artistName);
      if (!artists || artists.length === 0) {
        return null;
      }

      // Use the first result (most likely match)
      const artist = artists[0];

      // Get detailed artist info
      await this.rateLimit();
      const detailUrl = `${this.baseUrl}/${this.apiKey}/artist.php?i=${artist.idArtist}`;

      const detailData = await retryWithBackoff(async () => {
        const detailResponse = await fetch(detailUrl, {
          headers: {
            Accept: "application/json",
          },
        });

        if (!detailResponse.ok) {
          throw buildTheAudioDbHttpError(detailResponse);
        }

        return (await detailResponse.json()) as AudioDbArtistDetailResponse;
      });

      const detailArtists = detailData.artists ?? [];
      if (detailArtists.length === 0) {
        return null;
      }

      const detailArtist = detailArtists[0];
      return {
        strArtist: detailArtist.strArtist || artist.strArtist,
        strArtistThumb: detailArtist.strArtistThumb || artist.strArtistThumb,
        strArtistLogo: detailArtist.strArtistLogo || artist.strArtistLogo,
        strArtistFanart: detailArtist.strArtistFanart || artist.strArtistFanart,
        strArtistBanner: detailArtist.strArtistBanner || artist.strArtistBanner,
        strBiographyEN: detailArtist.strBiographyEN,
        intFormedYear: detailArtist.intFormedYear,
        strGenre: detailArtist.strGenre,
        strCountry: detailArtist.strCountry,
      };
    } catch (error) {
      logger.error(`Error getting TheAudioDB artist info: ${error}`);
      return null;
    }
  }

  /**
   * Search for an album
   */
  async searchAlbum(
    albumName: string,
    artistName?: string,
  ): Promise<Array<{
    idAlbum: string;
    strAlbum: string;
    strArtist: string;
    strAlbumThumb: string;
    strAlbumCDart: string;
  }> | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      let url: string;
      if (artistName) {
        url = `${this.baseUrl}/${this.apiKey}/searchalbum.php?s=${encodeURIComponent(artistName)}&a=${encodeURIComponent(albumName)}`;
      } else {
        url = `${this.baseUrl}/${this.apiKey}/searchalbum.php?a=${encodeURIComponent(albumName)}`;
      }

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw buildTheAudioDbHttpError(response);
      }

      const data = (await response.json()) as AudioDbAlbumSearchResponse;
      const albums = data.album ?? [];
      if (albums.length === 0) {
        return null;
      }

      return albums;
    }).catch((error) => {
      logger.error(`Error searching TheAudioDB album after retries: ${error}`);
      return null;
    });
  }

  /**
   * Get album information including high-quality artwork
   */
  async getAlbumInfo(
    albumName: string,
    artistName?: string,
  ): Promise<{
    strAlbum: string;
    strArtist: string;
    strAlbumThumb: string;
    strAlbumCDart: string;
    intYearReleased?: string;
    strGenre?: string;
    strDescriptionEN?: string;
  } | null> {
    try {
      const albums = await this.searchAlbum(albumName, artistName);
      if (!albums || albums.length === 0) {
        return null;
      }

      // Use the first result (most likely match)
      const album = albums[0];

      // Get detailed album info
      await this.rateLimit();
      const detailUrl = `${this.baseUrl}/${this.apiKey}/album.php?m=${album.idAlbum}`;

      const detailData = await retryWithBackoff(async () => {
        const detailResponse = await fetch(detailUrl, {
          headers: {
            Accept: "application/json",
          },
        });

        if (!detailResponse.ok) {
          throw buildTheAudioDbHttpError(detailResponse);
        }

        return (await detailResponse.json()) as AudioDbAlbumDetailResponse;
      });

      const detailAlbums = detailData.album ?? [];
      if (detailAlbums.length === 0) {
        return null;
      }

      const detailAlbum = detailAlbums[0];
      return {
        strAlbum: detailAlbum.strAlbum || album.strAlbum,
        strArtist: detailAlbum.strArtist || album.strArtist,
        strAlbumThumb: detailAlbum.strAlbumThumb || album.strAlbumThumb,
        strAlbumCDart: detailAlbum.strAlbumCDart || album.strAlbumCDart,
        intYearReleased: detailAlbum.intYearReleased,
        strGenre: detailAlbum.strGenre,
        strDescriptionEN: detailAlbum.strDescriptionEN,
      };
    } catch (error) {
      logger.error(`Error getting TheAudioDB album info: ${error}`);
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
        // Test with a well-known artist
        const url = `${this.baseUrl}/${this.apiKey}/search.php?s=The Beatles`;
        const response = await fetch(url, {
          headers: {
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
