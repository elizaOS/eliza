/**
 * Spotify Web API client: a thin fetch wrapper that owns bearer auth, the
 * single-retry 401 refresh loop, and the mapping from Spotify's HTTP failure
 * vocabulary to the plugin's typed `SpotifyErrorCode`s (403 premium/scope,
 * 404 device, 429 Retry-After, malformed payloads). All response parsing
 * validates shape before returning a DTO — an unexpected upstream body throws
 * `SPOTIFY_UPSTREAM_INVALID` rather than leaking a healthy-looking default.
 *
 * The client is transport-injected (fetch + access-token provider) so tests
 * exercise the real request/parse/error contract against protocol-faithful
 * mock responses.
 */
import { ElizaError } from "@elizaos/core";
import { SPOTIFY_API_BASE } from "./auth";
import type {
  SpotifyArtist,
  SpotifyDevice,
  SpotifyPage,
  SpotifyPlaybackState,
  SpotifyPlaylistSummary,
  SpotifyProfile,
  SpotifySearchResult,
  SpotifySearchType,
  SpotifyTrack,
} from "./types";

/** Maximum time allowed for one Spotify Web API request. */
export const SPOTIFY_API_FETCH_TIMEOUT_MS = 15_000;

/** Supplies a bearer token; `forceRefresh` bypasses any cache after a 401. */
export type SpotifyAccessTokenProvider = (options: { forceRefresh: boolean }) => Promise<string>;

export interface SpotifyApiClientOptions {
  getAccessToken: SpotifyAccessTokenProvider;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new ElizaError(`Spotify payload field "${field}" is missing or not a string.`, {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { field, valueType: typeof value },
    });
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseArtist(value: unknown): SpotifyArtist {
  if (!isRecord(value)) {
    throw new ElizaError("Spotify artist payload is not an object.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { valueType: typeof value },
    });
  }
  return {
    id: requireString(value.id, "artist.id"),
    name: requireString(value.name, "artist.name"),
  };
}

export function parseTrack(value: unknown): SpotifyTrack {
  if (!isRecord(value)) {
    throw new ElizaError("Spotify track payload is not an object.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { valueType: typeof value },
    });
  }
  const album = isRecord(value.album) ? optionalString(value.album.name) : null;
  const durationMs = value.duration_ms;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    throw new ElizaError("Spotify track payload has an invalid duration_ms.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { valueType: typeof durationMs },
    });
  }
  return {
    id: requireString(value.id, "track.id"),
    uri: requireString(value.uri, "track.uri"),
    name: requireString(value.name, "track.name"),
    artists: Array.isArray(value.artists) ? value.artists.map(parseArtist) : [],
    album: album ?? "",
    durationMs,
    explicit: value.explicit === true,
  };
}

export function parsePlaylist(value: unknown): SpotifyPlaylistSummary {
  if (!isRecord(value)) {
    throw new ElizaError("Spotify playlist payload is not an object.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { valueType: typeof value },
    });
  }
  const tracks = isRecord(value.tracks) ? value.tracks : {};
  const owner = isRecord(value.owner) ? value.owner : {};
  const total = tracks.total;
  return {
    id: requireString(value.id, "playlist.id"),
    uri: requireString(value.uri, "playlist.uri"),
    name: requireString(value.name, "playlist.name"),
    description: optionalString(value.description),
    trackCount: typeof total === "number" && Number.isFinite(total) ? total : 0,
    public: typeof value.public === "boolean" ? value.public : null,
    ownerId: requireString(owner.id, "playlist.owner.id"),
  };
}

function parseDevice(value: unknown): SpotifyDevice {
  if (!isRecord(value)) {
    throw new ElizaError("Spotify device payload is not an object.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { valueType: typeof value },
    });
  }
  return {
    id: optionalString(value.id),
    name: requireString(value.name, "device.name"),
    type: requireString(value.type, "device.type"),
    isActive: value.is_active === true,
    isRestricted: value.is_restricted === true,
    volumePercent:
      typeof value.volume_percent === "number" && Number.isFinite(value.volume_percent)
        ? value.volume_percent
        : null,
  };
}

function parsePage<T>(value: unknown, parseItem: (item: unknown) => T): SpotifyPage<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new ElizaError("Spotify paged payload is missing an items array.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { valueType: typeof value },
    });
  }
  const total = typeof value.total === "number" && Number.isFinite(value.total) ? value.total : 0;
  const offset =
    typeof value.offset === "number" && Number.isFinite(value.offset) ? value.offset : 0;
  const hasNext = typeof value.next === "string" && value.next.length > 0;
  return {
    items: value.items.map(parseItem),
    total,
    nextOffset: hasNext ? offset + value.items.length : null,
  };
}

function upstreamMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (!isRecord(error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

function upstreamReason(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (!isRecord(error)) return undefined;
  return typeof error.reason === "string" ? error.reason : undefined;
}

export class SpotifyApiClient {
  private readonly getAccessToken: SpotifyAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(options: SpotifyApiClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiBase = options.apiBase ?? SPOTIFY_API_BASE;
    this.timeoutMs = options.timeoutMs ?? SPOTIFY_API_FETCH_TIMEOUT_MS;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    return this.requestWithAuth(path, options, false);
  }

  private async requestWithAuth(
    path: string,
    options: RequestOptions,
    isRetry: boolean
  ): Promise<unknown> {
    const token = await this.getAccessToken({ forceRefresh: isRetry });
    const url = new URL(`${this.apiBase}/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // error-policy:J2 wrap the transport failure with a typed domain error.
      throw new ElizaError("Spotify Web API request failed to complete.", {
        code: "SPOTIFY_UPSTREAM_FAILED",
        context: { path, method: options.method ?? "GET" },
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    if (response.status === 401 && !isRetry) {
      return this.requestWithAuth(path, options, true);
    }
    if (response.status === 204) {
      return undefined;
    }

    const rawBody = await response.text();
    let body: unknown;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch (error) {
        if (response.ok) {
          // error-policy:J2 a 2xx with unparseable JSON is a protocol violation.
          throw new ElizaError("Spotify Web API returned unparseable JSON.", {
            code: "SPOTIFY_UPSTREAM_INVALID",
            context: { path, status: response.status },
            cause: error instanceof Error ? error : new Error(String(error)),
          });
        }
        body = undefined;
      }
    }

    if (!response.ok) {
      throw this.errorForStatus(response, body, path);
    }
    return body;
  }

  private errorForStatus(response: Response, body: unknown, path: string): ElizaError {
    const status = response.status;
    const message = upstreamMessage(body);
    const reason = upstreamReason(body);
    if (status === 401) {
      return new ElizaError("Spotify authorization is no longer valid.", {
        code: "SPOTIFY_AUTH_REVOKED",
        context: { path, status },
        severity: "fatal",
      });
    }
    if (status === 403) {
      if (reason === "PREMIUM_REQUIRED" || message?.toLowerCase().includes("premium")) {
        return new ElizaError("Spotify playback control requires a Premium subscription.", {
          code: "SPOTIFY_PREMIUM_REQUIRED",
          context: { path, status },
        });
      }
      return new ElizaError("The connected Spotify account has not granted this permission.", {
        code: "SPOTIFY_SCOPE_INSUFFICIENT",
        context: { path, status, reason: reason ?? null },
      });
    }
    if (status === 404) {
      if (reason === "NO_ACTIVE_DEVICE" || message?.toLowerCase().includes("no active device")) {
        return new ElizaError("No active Spotify playback device is available.", {
          code: "SPOTIFY_NO_ACTIVE_DEVICE",
          context: { path, status },
        });
      }
      return new ElizaError("The requested Spotify resource was not found.", {
        code: "SPOTIFY_NOT_FOUND",
        context: { path, status },
      });
    }
    if (status === 429) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : Number.NaN;
      return new ElizaError("Spotify rate limit reached; retry later.", {
        code: "SPOTIFY_RATE_LIMITED",
        context: {
          path,
          status,
          retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        },
      });
    }
    return new ElizaError(`Spotify Web API failed with ${status}.`, {
      code: "SPOTIFY_UPSTREAM_FAILED",
      context: { path, status, message: message ?? null },
    });
  }

  async getProfile(): Promise<SpotifyProfile> {
    const body = await this.request("/me");
    if (!isRecord(body)) {
      throw new ElizaError("Spotify profile payload is not an object.", {
        code: "SPOTIFY_UPSTREAM_INVALID",
        context: { valueType: typeof body },
      });
    }
    return {
      id: requireString(body.id, "me.id"),
      displayName: optionalString(body.display_name),
      email: optionalString(body.email),
      product: optionalString(body.product),
      country: optionalString(body.country),
    };
  }

  async search(
    query: string,
    types: SpotifySearchType[],
    options: { limit?: number; offset?: number } = {}
  ): Promise<SpotifySearchResult> {
    if (!query.trim()) {
      throw new ElizaError("Spotify search requires a non-empty query.", {
        code: "SPOTIFY_INVALID_INPUT",
        context: { query },
      });
    }
    const body = await this.request("/search", {
      query: {
        q: query,
        type: types.join(","),
        limit: options.limit ?? 10,
        offset: options.offset ?? 0,
      },
    });
    const record = isRecord(body) ? body : {};
    const tracks = isRecord(record.tracks) ? parsePage(record.tracks, parseTrack).items : [];
    // Spotify search pages may contain null placeholder entries for playlists.
    const playlists = isRecord(record.playlists)
      ? parsePage(record.playlists, (item) => item)
          .items.filter((item) => item !== null && item !== undefined)
          .map(parsePlaylist)
      : [];
    return { tracks, playlists };
  }

  async listSavedTracks(
    options: { limit?: number; offset?: number } = {}
  ): Promise<SpotifyPage<SpotifyTrack>> {
    const body = await this.request("/me/tracks", {
      query: { limit: options.limit ?? 20, offset: options.offset ?? 0 },
    });
    return parsePage(body, (item) => {
      if (!isRecord(item)) {
        throw new ElizaError("Spotify saved-track entry is not an object.", {
          code: "SPOTIFY_UPSTREAM_INVALID",
          context: { valueType: typeof item },
        });
      }
      return parseTrack(item.track);
    });
  }

  async saveTracks(trackIds: string[]): Promise<void> {
    this.requireIds(trackIds, "trackIds");
    await this.request("/me/tracks", { method: "PUT", body: { ids: trackIds } });
  }

  async removeSavedTracks(trackIds: string[]): Promise<void> {
    this.requireIds(trackIds, "trackIds");
    await this.request("/me/tracks", { method: "DELETE", body: { ids: trackIds } });
  }

  async listPlaylists(
    options: { limit?: number; offset?: number } = {}
  ): Promise<SpotifyPage<SpotifyPlaylistSummary>> {
    const body = await this.request("/me/playlists", {
      query: { limit: options.limit ?? 20, offset: options.offset ?? 0 },
    });
    return parsePage(body, parsePlaylist);
  }

  async createPlaylist(
    userId: string,
    args: { name: string; description?: string; isPublic?: boolean }
  ): Promise<SpotifyPlaylistSummary> {
    if (!args.name.trim()) {
      throw new ElizaError("Spotify playlist creation requires a non-empty name.", {
        code: "SPOTIFY_INVALID_INPUT",
        context: { name: args.name },
      });
    }
    const body = await this.request(`/users/${encodeURIComponent(userId)}/playlists`, {
      method: "POST",
      body: {
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        public: args.isPublic ?? false,
      },
    });
    return parsePlaylist(body);
  }

  async addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
    this.requireIds(trackUris, "trackUris");
    await this.request(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: "POST",
      body: { uris: trackUris },
    });
  }

  async listDevices(): Promise<SpotifyDevice[]> {
    const body = await this.request("/me/player/devices");
    if (!isRecord(body) || !Array.isArray(body.devices)) {
      throw new ElizaError("Spotify devices payload is missing a devices array.", {
        code: "SPOTIFY_UPSTREAM_INVALID",
        context: { valueType: typeof body },
      });
    }
    return body.devices.map(parseDevice);
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
    const body = await this.request("/me/player");
    // A 204 (no active session anywhere) is a designed-empty state, not an error.
    if (body === undefined) return null;
    if (!isRecord(body)) {
      throw new ElizaError("Spotify playback-state payload is not an object.", {
        code: "SPOTIFY_UPSTREAM_INVALID",
        context: { valueType: typeof body },
      });
    }
    const repeatRaw = body.repeat_state;
    const repeat = repeatRaw === "track" || repeatRaw === "context" ? repeatRaw : "off";
    return {
      isPlaying: body.is_playing === true,
      progressMs:
        typeof body.progress_ms === "number" && Number.isFinite(body.progress_ms)
          ? body.progress_ms
          : null,
      device: isRecord(body.device) ? parseDevice(body.device) : null,
      track: isRecord(body.item) ? parseTrack(body.item) : null,
      shuffle: body.shuffle_state === true,
      repeat,
    };
  }

  async play(
    options: { deviceId?: string; contextUri?: string; trackUris?: string[] } = {}
  ): Promise<void> {
    await this.request("/me/player/play", {
      method: "PUT",
      query: options.deviceId ? { device_id: options.deviceId } : undefined,
      body:
        options.contextUri || options.trackUris
          ? {
              ...(options.contextUri ? { context_uri: options.contextUri } : {}),
              ...(options.trackUris ? { uris: options.trackUris } : {}),
            }
          : {},
    });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.request("/me/player/pause", {
      method: "PUT",
      query: deviceId ? { device_id: deviceId } : undefined,
      body: {},
    });
  }

  async nextTrack(deviceId?: string): Promise<void> {
    await this.request("/me/player/next", {
      method: "POST",
      query: deviceId ? { device_id: deviceId } : undefined,
      body: {},
    });
  }

  async previousTrack(deviceId?: string): Promise<void> {
    await this.request("/me/player/previous", {
      method: "POST",
      query: deviceId ? { device_id: deviceId } : undefined,
      body: {},
    });
  }

  async transferPlayback(deviceId: string, options: { play?: boolean } = {}): Promise<void> {
    if (!deviceId.trim()) {
      throw new ElizaError("Spotify device handoff requires a device id.", {
        code: "SPOTIFY_INVALID_INPUT",
        context: { deviceId },
      });
    }
    await this.request("/me/player", {
      method: "PUT",
      body: { device_ids: [deviceId], play: options.play ?? true },
    });
  }

  private requireIds(ids: string[], field: string): void {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !id?.trim())) {
      throw new ElizaError(`Spotify request requires a non-empty ${field} list.`, {
        code: "SPOTIFY_INVALID_INPUT",
        context: { field, count: Array.isArray(ids) ? ids.length : null },
      });
    }
  }
}
