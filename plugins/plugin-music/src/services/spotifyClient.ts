import { logger } from "@elizaos/core";
import { Buffer } from "buffer";
import type {
  AudioFeatures,
  RecommendationRequest,
  TrackRecommendation,
} from "../types/audioFeatures";
import { retryWithBackoff } from "../utils/retry";

interface SpotifyToken {
  accessToken: string;
  expiresAt: number;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string };
  external_urls: { spotify: string };
  preview_url?: string;
  popularity: number;
}

interface SpotifyAudioFeatures {
  id: string;
  danceability: number;
  energy: number;
  key: number;
  loudness: number;
  mode: number;
  speechiness: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  valence: number;
  tempo: number;
  duration_ms: number;
  time_signature: number;
}

/**
 * Client for Spotify Web API
 * Provides access to audio features and track recommendations
 */
export class SpotifyClient {
  private clientId: string | null = null;
  private clientSecret: string | null = null;
  private token: SpotifyToken | null = null;
  private baseUrl = "https://api.spotify.com/v1";
  private authUrl = "https://accounts.spotify.com/api/token";

  // Rate limiting: 180 requests per minute for web API
  private lastRequestTime = 0;
  private minRequestInterval = 334; // ~180 requests per minute

  constructor(clientId?: string, clientSecret?: string) {
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
  }

  /**
   * Check if API credentials are configured
   */
  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Get or refresh access token
   */
  private async getAccessToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      return null;
    }

    // Check if current token is still valid
    if (this.token && this.token.expiresAt > Date.now()) {
      return this.token.accessToken;
    }

    try {
      const response = await fetch(this.authUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
      });

      if (!response.ok) {
        logger.warn(
          `Failed to get Spotify access token: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };

      this.token = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000 - 60000, // Refresh 1 minute early
      };

      return this.token.accessToken;
    } catch (error) {
      logger.error(`Error getting Spotify access token: ${error}`);
      return null;
    }
  }

  /**
   * Rate limiting helper
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
   * Search for a track on Spotify
   */
  async searchTrack(query: string): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return null;
    }

    await this.rateLimit();

    return retryWithBackoff(async () => {
      const encodedQuery = encodeURIComponent(query);
      const response = await fetch(
        `${this.baseUrl}/search?q=${encodedQuery}&type=track&limit=1`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        if (response.status === 401) {
          // Token expired, clear it
          this.token = null;
          throw new Error("Spotify token expired");
        }
        throw new Error(
          `Spotify search failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        tracks: { items: SpotifyTrack[] };
      };

      if (data.tracks.items.length === 0) {
        return null;
      }

      return data.tracks.items[0].id;
    });
  }

  /**
   * Get audio features for a track
   */
  async getAudioFeatures(trackId: string): Promise<AudioFeatures | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return null;
    }

    await this.rateLimit();

    return retryWithBackoff(async () => {
      const response = await fetch(
        `${this.baseUrl}/audio-features/${trackId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        if (response.status === 401) {
          this.token = null;
          throw new Error("Spotify token expired");
        }
        if (response.status === 404) {
          return null;
        }
        throw new Error(
          `Spotify audio features request failed: ${response.status}`,
        );
      }

      const data = (await response.json()) as SpotifyAudioFeatures;

      return {
        trackId: data.id,
        danceability: data.danceability,
        energy: data.energy,
        valence: data.valence,
        acousticness: data.acousticness,
        instrumentalness: data.instrumentalness,
        liveness: data.liveness,
        speechiness: data.speechiness,
        key: data.key,
        mode: data.mode,
        tempo: data.tempo,
        timeSignature: data.time_signature,
        loudness: data.loudness,
        duration: data.duration_ms,
        source: "spotify",
      };
    });
  }

  /**
   * Get audio features for a track by search query
   */
  async getAudioFeaturesByQuery(query: string): Promise<AudioFeatures | null> {
    const trackId = await this.searchTrack(query);
    if (!trackId) {
      return null;
    }

    return this.getAudioFeatures(trackId);
  }

  /**
   * Get track recommendations
   */
  async getRecommendations(
    request: RecommendationRequest,
  ): Promise<TrackRecommendation[]> {
    if (!this.isConfigured()) {
      return [];
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return [];
    }

    // Build query parameters
    const params = new URLSearchParams();

    // Seeds (combined must be <= 5)
    if (request.seedArtists && request.seedArtists.length > 0) {
      params.append("seed_artists", request.seedArtists.slice(0, 5).join(","));
    }
    if (request.seedTracks && request.seedTracks.length > 0) {
      params.append("seed_tracks", request.seedTracks.slice(0, 5).join(","));
    }
    if (request.seedGenres && request.seedGenres.length > 0) {
      params.append("seed_genres", request.seedGenres.slice(0, 5).join(","));
    }

    // Audio feature targets
    if (request.audioFeatures) {
      const features = request.audioFeatures;
      if (features.targetDanceability !== undefined) {
        params.append(
          "target_danceability",
          features.targetDanceability.toString(),
        );
      }
      if (features.targetEnergy !== undefined) {
        params.append("target_energy", features.targetEnergy.toString());
      }
      if (features.targetValence !== undefined) {
        params.append("target_valence", features.targetValence.toString());
      }
      if (features.targetTempo !== undefined) {
        params.append("target_tempo", features.targetTempo.toString());
      }
      if (features.targetLoudness !== undefined) {
        params.append("target_loudness", features.targetLoudness.toString());
      }
      if (features.targetAcousticness !== undefined) {
        params.append(
          "target_acousticness",
          features.targetAcousticness.toString(),
        );
      }
      if (features.targetInstrumentalness !== undefined) {
        params.append(
          "target_instrumentalness",
          features.targetInstrumentalness.toString(),
        );
      }
      if (features.targetPopularity !== undefined) {
        params.append(
          "target_popularity",
          features.targetPopularity.toString(),
        );
      }
    }

    // Limit
    params.append("limit", (request.limit || 20).toString());

    await this.rateLimit();

    return retryWithBackoff(
      async () => {
        const response = await fetch(
          `${this.baseUrl}/recommendations?${params.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        if (!response.ok) {
          if (response.status === 401) {
            this.token = null;
            throw new Error("Spotify token expired");
          }
          throw new Error(
            `Spotify recommendations request failed: ${response.status}`,
          );
        }

        const data = (await response.json()) as { tracks: SpotifyTrack[] };

        return data.tracks.map((track) => ({
          trackName: track.name,
          artistName: track.artists.map((a) => a.name).join(", "),
          albumName: track.album.name,
          url: track.external_urls.spotify,
          previewUrl: track.preview_url,
          popularity: track.popularity,
        }));
      },
      {
        maxRetries: 2, // Fewer retries for recommendations
      },
    );
  }

  /**
   * Validate API credentials
   */
  async validateCredentials(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    const token = await this.getAccessToken();
    return token !== null;
  }
}
