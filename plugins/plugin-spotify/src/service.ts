/**
 * Runtime service for the Spotify integration. Owns per-account access-token
 * resolution across both credential modes — managed connector accounts whose
 * tokens live behind vault refs, and self-hosted local mode driven by
 * SPOTIFY_* settings — and exposes the account-scoped music domain surface
 * (search, saved-track library, playlists, playback, and device handoff) that
 * the plugin's actions call.
 *
 * Access tokens are cached in-process per account and refreshed once on
 * expiry or a 401; a refresh that fails with `invalid_grant` marks the grant
 * revoked and surfaces `SPOTIFY_AUTH_REVOKED` instead of retry-looping.
 * Refreshed managed tokens are written back through the durable credential
 * store so a restart does not resurrect the pre-refresh token.
 */
import {
  type ConnectorAccountManager,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import { hasLocalConfig, readLocalConfig, refreshAccessToken } from "./auth";
import { SpotifyApiClient } from "./client";
import {
  credentialRefRecordsFromMetadata,
  persistSpotifyCredentialRefs,
  readCredentialValue,
} from "./credential-refs";
import {
  LOCAL_ACCOUNT_ID,
  SPOTIFY_SERVICE_NAME,
  type SpotifyAccountRef,
  type SpotifyDevice,
  type SpotifyPage,
  type SpotifyPlaybackState,
  type SpotifyPlaylistSummary,
  type SpotifyProfile,
  type SpotifySearchResult,
  type SpotifySearchType,
  type SpotifyTokens,
  type SpotifyTrack,
} from "./types";

const OAUTH_TOKENS_CREDENTIAL_TYPE = "oauth.tokens";
/** Refresh this many ms before the recorded expiry to absorb clock skew. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export interface SpotifyServiceOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

interface StoredOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
}

function parseStoredTokens(raw: string): StoredOAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J2 a corrupt credential blob is a fatal integrity failure.
    throw new ElizaError("Stored Spotify OAuth credential is not valid JSON.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const accessToken = typeof record?.access_token === "string" ? record.access_token : "";
  if (!accessToken) {
    throw new ElizaError("Stored Spotify OAuth credential is missing an access token.", {
      code: "SPOTIFY_AUTH_REQUIRED",
      severity: "fatal",
    });
  }
  return {
    access_token: accessToken,
    ...(typeof record?.refresh_token === "string" && record.refresh_token
      ? { refresh_token: record.refresh_token }
      : {}),
    ...(typeof record?.expiry_date === "number" ? { expiry_date: record.expiry_date } : {}),
    ...(typeof record?.scope === "string" ? { scope: record.scope } : {}),
  };
}

export class SpotifyService extends Service {
  static override serviceType = SPOTIFY_SERVICE_NAME;
  capabilityDescription =
    "Spotify music: search, saved-track library, playlists, playback control, and device handoff";

  private readonly fetchImpl: typeof fetch;
  private readonly apiBase?: string;
  private readonly tokenCache = new Map<string, SpotifyTokens>();
  private readonly clientCache = new Map<string, SpotifyApiClient>();
  private readonly profileCache = new Map<string, SpotifyProfile>();

  constructor(runtime?: IAgentRuntime, options: SpotifyServiceOptions = {}) {
    super(runtime);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (options.apiBase !== undefined) this.apiBase = options.apiBase;
  }

  static override async start(runtime: IAgentRuntime): Promise<SpotifyService> {
    return new SpotifyService(runtime);
  }

  async stop(): Promise<void> {
    this.tokenCache.clear();
    this.clientCache.clear();
    this.profileCache.clear();
  }

  /** Removes cached tokens for an account after disconnect/revoke. */
  invalidateAccount(accountId: string): void {
    this.tokenCache.delete(accountId);
    this.clientCache.delete(accountId);
    this.profileCache.delete(accountId);
  }

  /**
   * Picks the account actions run against: an explicit id wins, otherwise the
   * first connected managed account, otherwise local mode when configured.
   */
  async resolveAccountId(explicit?: string): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    const runtime = this.requireRuntime();
    const manager = this.tryGetManager(runtime);
    if (manager) {
      const accounts = await manager.listAccounts(SPOTIFY_SERVICE_NAME);
      const connected = accounts.find((account) => account.status === "connected");
      if (connected) return connected.id;
    }
    if (hasLocalConfig(runtime)) return LOCAL_ACCOUNT_ID;
    throw new ElizaError(
      "No Spotify account is connected. Connect one via OAuth or configure SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN.",
      { code: "SPOTIFY_AUTH_REQUIRED", severity: "fatal" }
    );
  }

  getClient(ref: SpotifyAccountRef): SpotifyApiClient {
    const cached = this.clientCache.get(ref.accountId);
    if (cached) return cached;
    const client = new SpotifyApiClient({
      getAccessToken: ({ forceRefresh }) => this.getAccessToken(ref.accountId, forceRefresh),
      fetchImpl: this.fetchImpl,
      ...(this.apiBase !== undefined ? { apiBase: this.apiBase } : {}),
    });
    this.clientCache.set(ref.accountId, client);
    return client;
  }

  private async getAccessToken(accountId: string, forceRefresh: boolean): Promise<string> {
    const cached = this.tokenCache.get(accountId);
    if (!forceRefresh && cached && cached.expiresAt - TOKEN_EXPIRY_SLACK_MS > Date.now()) {
      return cached.accessToken;
    }
    const tokens =
      accountId === LOCAL_ACCOUNT_ID
        ? await this.refreshLocalTokens()
        : await this.resolveManagedTokens(accountId, forceRefresh, cached);
    this.tokenCache.set(accountId, tokens);
    return tokens.accessToken;
  }

  private async refreshLocalTokens(): Promise<SpotifyTokens> {
    const runtime = this.requireRuntime();
    const config = readLocalConfig(runtime);
    return refreshAccessToken(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: config.refreshToken,
      },
      this.fetchImpl
    );
  }

  private async resolveManagedTokens(
    accountId: string,
    forceRefresh: boolean,
    cached: SpotifyTokens | undefined
  ): Promise<SpotifyTokens> {
    const runtime = this.requireRuntime();
    const manager = this.tryGetManager(runtime);
    if (!manager) {
      throw new ElizaError("Connector account manager is unavailable for Spotify.", {
        code: "SPOTIFY_AUTH_REQUIRED",
        context: { accountId },
        severity: "fatal",
      });
    }
    const account = await manager.getAccount(SPOTIFY_SERVICE_NAME, accountId);
    if (!account) {
      throw new ElizaError("Spotify account is not connected.", {
        code: "SPOTIFY_AUTH_REQUIRED",
        context: { accountId },
        severity: "fatal",
      });
    }
    if (account.status === "revoked" || account.status === "disabled") {
      throw new ElizaError("Spotify account access has been revoked or disabled.", {
        code: "SPOTIFY_AUTH_REVOKED",
        context: { accountId, status: account.status },
        severity: "fatal",
      });
    }
    const refs = credentialRefRecordsFromMetadata(account.metadata);
    const tokenRef = refs.find((ref) => ref.credentialType === OAUTH_TOKENS_CREDENTIAL_TYPE);
    if (!tokenRef?.vaultRef) {
      throw new ElizaError("Spotify account has no stored OAuth credential.", {
        code: "SPOTIFY_AUTH_REQUIRED",
        context: { accountId },
        severity: "fatal",
      });
    }
    const raw = await readCredentialValue(runtime, tokenRef.vaultRef);
    if (!raw) {
      throw new ElizaError("Spotify OAuth credential could not be read from the vault.", {
        code: "SPOTIFY_AUTH_REQUIRED",
        context: { accountId },
        severity: "fatal",
      });
    }
    const stored = parseStoredTokens(raw);
    const storedExpiresAt = stored.expiry_date ?? 0;
    const storedUsable = storedExpiresAt - TOKEN_EXPIRY_SLACK_MS > Date.now();
    const staleAfter401 = forceRefresh && cached?.accessToken === stored.access_token;
    if (storedUsable && !staleAfter401) {
      return {
        accessToken: stored.access_token,
        ...(stored.refresh_token ? { refreshToken: stored.refresh_token } : {}),
        expiresAt: storedExpiresAt,
        scope: stored.scope ?? "",
      };
    }
    if (!stored.refresh_token) {
      throw new ElizaError("Spotify access token expired and no refresh token is stored.", {
        code: "SPOTIFY_AUTH_REVOKED",
        context: { accountId },
        severity: "fatal",
      });
    }
    const clientId = this.readSetting("SPOTIFY_CLIENT_ID");
    if (!clientId) {
      throw new ElizaError(
        "Spotify token refresh requires SPOTIFY_CLIENT_ID (and SPOTIFY_CLIENT_SECRET for non-PKCE apps).",
        { code: "SPOTIFY_CONFIG_MISSING", context: { accountId }, severity: "fatal" }
      );
    }
    const clientSecret = this.readSetting("SPOTIFY_CLIENT_SECRET");
    const refreshed = await refreshAccessToken(
      {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        refreshToken: stored.refresh_token,
      },
      this.fetchImpl
    );
    await this.persistRefreshedTokens(manager, accountId, refreshed);
    return refreshed;
  }

  private async persistRefreshedTokens(
    manager: ConnectorAccountManager,
    accountId: string,
    tokens: SpotifyTokens
  ): Promise<void> {
    const runtime = this.requireRuntime();
    try {
      await persistSpotifyCredentialRefs({
        runtime,
        manager,
        provider: SPOTIFY_SERVICE_NAME,
        accountId,
        caller: "plugin-spotify",
        credentials: [
          {
            credentialType: OAUTH_TOKENS_CREDENTIAL_TYPE,
            value: JSON.stringify({
              access_token: tokens.accessToken,
              ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
              expiry_date: tokens.expiresAt,
              scope: tokens.scope,
            }),
            expiresAt: tokens.expiresAt,
            metadata: { provider: SPOTIFY_SERVICE_NAME },
          },
        ],
      });
    } catch (error) {
      // error-policy:J7 the refreshed token still serves this request; a
      // persistence failure is reported so operators see the durable gap.
      runtime.reportError?.(
        "plugin-spotify:token-persist",
        error instanceof Error ? error : new Error(String(error)),
        { accountId }
      );
    }
  }

  private tryGetManager(runtime: IAgentRuntime): ConnectorAccountManager | undefined {
    try {
      return getConnectorAccountManager(runtime);
    } catch {
      // error-policy:J3 a runtime without connector support means "not available".
      return undefined;
    }
  }

  private readSetting(key: string): string | undefined {
    const value = this.requireRuntime().getSetting?.(key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private requireRuntime(): IAgentRuntime {
    if (!this.runtime) {
      throw new ElizaError("SpotifyService requires a runtime.", {
        code: "SPOTIFY_CONFIG_MISSING",
        severity: "fatal",
      });
    }
    return this.runtime;
  }

  async getProfile(ref: SpotifyAccountRef): Promise<SpotifyProfile> {
    const cached = this.profileCache.get(ref.accountId);
    if (cached) return cached;
    const profile = await this.getClient(ref).getProfile();
    this.profileCache.set(ref.accountId, profile);
    return profile;
  }

  async search(
    ref: SpotifyAccountRef,
    query: string,
    types: SpotifySearchType[] = ["track"],
    options: { limit?: number; offset?: number } = {}
  ): Promise<SpotifySearchResult> {
    return this.getClient(ref).search(query, types, options);
  }

  async listSavedTracks(
    ref: SpotifyAccountRef,
    options: { limit?: number; offset?: number } = {}
  ): Promise<SpotifyPage<SpotifyTrack>> {
    return this.getClient(ref).listSavedTracks(options);
  }

  async saveTracks(ref: SpotifyAccountRef, trackIds: string[]): Promise<void> {
    await this.getClient(ref).saveTracks(trackIds);
  }

  async removeSavedTracks(ref: SpotifyAccountRef, trackIds: string[]): Promise<void> {
    await this.getClient(ref).removeSavedTracks(trackIds);
  }

  async listPlaylists(
    ref: SpotifyAccountRef,
    options: { limit?: number; offset?: number } = {}
  ): Promise<SpotifyPage<SpotifyPlaylistSummary>> {
    return this.getClient(ref).listPlaylists(options);
  }

  async createPlaylist(
    ref: SpotifyAccountRef,
    args: { name: string; description?: string; isPublic?: boolean }
  ): Promise<SpotifyPlaylistSummary> {
    const profile = await this.getProfile(ref);
    return this.getClient(ref).createPlaylist(profile.id, args);
  }

  async addTracksToPlaylist(
    ref: SpotifyAccountRef,
    playlistId: string,
    trackUris: string[]
  ): Promise<void> {
    await this.getClient(ref).addTracksToPlaylist(playlistId, trackUris);
  }

  async listDevices(ref: SpotifyAccountRef): Promise<SpotifyDevice[]> {
    return this.getClient(ref).listDevices();
  }

  async getPlaybackState(ref: SpotifyAccountRef): Promise<SpotifyPlaybackState | null> {
    return this.getClient(ref).getPlaybackState();
  }

  async play(
    ref: SpotifyAccountRef,
    options: { deviceId?: string; contextUri?: string; trackUris?: string[] } = {}
  ): Promise<void> {
    await this.getClient(ref).play(options);
  }

  async pause(ref: SpotifyAccountRef, deviceId?: string): Promise<void> {
    await this.getClient(ref).pause(deviceId);
  }

  async nextTrack(ref: SpotifyAccountRef, deviceId?: string): Promise<void> {
    await this.getClient(ref).nextTrack(deviceId);
  }

  async previousTrack(ref: SpotifyAccountRef, deviceId?: string): Promise<void> {
    await this.getClient(ref).previousTrack(deviceId);
  }

  async transferPlayback(
    ref: SpotifyAccountRef,
    deviceId: string,
    options: { play?: boolean } = {}
  ): Promise<void> {
    await this.getClient(ref).transferPlayback(deviceId, options);
  }
}
