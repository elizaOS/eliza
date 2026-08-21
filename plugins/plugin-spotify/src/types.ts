/**
 * Typed contracts for the Spotify integration: account references, normalized
 * Web API DTOs (tracks, playlists, devices, playback state, paged results),
 * and the closed set of domain error codes every boundary maps Spotify's HTTP
 * failures onto. Consumers branch on `SpotifyErrorCode`, never on raw status
 * codes or upstream prose.
 */

/** All operations are account-scoped; local mode uses {@link LOCAL_ACCOUNT_ID}. */
export interface SpotifyAccountRef {
  accountId: string;
}

/** Synthetic account id used when credentials come from local env settings. */
export const LOCAL_ACCOUNT_ID = "local";

export const SPOTIFY_SERVICE_NAME = "spotify";

export type SpotifyErrorCode =
  | "SPOTIFY_CONFIG_MISSING"
  | "SPOTIFY_AUTH_REQUIRED"
  | "SPOTIFY_AUTH_REVOKED"
  | "SPOTIFY_SCOPE_INSUFFICIENT"
  | "SPOTIFY_PREMIUM_REQUIRED"
  | "SPOTIFY_NO_ACTIVE_DEVICE"
  | "SPOTIFY_RATE_LIMITED"
  | "SPOTIFY_NOT_FOUND"
  | "SPOTIFY_INVALID_INPUT"
  | "SPOTIFY_UPSTREAM_INVALID"
  | "SPOTIFY_UPSTREAM_FAILED";

export interface SpotifyArtist {
  id: string;
  name: string;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: SpotifyArtist[];
  album: string;
  durationMs: number;
  explicit: boolean;
}

export interface SpotifyPlaylistSummary {
  id: string;
  uri: string;
  name: string;
  description: string | null;
  trackCount: number;
  public: boolean | null;
  ownerId: string;
}

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  progressMs: number | null;
  device: SpotifyDevice | null;
  track: SpotifyTrack | null;
  shuffle: boolean;
  repeat: "off" | "track" | "context";
}

/** Offset-paged result; `nextOffset` is null on the last page. */
export interface SpotifyPage<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}

export type SpotifySearchType = "track" | "album" | "artist" | "playlist";

export interface SpotifySearchResult {
  tracks: SpotifyTrack[];
  playlists: SpotifyPlaylistSummary[];
}

export interface SpotifyProfile {
  id: string;
  displayName: string | null;
  email: string | null;
  /** "premium" | "free" | "open" per Spotify; playback writes need premium. */
  product: string | null;
  country: string | null;
}

export interface SpotifyTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  scope: string;
}

/** Receipt returned by write actions so replies can echo the exact mutation. */
export interface SpotifyWriteReceipt {
  operation: string;
  target: string;
  detail: string;
}
